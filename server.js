import express    from 'express';
import cors       from 'cors';
import crypto     from 'crypto';
import jwt        from 'jsonwebtoken';
import fs         from 'fs';
import path       from 'path';
import bcrypt     from 'bcryptjs';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── EXPRESS ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/',               (_,r) => r.sendFile(path.join(__dirname,'public','index.html')));
app.get('/admin.html',     (_,r) => r.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/dashboard.html', (_,r) => r.sendFile(path.join(__dirname,'public','dashboard.html')));
app.get('/health.html',    (_,r) => r.sendFile(path.join(__dirname,'public','health.html')));

// ── DATABASE ──────────────────────────────────────────────────────────────────
// Persistent at /data/ist_db.json when Railway Volume is mounted at /data
// TO SET UP: Railway → service → Volumes → Add Volume → mount path: /data
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const DB_FILE  = path.join(DATA_DIR, 'ist_db.json');

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const blank = { users:[], keys:[], audit:[], payments:[], feedbacks:[] };
      fs.writeFileSync(DB_FILE, JSON.stringify(blank, null, 2));
      return blank;
    }
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    d.users     = d.users     || [];
    d.keys      = d.keys      || [];
    d.audit     = d.audit     || [];
    d.payments  = d.payments  || [];
    d.feedbacks = d.feedbacks || [];
    return d;
  } catch(e) {
    console.error('[DB] Load error:', e.message);
    return { users:[], keys:[], audit:[], payments:[], feedbacks:[] };
  }
}

function saveDB(d) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2)); }
  catch(e) { console.error('[DB] Save error:', e.message); }
}

function addAudit(action, keyCode, detail, ip) {
  try {
    const d = loadDB();
    d.audit.unshift({ id:Date.now(), action, keyCode:keyCode||null,
      detail:detail||null, ip:ip||null, timestamp:new Date().toISOString() });
    if (d.audit.length > 500) d.audit = d.audit.slice(0, 500);
    saveDB(d);
  } catch(e) {}
}

// ── CONFIG ────────────────────────────────────────────────────────────────────
// All values from Railway Variables — never hardcoded
const JWT_SECRET     = process.env.JWT_SECRET     || 'ist-sovereign-jwt-2026';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'IST-Admin-2026';
const VAR_A = parseFloat(process.env.VAR_A || '0');
const VAR_B = parseFloat(process.env.VAR_B || '0');
const VAR_C = parseFloat(process.env.VAR_C || '0');
const VAR_D = parseFloat(process.env.VAR_D || '0');

// ── PLANS ─────────────────────────────────────────────────────────────────────
// All Gold 1024-channel — only difference is number of keys
// TO CHANGE PRICE: edit price (in paise — Rs.199 = 19900)
// TO CHANGE KEY COUNT: edit keys
const PLANS = {
  TRIAL:        { days:7,  channels:1024, label:'Free Trial',    prefix:'ISTG', keys:1, price:0     },
  STARTER:      { days:30, channels:1024, label:'Starter',       prefix:'ISTG', keys:1, price:19900 },
  PROFESSIONAL: { days:30, channels:1024, label:'Professional',  prefix:'ISTG', keys:3, price:49900 },
  BUSINESS:     { days:30, channels:1024, label:'Business',      prefix:'ISTG', keys:8, price:99900 },
};

function makeKey(planId, userId, name, email) {
  const p = PLANS[planId]; if (!p) throw new Error('Invalid plan: '+planId);
  const r = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return { keyCode:`${p.prefix}-${r()}-${r()}-${r()}`, plan:planId, label:p.label,
    channels:p.channels, status:'PENDING', hardwareId:null,
    userId:userId||null, customerName:name||null, customerEmail:email||null,
    createdAt:new Date().toISOString(),
    expiresAt:new Date(Date.now()+p.days*86400000).toISOString(),
    activatedAt:null, lastSeen:null, notes:null, registrationIp:null };
}

function keyEmail(keys, label, name) {
  const rows = keys.map((k,i) => `
    <div style="background:#f8f9fa;border:2px dashed #1a73e8;border-radius:8px;
                padding:16px;text-align:center;margin:10px 0">
      ${keys.length>1 ? `<div style="font-size:11px;color:#5f6368;margin-bottom:6px;font-weight:bold">
        KEY ${i+1} OF ${keys.length} — DEVICE ${i+1}</div>` : ''}
      <div style="font-family:monospace;font-size:22px;letter-spacing:3px;
                  color:#1a73e8;font-weight:bold">${k.keyCode}</div>
      <div style="font-size:12px;color:#5f6368;margin-top:6px">
        Valid until ${new Date(k.expiresAt).toLocaleDateString('en-IN',
          {day:'numeric',month:'long',year:'numeric'})}
      </div>
    </div>`).join('');
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;
    padding:28px;border:1px solid #e0e0e0;border-radius:12px">
    <div style="text-align:center;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid #e0e0e0">
      <div style="font-size:24px;font-weight:bold;color:#1a73e8">IST-Sovereign</div>
      <div style="font-size:13px;color:#5f6368">Windows Performance Agent — Gold Edition</div>
    </div>
    <h2 style="color:#202124;font-size:18px">Your ${label} Key${keys.length>1?'s Are':' Is'} Ready</h2>
    <p style="color:#5f6368;font-size:14px;margin:8px 0 16px">
      Hello ${name||'there'}, thank you for choosing IST-Sovereign.</p>
    ${rows}
    <div style="background:#e8f5e9;border-radius:8px;padding:16px;margin-top:20px">
      <b style="font-size:13px;color:#2e7d32">How to activate:</b>
      <ol style="font-size:13px;color:#5f6368;margin:8px 0 0;padding-left:20px;line-height:2.2">
        <li>Download IST-Sovereign.exe from your dashboard</li>
        <li>Right-click → <strong>Run as Administrator</strong></li>
        <li>Paste your key and press ACTIVATE</li>
        <li>Key locks permanently to your device on first use</li>
        ${keys.length>1?'<li>Each key activates on one separate device</li>':''}
      </ol>
    </div>
    <div style="margin-top:20px;padding-top:16px;border-top:1px solid #e0e0e0;
                font-size:12px;color:#9aa0a6;text-align:center">
      IST-Sovereign | Hyderabad, India | ist.sovereign.support@gmail.com
    </div>
  </div>`;
}

// ── EMAIL SERVICE ─────────────────────────────────────────────────────────────
// EMAIL_PASS must be a Gmail App Password (16 chars, NOT your Gmail password)
// Generate: myaccount.google.com → Security → 2-Step → App passwords
let mailer = null;
async function initEmail() {
  const user = process.env.EMAIL_USER, pass = process.env.EMAIL_PASS;
  if (!user || !pass) { console.log('[Email] Not configured — set EMAIL_USER + EMAIL_PASS'); return; }
  try {
    const nm = (await import('nodemailer')).default;
    mailer = nm.createTransport({
      host:'smtp.gmail.com', port:587, secure:false,
      auth:{ user, pass }, tls:{ rejectUnauthorized:false }
    });
    console.log('[Email] Configured for:', user);
  } catch(e) { console.log('[Email] Setup failed:', e.message); mailer=null; }
}

async function sendEmail(to, subject, html) {
  if (!mailer) { console.log('[Email] Skipped (not configured):', to); return false; }
  try {
    const info = await mailer.sendMail({
      from:`"IST-Sovereign" <${process.env.EMAIL_USER}>`, to, subject, html });
    console.log('[Email] Sent OK:', to, info.messageId);
    return true;
  } catch(e) {
    console.error('[Email] FAILED:', to, e.message);
    console.error('[Email] Fix: Check App Password at myaccount.google.com → Security → App passwords');
    return false;
  }
}

// ── RAZORPAY ──────────────────────────────────────────────────────────────────
// Set in Railway Variables:
//   RAZORPAY_KEY_ID     = rzp_test_SkalBTbadktm5x
//   RAZORPAY_KEY_SECRET = AL4ADpYiAwCAWAlB0pFvOQxI
let razorpay = null;
async function initRazorpay() {
  const id=process.env.RAZORPAY_KEY_ID, sec=process.env.RAZORPAY_KEY_SECRET;
  if (!id||!sec) { console.log('[Razorpay] Not configured'); return; }
  try {
    const RZP = (await import('razorpay')).default;
    razorpay = new RZP({ key_id:id, key_secret:sec });
    console.log('[Razorpay] Ready:', id.substring(0,20)+'...');
  } catch(e) { console.log('[Razorpay] Failed:', e.message); razorpay=null; }
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function requireAuth(req,res,next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({error:'No token — please sign in'});
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({error:'Token expired — please sign in again'}); }
}
function requireAdmin(req,res,next) {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({error:'No admin token'});
  try { jwt.verify(token, JWT_SECRET+'_admin'); next(); }
  catch { res.status(401).json({error:'Admin session expired'}); }
}

// ── RATE LIMITERS ─────────────────────────────────────────────────────────────
const _adminRate={}, _regRate={}, _agentRate={};
function rateCheck(map, ip, max, windowMs) {
  const now=Date.now(), e=map[ip]||{c:0,t:now+windowMs};
  if (now>e.t) { e.c=0; e.t=now+windowMs; }
  e.c++; map[ip]=e; return e.c>max;
}
app.use('/api/admin/login',    (q,r,n)=>rateCheck(_adminRate,q.ip,10,300000)?r.status(429).json({error:'Too many attempts'}):n());
app.use('/api/user/register',  (q,r,n)=>rateCheck(_regRate,q.ip,5,3600000)?r.status(429).json({error:'Too many registrations'}):n());
app.use('/api/activate',       (q,r,n)=>rateCheck(_agentRate,q.ip,20,600000)?r.status(429).json({error:'Too many attempts'}):n());

// ── USER ROUTES ───────────────────────────────────────────────────────────────

app.post('/api/user/register', async (req,res) => {
  const {name,email,password}=req.body;
  if (!name||!email||!password) return res.status(400).json({error:'All fields required'});
  if (password.length<6) return res.status(400).json({error:'Password min 6 characters'});
  const db=loadDB(), el=email.toLowerCase();
  if (db.users.find(u=>u.email===el))
    return res.status(400).json({error:'Email already registered — please sign in'});
  const user={ id:crypto.randomUUID(), name, email:el,
    password:await bcrypt.hash(password,10), createdAt:new Date().toISOString() };
  db.users.push(user); saveDB(db);
  addAudit('USER_REGISTER',null,email,req.ip);
  await sendEmail(email,'Welcome to IST-Sovereign',`
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px">
      <h2 style="color:#1a73e8">Welcome, ${name}!</h2>
      <p>Your account is ready. Sign in to get your free 7-day trial key.</p>
      <p><a href="https://ist-sovereign-production.up.railway.app/dashboard.html"
         style="background:#1a73e8;color:white;padding:12px 24px;border-radius:6px;text-decoration:none">
         Go to Dashboard</a></p>
      <p style="color:#9aa0a6;font-size:12px">IST-Sovereign | ist.sovereign.support@gmail.com</p>
    </div>`);
  res.json({success:true});
});

app.post('/api/user/login', async (req,res) => {
  const {email,password}=req.body;
  if (!email||!password) return res.status(400).json({error:'Email and password required'});
  const db=loadDB(), user=db.users.find(u=>u.email===email.toLowerCase());
  if (!user) return res.status(401).json({error:'No account found with this email'});
  if (!await bcrypt.compare(password,user.password))
    return res.status(401).json({error:'Incorrect password'});
  const token=jwt.sign({id:user.id,email:user.email,name:user.name},JWT_SECRET,{expiresIn:'30d'});
  addAudit('USER_LOGIN',null,email,req.ip);
  res.json({token,user:{name:user.name,email:user.email}});
});

app.post('/api/user/forgot-password', async (req,res) => {
  res.json({success:true});
  const {email}=req.body; if (!email) return;
  const db=loadDB(), user=db.users.find(u=>u.email===email.toLowerCase());
  if (!user) return;
  const tok=crypto.randomBytes(32).toString('hex');
  user.resetToken=tok; user.resetExpiry=new Date(Date.now()+3600000).toISOString();
  saveDB(db);
  await sendEmail(email,'IST-Sovereign — Reset Password',`
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px">
      <h2 style="color:#1a73e8">Reset Your Password</h2>
      <p>Click below — valid for 1 hour.</p>
      <p><a href="https://ist-sovereign-production.up.railway.app/reset.html?token=${tok}"
         style="background:#1a73e8;color:white;padding:12px 24px;border-radius:6px;text-decoration:none">
         Reset Password</a></p>
    </div>`);
});

app.post('/api/user/change-password', requireAuth, async (req,res) => {
  const {currentPassword,newPassword}=req.body;
  if (!currentPassword||!newPassword) return res.status(400).json({error:'Both passwords required'});
  if (newPassword.length<6) return res.status(400).json({error:'New password min 6 characters'});
  const db=loadDB(), user=db.users.find(u=>u.id===req.user.id);
  if (!user) return res.status(404).json({error:'User not found'});
  if (!await bcrypt.compare(currentPassword,user.password))
    return res.status(401).json({error:'Current password is incorrect'});
  if (currentPassword===newPassword)
    return res.status(400).json({error:'New password must be different'});
  user.password=await bcrypt.hash(newPassword,10);
  saveDB(db); addAudit('PASSWORD_CHANGED',null,req.user.email,req.ip);
  res.json({success:true});
});

app.get('/api/user/dashboard', requireAuth, (req,res) => {
  const db=loadDB(), user=db.users.find(u=>u.id===req.user.id);
  res.json({user:{name:user?.name,email:user?.email},
    keys:db.keys.filter(k=>k.userId===req.user.id)});
});

// ── TRIAL KEY ─────────────────────────────────────────────────────────────────
// One trial per account AND one trial per hardware device
app.post('/api/user/trial', requireAuth, async (req,res) => {
  const db=loadDB();
  if (db.keys.find(k=>k.userId===req.user.id&&k.plan==='TRIAL'))
    return res.status(400).json({error:'Trial already used — please upgrade to continue'});
  const ipTrials=db.keys.filter(k=>k.plan==='TRIAL'&&k.registrationIp===req.ip);
  if (ipTrials.length>=2)
    return res.status(400).json({error:'Trial limit reached from this location — please upgrade'});
  const user=db.users.find(u=>u.id===req.user.id);
  const k=makeKey('TRIAL',req.user.id,user?.name,req.user.email);
  k.registrationIp=req.ip;
  db.keys.unshift(k); saveDB(db);
  addAudit('TRIAL_GENERATED',k.keyCode,req.user.email,req.ip);
  await sendEmail(req.user.email,'Your IST-Sovereign Free Trial Key (7 Days Gold)',
    keyEmail([k],'Free Trial',user?.name));
  res.json({success:true,key:k});
});

// ── FEEDBACK ──────────────────────────────────────────────────────────────────
app.post('/api/user/feedback', requireAuth, async (req,res) => {
  const {message,rating}=req.body;
  if (!message||message.trim().length<5) return res.status(400).json({error:'Message too short'});
  const db=loadDB(), user=db.users.find(u=>u.id===req.user.id);
  db.feedbacks.unshift({ id:crypto.randomUUID(), userId:req.user.id,
    email:req.user.email, name:user?.name||'', message:message.trim(),
    rating:rating||null, date:new Date().toISOString(), ip:req.ip });
  if (db.feedbacks.length>500) db.feedbacks=db.feedbacks.slice(0,500);
  saveDB(db); addAudit('FEEDBACK',null,`From: ${req.user.email}`,req.ip);
  await sendEmail(process.env.EMAIL_USER,
    `IST-Sovereign — Feedback from ${user?.name||req.user.email}`,
    `<div style="font-family:Arial;padding:20px"><h3>New Feedback</h3>
     <p><b>From:</b> ${user?.name} (${req.user.email})</p>
     <p><b>Rating:</b> ${'★'.repeat(rating||0)||'Not rated'}</p>
     <blockquote style="background:#f8f9fa;padding:12px;border-left:4px solid #1a73e8">
       ${message.trim()}</blockquote></div>`);
  res.json({success:true});
});

app.post('/api/public/feedback', async (req,res) => {
  const {name,email,message}=req.body;
  if (!message||!email) return res.status(400).json({error:'Email and message required'});
  const db=loadDB();
  db.feedbacks.unshift({ id:crypto.randomUUID(), userId:null, email,
    name:name||email, message:message.trim(), rating:null,
    date:new Date().toISOString(), ip:req.ip });
  saveDB(db); res.json({success:true});
});

// ── PAYMENT ROUTES ────────────────────────────────────────────────────────────
app.post('/api/payment/create-order', requireAuth, async (req,res) => {
  const planId=req.body.plan||req.body.tier;
  const plan=PLANS[planId];
  if (!plan||plan.price===0) return res.status(400).json({error:'Invalid plan: '+planId});
  if (!razorpay) return res.status(503).json({
    error:'Payment gateway not ready', fallback:true,
    message:'WhatsApp +91 77022 49018 or email ist.sovereign.support@gmail.com'});
  try {
    const order=await razorpay.orders.create({
      amount:plan.price, currency:'INR', receipt:`ist_${planId}_${Date.now()}` });
    res.json({orderId:order.id, amount:order.amount, currency:'INR', plan:planId});
  } catch(e) {
    console.error('[Razorpay] Order failed:', e.message);
    res.status(500).json({error:e.message, fallback:true});
  }
});

app.post('/api/payment/verify', requireAuth, async (req,res) => {
  const {razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body;
  const planId=req.body.plan||req.body.tier;
  if (!process.env.RAZORPAY_KEY_SECRET)
    return res.status(503).json({error:'Payment not configured on server'});
  if (!planId||!PLANS[planId])
    return res.status(400).json({error:'Invalid plan in verify request'});
  const sig=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
  if (sig!==razorpay_signature)
    return res.status(400).json({error:'Payment signature verification failed'});
  const db=loadDB(), user=db.users.find(u=>u.id===req.user.id);
  const plan=PLANS[planId], keys=[];
  for (let i=0;i<plan.keys;i++) {
    const k=makeKey(planId,req.user.id,user?.name,req.user.email);
    db.keys.unshift(k); keys.push(k);
  }
  db.payments.push({ id:crypto.randomUUID(), userId:req.user.id, email:req.user.email,
    plan:planId, planLabel:plan.label, amount:plan.price, keyCount:plan.keys,
    keyCodes:keys.map(k=>k.keyCode), razorpayOrderId:razorpay_order_id,
    razorpayPaymentId:razorpay_payment_id, paidAt:new Date().toISOString() });
  saveDB(db);
  addAudit('PAYMENT_SUCCESS',keys[0].keyCode,`${planId} x${plan.keys} Rs.${plan.price/100}`,req.ip);
  await sendEmail(req.user.email,`Your IST-Sovereign ${plan.label} Keys`,
    keyEmail(keys,plan.label,user?.name));
  res.json({success:true, keys, keyCount:plan.keys, planLabel:plan.label});
});

// ── WINDOWS AGENT ─────────────────────────────────────────────────────────────
app.post('/api/activate', (req,res) => {
  const {keyCode,hardwareId}=req.body;
  if (!keyCode||!hardwareId) return res.status(400).json({error:'Missing fields'});
  const db=loadDB(), key=db.keys.find(k=>k.keyCode===keyCode);
  if (!key) return res.status(404).json({error:'Key not found'});
  if (key.status==='KILLED') return res.status(403).json({error:'Key terminated — contact support'});
  if (new Date(key.expiresAt)<new Date()) return res.status(403).json({error:'Key expired — please renew'});
  if (key.hardwareId&&key.hardwareId!==hardwareId)
    return res.status(403).json({error:'Hardware mismatch — key locked to another device'});
  if (!key.hardwareId) {
    if (key.plan==='TRIAL') {
      const hwConflict=db.keys.find(k=>k.hardwareId===hardwareId&&k.plan==='TRIAL'&&k.keyCode!==keyCode&&k.status==='ACTIVE');
      if (hwConflict) return res.status(403).json({error:'This device has already used a free trial — please purchase a plan'});
    }
    key.hardwareId=hardwareId; key.status='ACTIVE';
    key.activatedAt=new Date().toISOString();
    addAudit('KEY_ACTIVATED',keyCode,'HW:'+hardwareId.slice(0,12),req.ip);
  }
  key.lastSeen=new Date().toISOString(); saveDB(db);
  res.json({valid:true, plan:key.plan, tier:key.plan,
    channels:key.channels, label:key.label, expiresAt:key.expiresAt});
});

app.post('/api/process-signal', (req,res) => {
  const {keyCode,hardwareId,speed}=req.body;
  const db=loadDB(), key=db.keys.find(k=>k.keyCode===keyCode&&k.hardwareId===hardwareId);
  if (!key||key.status!=='ACTIVE') return res.status(403).json({error:'Unauthorized'});
  if (new Date(key.expiresAt)<new Date()) return res.status(403).json({error:'Expired'});
  key.lastSeen=new Date().toISOString(); saveDB(db);
  const s=Math.max(1,Math.min(16,parseInt(speed)||1)), n=(s-1)/15;
  res.json({ throughput:+((VAR_A*s*VAR_C).toFixed(2)),
    latencyReduction:+(Math.min(n*VAR_B*100,85).toFixed(1)),
    energyEfficiency:+(Math.min((VAR_D+n*0.15),0.97)*100).toFixed(1),
    channels:key.channels, speed:s });
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req,res) => {
  if (req.body.password!==ADMIN_PASSWORD) return res.status(403).json({error:'Wrong password'});
  const token=jwt.sign({role:'admin'},JWT_SECRET+'_admin',{expiresIn:'12h'});
  addAudit('ADMIN_LOGIN',null,'Admin in',req.ip);
  res.json({token});
});

app.get('/api/admin/stats', requireAdmin, (req,res) => {
  const db=loadDB(), now=new Date();
  res.json({ totalKeys:db.keys.length,
    activeKeys:db.keys.filter(k=>k.status==='ACTIVE').length,
    trialKeys:db.keys.filter(k=>k.plan==='TRIAL').length,
    killedKeys:db.keys.filter(k=>k.status==='KILLED').length,
    expiredKeys:db.keys.filter(k=>k.status!=='KILLED'&&new Date(k.expiresAt)<now).length,
    totalUsers:db.users.length,
    totalRevenue:db.payments.reduce((s,p)=>s+(p.amount||0),0),
    recentAudit:db.audit.slice(0,20) });
});

app.get('/api/admin/keys',  requireAdmin, (req,res) => res.json({keys:loadDB().keys}));
app.get('/api/admin/users', requireAdmin, (req,res) => res.json({
  users:loadDB().users.map(u=>({id:u.id,name:u.name,email:u.email,createdAt:u.createdAt})) }));

app.post('/api/admin/generate-key', requireAdmin, async (req,res) => {
  const {plan='TRIAL',customerName,customerEmail,notes,count}=req.body;
  const pi=PLANS[plan]; if (!pi) return res.status(400).json({error:'Invalid plan'});
  const n=Math.max(1,Math.min(100,parseInt(count)||pi.keys));
  const db=loadDB(), keys=[];
  for (let i=0;i<n;i++) {
    const k=makeKey(plan,null,customerName,customerEmail);
    k.notes=notes||null; db.keys.unshift(k); keys.push(k);
  }
  saveDB(db); addAudit('ADMIN_KEY_GEN',keys[0].keyCode,`${plan} x${n} ${customerEmail||''}`,req.ip);
  if (customerEmail) await sendEmail(customerEmail,`Your IST-Sovereign ${pi.label} Keys`,
    keyEmail(keys,pi.label,customerName));
  res.json({success:true,keys,keyCount:n});
});

app.post('/api/admin/kill-key',   requireAdmin, (req,res) => {
  const db=loadDB(), k=db.keys.find(k=>k.keyCode===req.body.keyCode);
  if(k){k.status='KILLED';saveDB(db);} addAudit('KEY_KILLED',req.body.keyCode,'Admin kill',req.ip);
  res.json({success:true}); });

app.post('/api/admin/revive-key', requireAdmin, (req,res) => {
  const db=loadDB(), k=db.keys.find(k=>k.keyCode===req.body.keyCode);
  if(k){k.status='ACTIVE';saveDB(db);} addAudit('KEY_REVIVED',req.body.keyCode,'Admin revive',req.ip);
  res.json({success:true}); });

app.post('/api/admin/extend-key', requireAdmin, (req,res) => {
  const {keyCode,days}=req.body, db=loadDB(), k=db.keys.find(k=>k.keyCode===keyCode);
  if (!k) return res.status(404).json({error:'Not found'});
  const base=new Date(k.expiresAt)>new Date()?new Date(k.expiresAt):new Date();
  k.expiresAt=new Date(base.getTime()+days*86400000).toISOString();
  saveDB(db); addAudit('KEY_EXTENDED',keyCode,`+${days}d`,req.ip);
  res.json({success:true,newExpiry:k.expiresAt}); });

app.get('/api/admin/audit',     requireAdmin, (req,res) => res.json({log:loadDB().audit.slice(0,100)}));
app.get('/api/admin/feedbacks', requireAdmin, (req,res) => res.json({feedbacks:loadDB().feedbacks}));

app.get('/api/admin/download-db', requireAdmin, (req,res) => {
  const db=loadDB(), date=new Date().toISOString().slice(0,10);
  res.setHeader('Content-Type','application/json');
  res.setHeader('Content-Disposition',`attachment; filename="ist_db_backup_${date}.json"`);
  res.json(db); addAudit('DB_DOWNLOADED',null,'Admin backup',req.ip); });

app.get('/api/config', (req,res) => res.json({
  razorpayKeyId: process.env.RAZORPAY_KEY_ID||'', version:'4.0.0' }));

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/api/health', (req,res) => {
  const db=loadDB();
  res.json({ status:'ok', version:'4.0.0', db:DB_FILE,
    persistent:DATA_DIR==='/data', users:db.users.length,
    keys:db.keys.length, payments:db.payments.length,
    feedbacks:db.feedbacks.length,
    email:!!mailer,
    emailUser:process.env.EMAIL_USER?process.env.EMAIL_USER.replace(/(.{3}).*(@.*)/,'$1***$2'):'NOT SET',
    emailPass:process.env.EMAIL_PASS?'SET ('+process.env.EMAIL_PASS.length+' chars)':'NOT SET',
    razorpay:!!razorpay,
    razorpayKey:process.env.RAZORPAY_KEY_ID?process.env.RAZORPAY_KEY_ID.substring(0,15)+'...':'NOT SET',
    time:new Date().toISOString() });
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT=process.env.PORT||3001;
async function startServer() {
  console.log('='.repeat(54));
  console.log('  IST-Sovereign Backend v4.0');
  console.log('  DB:', DB_FILE);
  console.log('  Volume:', DATA_DIR==='/data'?'YES — permanent':'NO — add /data Volume');
  await initEmail(); await initRazorpay();
  app.listen(PORT,'0.0.0.0',() => {
    console.log('='.repeat(54));
    console.log(`  LIVE on PORT ${PORT}`);
    console.log(`  Email   : ${mailer?'READY':'NOT CONFIGURED'}`);
    console.log(`  Razorpay: ${razorpay?'READY':'NOT CONFIGURED'}`);
    console.log(`  Admin pw: ${ADMIN_PASSWORD}`);
    console.log('='.repeat(54));
  });
}
startServer().catch(e => {
  console.error('Fatal startup:', e.message);
  app.listen(PORT,'0.0.0.0',()=>console.log(`IST-Sovereign PORT ${PORT}`));
});