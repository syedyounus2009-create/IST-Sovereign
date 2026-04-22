import express    from 'express';
import cors       from 'cors';
import crypto     from 'crypto';
import jwt        from 'jsonwebtoken';
import fs         from 'fs';
import path       from 'path';
import bcrypt     from 'bcryptjs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/',               (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/admin.html',     (req,res) => res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/dashboard.html', (req,res) => res.sendFile(path.join(__dirname,'public','dashboard.html')));

// PERSISTENT DATABASE — uses Railway Volume at /data if available
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const DB_FILE  = path.join(DATA_DIR, 'ist_db.json');
console.log('Database:', DB_FILE);

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const empty = { users:[], keys:[], audit:[], payments:[] };
      fs.writeFileSync(DB_FILE, JSON.stringify(empty, null, 2));
      return empty;
    }
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!data.users)    data.users    = [];
    if (!data.keys)     data.keys     = [];
    if (!data.audit)    data.audit    = [];
    if (!data.payments) data.payments = [];
    return data;
  } catch(e) { return { users:[], keys:[], audit:[], payments:[] }; }
}

function saveDB(data) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }
  catch(e) { console.error('DB save:', e.message); }
}

function logAudit(action, keyCode, detail, ip) {
  try {
    const db = loadDB();
    db.audit.unshift({ id:Date.now(), action, keyCode:keyCode||null,
      detail:detail||null, ip:ip||null, timestamp:new Date().toISOString() });
    if (db.audit.length > 500) db.audit = db.audit.slice(0,500);
    saveDB(db);
  } catch(e) {}
}

// CONFIG — from Railway environment variables
const JWT_SECRET     = process.env.JWT_SECRET     || 'ist-sovereign-jwt-2026';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'IST-Admin-2026';
const VAR_A = parseFloat(process.env.VAR_A || '1.22');
const VAR_B = parseFloat(process.env.VAR_B || '1.618');
const VAR_C = parseFloat(process.env.VAR_C || '0.94');
const VAR_D = parseFloat(process.env.VAR_D || '0.82');

console.log('Admin password:', ADMIN_PASSWORD ? 'SET' : 'DEFAULT');

// OPTIONAL SERVICES
let mailer = null, razorpay = null;

async function initServices() {
  try {
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      const nm = (await import('nodemailer')).default;
      mailer = nm.createTransport({ service:'gmail',
        auth:{ user:process.env.EMAIL_USER, pass:process.env.EMAIL_PASS } });
      await mailer.verify();
      console.log('Email ready:', process.env.EMAIL_USER);
    } else { console.log('Email: not configured'); }
  } catch(e) { console.log('Email failed:', e.message); mailer = null; }

  try {
    const id = process.env.RAZORPAY_KEY_ID, sec = process.env.RAZORPAY_KEY_SECRET;
    if (id && sec && id.startsWith('rzp_')) {
      const RZP = (await import('razorpay')).default;
      razorpay = new RZP({ key_id:id, key_secret:sec });
      console.log('Razorpay ready:', id.substring(0,15)+'...');
    } else { console.log('Razorpay: not configured'); }
  } catch(e) { console.log('Razorpay failed:', e.message); razorpay = null; }
}

async function sendEmail(to, subject, html) {
  if (!mailer) { console.log('[Email skipped]', to, subject); return false; }
  try {
    await mailer.sendMail({ from:`"IST-Sovereign" <${process.env.EMAIL_USER}>`, to, subject, html });
    console.log('Email sent:', to);
    return true;
  } catch(e) { console.error('Email error:', e.message); return false; }
}

// ALL PLANS — Gold 1024-channel, difference = number of keys only
const PLANS = {
  TRIAL:        { days:7,  channels:1024, label:'Free Trial',    prefix:'ISTG', keys:1, price:0     },
  STARTER:      { days:30, channels:1024, label:'Starter',       prefix:'ISTG', keys:1, price:19900 },
  PROFESSIONAL: { days:30, channels:1024, label:'Professional',  prefix:'ISTG', keys:3, price:49900 },
  BUSINESS:     { days:30, channels:1024, label:'Business',      prefix:'ISTG', keys:8, price:99900 },
};

function makeKey(planId, userId, name, email) {
  const p = PLANS[planId]; if (!p) throw new Error('Invalid plan: '+planId);
  const r = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return {
    keyCode:`${p.prefix}-${r()}-${r()}-${r()}`, plan:planId, label:p.label,
    channels:p.channels, status:'PENDING', hardwareId:null, userId:userId||null,
    customerName:name||null, customerEmail:email||null,
    createdAt:new Date().toISOString(),
    expiresAt:new Date(Date.now()+p.days*86400000).toISOString(),
    activatedAt:null, lastSeen:null, notes:null
  };
}

function keyEmailHtml(keys, label, name) {
  const rows = keys.map((k,i) => `
    <div style="background:#f8f9fa;border:2px dashed #1a73e8;border-radius:8px;padding:16px;text-align:center;margin:10px 0">
      ${keys.length>1?`<div style="font-size:11px;color:#5f6368;margin-bottom:4px">KEY ${i+1} OF ${keys.length} — Device ${i+1}</div>`:''}
      <div style="font-family:monospace;font-size:22px;letter-spacing:3px;color:#1a73e8;font-weight:bold">${k.keyCode}</div>
      <div style="font-size:12px;color:#5f6368;margin-top:6px">Valid until ${new Date(k.expiresAt).toLocaleDateString('en-IN')}</div>
    </div>`).join('');
  return `<div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;padding:24px;border:1px solid #e0e0e0;border-radius:12px">
    <div style="text-align:center;margin-bottom:16px"><div style="font-size:22px;font-weight:bold;color:#1a73e8">IST-Sovereign</div></div>
    <h2 style="color:#202124;font-size:17px">Your ${label} Key${keys.length>1?'s are':' is'} Ready</h2>
    <p style="color:#5f6368;font-size:14px">Hello ${name||'there'}, thank you for choosing IST-Sovereign.</p>
    ${rows}
    <div style="background:#e8f5e9;border-radius:8px;padding:14px;margin-top:16px">
      <b style="font-size:13px;color:#2e7d32">How to activate:</b>
      <ol style="font-size:13px;color:#5f6368;margin:8px 0 0;padding-left:18px;line-height:2">
        <li>Download IST-Sovereign.exe from your dashboard</li>
        <li>Right-click → Run as Administrator</li>
        <li>Enter the key and press ACTIVATE</li>
        <li>Each key locks to one device on first use</li>
      </ol>
    </div>
    <div style="margin-top:16px;font-size:12px;color:#9aa0a6;text-align:center">
      IST-Sovereign | Hyderabad, India | ist.sovereign.support@gmail.com
    </div>
  </div>`;
}

// AUTH MIDDLEWARE
function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error:'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error:'Token invalid — please sign in again' }); }
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error:'No admin token' });
  try { jwt.verify(token, JWT_SECRET+'_admin'); next(); }
  catch { res.status(401).json({ error:'Admin token invalid' }); }
}

// USER ROUTES
app.post('/api/user/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name||!email||!password) return res.status(400).json({ error:'All fields required' });
  if (password.length<6) return res.status(400).json({ error:'Password min 6 characters' });
  const db = loadDB();
  if (db.users.find(u=>u.email.toLowerCase()===email.toLowerCase()))
    return res.status(400).json({ error:'Email already registered — please sign in' });
  const hashed = await bcrypt.hash(password, 10);
  const user = { id:crypto.randomUUID(), name, email:email.toLowerCase(),
    password:hashed, createdAt:new Date().toISOString() };
  db.users.push(user); saveDB(db);
  logAudit('USER_REGISTER', null, email, req.ip);
  await sendEmail(email, 'Welcome to IST-Sovereign', `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px">
      <h2 style="color:#1a73e8">Welcome, ${name}!</h2>
      <p>Your account is ready. Sign in to get your free 7-day trial key.</p>
      <p><a href="https://ist-sovereign-production.up.railway.app/dashboard.html"
         style="background:#1a73e8;color:white;padding:10px 24px;border-radius:6px;text-decoration:none">
         Go to Dashboard</a></p>
      <p style="color:#9aa0a6;font-size:12px">IST-Sovereign | ist.sovereign.support@gmail.com</p>
    </div>`);
  res.json({ success:true });
});

app.post('/api/user/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email||!password) return res.status(400).json({ error:'Email and password required' });
  const db = loadDB();
  const user = db.users.find(u=>u.email.toLowerCase()===email.toLowerCase());
  if (!user) return res.status(401).json({ error:'No account found for this email' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error:'Incorrect password' });
  const token = jwt.sign({ id:user.id, email:user.email, name:user.name }, JWT_SECRET, { expiresIn:'30d' });
  logAudit('USER_LOGIN', null, email, req.ip);
  res.json({ token, user:{ name:user.name, email:user.email } });
});

app.post('/api/user/forgot-password', async (req, res) => {
  const { email } = req.body;
  res.json({ success:true });
  if (!email) return;
  const db = loadDB();
  const user = db.users.find(u=>u.email.toLowerCase()===email.toLowerCase());
  if (!user) return;
  const token = crypto.randomBytes(32).toString('hex');
  user.resetToken = token;
  user.resetExpiry = new Date(Date.now()+3600000).toISOString();
  saveDB(db);
  await sendEmail(email, 'IST-Sovereign — Reset Password', `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px">
      <h2 style="color:#1a73e8">Password Reset</h2>
      <p>Click below — valid for 1 hour.</p>
      <p><a href="https://ist-sovereign-production.up.railway.app/reset.html?token=${token}"
         style="background:#1a73e8;color:white;padding:10px 24px;border-radius:6px;text-decoration:none">
         Reset Password</a></p>
    </div>`);
});

app.get('/api/user/dashboard', requireAuth, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u=>u.id===req.user.id);
  res.json({ user:{ name:user?.name, email:user?.email },
    keys:db.keys.filter(k=>k.userId===req.user.id) });
});

app.post('/api/user/trial', requireAuth, async (req, res) => {
  const db = loadDB();
  if (db.keys.find(k=>k.userId===req.user.id && k.plan==='TRIAL'))
    return res.status(400).json({ error:'Trial already used — please upgrade' });
  const user = db.users.find(u=>u.id===req.user.id);
  const k = makeKey('TRIAL', req.user.id, user?.name, req.user.email);
  db.keys.unshift(k); saveDB(db);
  logAudit('TRIAL_GENERATED', k.keyCode, req.user.email, req.ip);
  await sendEmail(req.user.email, 'Your IST-Sovereign Free Trial Key',
    keyEmailHtml([k], 'Free Trial', user?.name));
  res.json({ success:true, key:k });
});

// PAYMENT ROUTES
app.post('/api/payment/create-order', requireAuth, async (req, res) => {
  const { plan } = req.body;
  const p = PLANS[plan];
  if (!p || p.price===0) return res.status(400).json({ error:'Invalid plan' });
  if (!razorpay) return res.status(503).json({
    error:'Payment gateway not ready', fallback:true,
    contact:'WhatsApp +91 77022 49018 or email ist.sovereign.support@gmail.com' });
  try {
    const order = await razorpay.orders.create({
      amount:p.price, currency:'INR', receipt:`ist_${Date.now()}` });
    res.json({ orderId:order.id, amount:order.amount, currency:'INR', plan });
  } catch(e) { res.status(500).json({ error:e.message, fallback:true }); }
});

app.post('/api/payment/verify', requireAuth, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body;
  if (!process.env.RAZORPAY_KEY_SECRET) return res.status(503).json({ error:'Not configured' });
  const sig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
  if (sig !== razorpay_signature) return res.status(400).json({ error:'Payment verification failed' });
  const db = loadDB();
  const user = db.users.find(u=>u.id===req.user.id);
  const pi = PLANS[plan]; const keys = [];
  for (let i=0; i<pi.keys; i++) {
    const k = makeKey(plan, req.user.id, user?.name, req.user.email);
    db.keys.unshift(k); keys.push(k);
  }
  db.payments.push({ id:crypto.randomUUID(), userId:req.user.id, email:req.user.email,
    plan, amount:pi.price, keyCount:pi.keys, keys:keys.map(k=>k.keyCode),
    razorpayOrderId:razorpay_order_id, razorpayPaymentId:razorpay_payment_id,
    paidAt:new Date().toISOString() });
  saveDB(db);
  logAudit('PAYMENT_SUCCESS', keys[0].keyCode, `${plan} x${pi.keys} Rs.${pi.price/100}`, req.ip);
  await sendEmail(req.user.email, `Your IST-Sovereign ${pi.label} Keys`,
    keyEmailHtml(keys, pi.label, user?.name));
  res.json({ success:true, keys, keyCount:pi.keys, plan:pi.label });
});

// AGENT ROUTES
app.post('/api/activate', (req, res) => {
  const { keyCode, hardwareId } = req.body;
  if (!keyCode||!hardwareId) return res.status(400).json({ error:'Missing fields' });
  const db = loadDB();
  const key = db.keys.find(k=>k.keyCode===keyCode);
  if (!key) return res.status(404).json({ error:'Key not found' });
  if (key.status==='KILLED') return res.status(403).json({ error:'Key terminated — contact support' });
  if (new Date(key.expiresAt)<new Date()) return res.status(403).json({ error:'Key expired — please renew' });
  if (key.hardwareId && key.hardwareId!==hardwareId)
    return res.status(403).json({ error:'Hardware mismatch — key locked to another device' });
  if (!key.hardwareId) {
    key.hardwareId=hardwareId; key.status='ACTIVE';
    key.activatedAt=new Date().toISOString();
    logAudit('KEY_ACTIVATED', keyCode, `HW:${hardwareId.slice(0,12)}`, req.ip);
  }
  key.lastSeen=new Date().toISOString(); saveDB(db);
  res.json({ valid:true, plan:key.plan, tier:key.plan, channels:key.channels,
    label:key.label, expiresAt:key.expiresAt });
});

app.post('/api/process-signal', (req, res) => {
  const { keyCode, hardwareId, speed } = req.body;
  const db = loadDB();
  const key = db.keys.find(k=>k.keyCode===keyCode && k.hardwareId===hardwareId);
  if (!key||key.status!=='ACTIVE') return res.status(403).json({ error:'Unauthorized' });
  if (new Date(key.expiresAt)<new Date()) return res.status(403).json({ error:'Expired' });
  key.lastSeen=new Date().toISOString(); saveDB(db);
  const s=Math.max(1,Math.min(16,parseInt(speed)||1)), norm=(s-1)/15;
  res.json({ throughput:+((VAR_A*s*VAR_C).toFixed(2)),
    latencyReduction:+(Math.min(norm*VAR_B*100,85).toFixed(1)),
    energyEfficiency:+(Math.min((VAR_D+norm*0.15),0.97)*100).toFixed(1),
    channels:key.channels, speed:s });
});

// ADMIN ROUTES
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  console.log('Admin login | expected:', ADMIN_PASSWORD, '| got:', password);
  if (password !== ADMIN_PASSWORD)
    return res.status(403).json({ error:'Wrong admin password' });
  const token = jwt.sign({ role:'admin' }, JWT_SECRET+'_admin', { expiresIn:'12h' });
  logAudit('ADMIN_LOGIN', null, 'Admin in', req.ip);
  res.json({ token });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const db = loadDB(); const now = new Date();
  res.json({ totalKeys:db.keys.length, activeKeys:db.keys.filter(k=>k.status==='ACTIVE').length,
    trialKeys:db.keys.filter(k=>k.plan==='TRIAL').length,
    killedKeys:db.keys.filter(k=>k.status==='KILLED').length,
    expiredKeys:db.keys.filter(k=>k.status!=='KILLED'&&new Date(k.expiresAt)<now).length,
    totalUsers:db.users.length, totalRevenue:db.payments.reduce((s,p)=>s+(p.amount||0),0),
    recentAudit:db.audit.slice(0,20) });
});

app.get('/api/admin/keys',  requireAdmin, (req,res) => res.json({ keys:loadDB().keys }));
app.get('/api/admin/users', requireAdmin, (req,res) => res.json({
  users:loadDB().users.map(u=>({ id:u.id, name:u.name, email:u.email, createdAt:u.createdAt })) }));

app.post('/api/admin/generate-key', requireAdmin, async (req, res) => {
  const { plan='TRIAL', customerName, customerEmail, notes, count } = req.body;
  const pi = PLANS[plan]; if (!pi) return res.status(400).json({ error:'Invalid plan' });
  const n = Math.max(1, Math.min(100, parseInt(count)||pi.keys));
  const db = loadDB(); const keys = [];
  for (let i=0; i<n; i++) {
    const k = makeKey(plan, null, customerName, customerEmail);
    k.notes = notes||null; db.keys.unshift(k); keys.push(k);
  }
  saveDB(db);
  logAudit('ADMIN_KEY_GENERATED', keys[0].keyCode, `${plan} x${n} ${customerEmail||''}`, req.ip);
  if (customerEmail) await sendEmail(customerEmail,
    `Your IST-Sovereign ${pi.label} Keys`, keyEmailHtml(keys, pi.label, customerName));
  res.json({ success:true, keys, keyCount:n });
});

app.post('/api/admin/kill-key',   requireAdmin, (req,res) => {
  const db=loadDB(), k=db.keys.find(k=>k.keyCode===req.body.keyCode);
  if(k){k.status='KILLED';saveDB(db);} logAudit('KEY_KILLED',req.body.keyCode,'Admin kill',req.ip);
  res.json({success:true}); });

app.post('/api/admin/revive-key', requireAdmin, (req,res) => {
  const db=loadDB(), k=db.keys.find(k=>k.keyCode===req.body.keyCode);
  if(k){k.status='ACTIVE';saveDB(db);} logAudit('KEY_REVIVED',req.body.keyCode,'Admin revive',req.ip);
  res.json({success:true}); });

app.post('/api/admin/extend-key', requireAdmin, (req,res) => {
  const {keyCode,days}=req.body; const db=loadDB();
  const k=db.keys.find(k=>k.keyCode===keyCode);
  if(!k) return res.status(404).json({error:'Not found'});
  const base=new Date(k.expiresAt)>new Date()?new Date(k.expiresAt):new Date();
  k.expiresAt=new Date(base.getTime()+days*86400000).toISOString();
  saveDB(db); logAudit('KEY_EXTENDED',keyCode,`+${days}d`,req.ip);
  res.json({success:true,newExpiry:k.expiresAt}); });

app.get('/api/admin/audit', requireAdmin, (req,res) => res.json({log:loadDB().audit.slice(0,100)}));

app.get('/api/health', (req,res) => {
  const db=loadDB();
  res.json({ status:'ok', db:DB_FILE, users:db.users.length, keys:db.keys.length,
    payments:db.payments.length, email:!!mailer, razorpay:!!razorpay, time:new Date().toISOString() });
});

// START
const PORT = process.env.PORT || 3001;
initServices().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(50));
    console.log(`IST-Sovereign  PORT ${PORT}  DB:${DATA_DIR}`);
    console.log('='.repeat(50));
  });
}).catch(e => {
  console.error('Startup error:', e.message);
  app.listen(PORT, '0.0.0.0', () => console.log(`Running PORT ${PORT}`));
});

// Wrap your email sending in a try/catch so it never crashes the main signal
async function sendEmail(to, subject, text) {
  try {
    // Only attempt if credentials exist
    if (!process.env.EMAIL_USER) {
       console.log(`[Email skipped] ${to} - No Credentials`);
       return;
    }
    await transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, text });
    console.log(`✓ Email sent to ${to}`);
  } catch (err) {
    console.log(`⚠ Email Background Failure: ${err.message}`);
    // We do NOT throw the error here, so the API stays alive
  }
}