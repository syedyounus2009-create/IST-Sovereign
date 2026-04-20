import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Database ──────────────────────────────────────────────────────────────────
const DB_FILE = path.join(__dirname, 'ist_db.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], keys: [], audit: [] }, null, 2));
  }
  const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!data.users)  data.users  = [];
  if (!data.keys)   data.keys   = [];
  if (!data.audit)  data.audit  = [];
  return data;
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function logAudit(action, keyCode, detail, ip) {
  const db = loadDB();
  db.audit.unshift({
    id: Date.now(), action,
    keyCode: keyCode || null, detail: detail || null,
    ip: ip || null, timestamp: new Date().toISOString()
  });
  if (db.audit.length > 300) db.audit = db.audit.slice(0, 300);
  saveDB(db);
}

// ── Config ────────────────────────────────────────────────────────────────────
const JWT_SECRET      = process.env.JWT_SECRET      || 'ist-jwt-secret-2026';
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD  || 'IST-Admin-2026';
const VAR_A = parseFloat(process.env.VAR_A || '1.22');
const VAR_B = parseFloat(process.env.VAR_B || '1.618');
const VAR_C = parseFloat(process.env.VAR_C || '0.94');
const VAR_D = parseFloat(process.env.VAR_D || '0.82');

// Optional services — gracefully skipped if not configured
let transporter = null;
let razorpay    = null;

try {
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    const nodemailer = (await import('nodemailer')).default;
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });
    console.log('✓ Email service configured');
  }
} catch(e) { console.log('Email service not available'); }

try {
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    const Razorpay = (await import('razorpay')).default;
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });
    console.log('✓ Razorpay configured');
  }
} catch(e) { console.log('Razorpay not available'); }

async function sendEmail(to, subject, html) {
  if (!transporter) {
    console.log(`[Email skipped] Would send to ${to}: ${subject}`);
    return;
  }
  try {
    await transporter.sendMail({
      from: `"IST-Sovereign" <${process.env.EMAIL_USER}>`,
      to, subject, html
    });
    console.log(`Email sent to ${to}`);
  } catch(e) { console.error('Email error:', e.message); }
}

const TIERS = {
  TRIAL:  { days: 7,   channels: 128,  label: 'Free Trial',   prefix: 'IST2' },
  BRONZE: { days: 30,  channels: 256,  label: 'Bronze',       prefix: 'ISTB' },
  SILVER: { days: 30,  channels: 512,  label: 'Silver',       prefix: 'ISTS' },
  GOLD:   { days: 30,  channels: 1024, label: 'Gold',         prefix: 'ISTG' },
  PRO:    { days: 365, channels: 1024, label: 'Professional', prefix: 'ISTP' },
};

function makeKey(tier = 'TRIAL', userId = null) {
  const t = TIERS[tier];
  if (!t) throw new Error('Invalid tier');
  const r = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  const keyCode  = `${t.prefix}-${r()}-${r()}-${r()}`;
  const now      = new Date();
  const expires  = new Date(now.getTime() + t.days * 86400000);
  return {
    keyCode, tier, label: t.label, channels: t.channels,
    createdAt: now.toISOString(), expiresAt: expires.toISOString(),
    status: 'PENDING', hardwareId: null, userId,
    customerName: null, customerEmail: null,
    activatedAt: null, lastSeen: null, notes: null
  };
}

// ── Auth Middleware ────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'No admin token' });
  try { jwt.verify(token, JWT_SECRET + '_admin'); next(); }
  catch { res.status(401).json({ error: 'Invalid admin token' }); }
}

// ═════════════════════════════════════════════════════════════════════════════
// USER AUTH ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.post('/api/user/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'All fields required' });

  const db = loadDB();
  if (db.users.find(u => u.email === email))
    return res.status(400).json({ error: 'Email already registered' });

  const hashed = await bcrypt.hash(password, 10);
  const user = {
    id: crypto.randomUUID(), name, email,
    password: hashed, createdAt: new Date().toISOString()
  };
  db.users.push(user);
  saveDB(db);
  logAudit('USER_REGISTER', null, email, req.ip);

  await sendEmail(email, 'Welcome to IST-Sovereign', `
    <h3>Welcome, ${name}!</h3>
    <p>Thank you for registering with IST-Sovereign.</p>
    <p>Log in to your dashboard to generate your free 7-day trial key.</p>
    <p>Support: ist.sovereign.support@gmail.com</p>
  `);

  res.json({ success: true });
});

app.post('/api/user/login', async (req, res) => {
  const { email, password } = req.body;
  const db   = loadDB();
  const user = db.users.find(u => u.email === email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, email: user.email, name: user.name },
                          JWT_SECRET, { expiresIn: '7d' });
  logAudit('USER_LOGIN', null, email, req.ip);
  res.json({ token, user: { name: user.name, email: user.email } });
});

app.get('/api/user/dashboard', requireAuth, (req, res) => {
  const db      = loadDB();
  const user    = db.users.find(u => u.id === req.user.id);
  const userKeys = db.keys.filter(k => k.userId === req.user.id);
  res.json({ user: { name: user?.name, email: user?.email }, keys: userKeys });
});

app.post('/api/user/trial', requireAuth, async (req, res) => {
  const db = loadDB();
  const hasTrial = db.keys.find(k => k.userId === req.user.id && k.tier === 'TRIAL');
  if (hasTrial)
    return res.status(400).json({ error: 'Trial key already generated for this account.' });

  const k = makeKey('TRIAL', req.user.id);
  k.customerEmail = req.user.email;
  db.keys.unshift(k);
  saveDB(db);
  logAudit('TRIAL_GENERATED', k.keyCode, req.user.email, req.ip);

  await sendEmail(req.user.email, 'Your IST-Sovereign 7-Day Trial Key', `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
      <h2 style="color:#1a73e8">Your Trial Key is Ready</h2>
      <p>Hello ${req.user.name || 'there'},</p>
      <p>Here is your 7-day free trial key:</p>
      <div style="background:#f8f9fa;border:2px dashed #1a73e8;padding:20px;text-align:center;margin:20px 0;border-radius:8px">
        <div style="font-family:monospace;font-size:22px;letter-spacing:3px;color:#1a73e8;font-weight:bold">
          ${k.keyCode}
        </div>
        <div style="color:#5f6368;font-size:13px;margin-top:8px">Valid for 7 days</div>
      </div>
      <p><strong>How to use:</strong></p>
      <ol style="color:#5f6368">
        <li>Download IST-Sovereign.exe from your dashboard</li>
        <li>Run as Administrator</li>
        <li>Enter this key when prompted</li>
        <li>Select your target application and activate</li>
      </ol>
      <p>Need help? Reply to this email or WhatsApp us.</p>
      <p style="color:#5f6368;font-size:12px">IST-Sovereign | Hyderabad, India | ist.sovereign.support@gmail.com</p>
    </div>
  `);

  res.json({ success: true, key: k });
});

// ═════════════════════════════════════════════════════════════════════════════
// PAYMENT ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.post('/api/payment/create-order', requireAuth, async (req, res) => {
  const { tier } = req.body;
  const amounts = { BRONZE: 19900, SILVER: 49900, GOLD: 99900 };
  if (!amounts[tier]) return res.status(400).json({ error: 'Invalid tier' });

  if (!razorpay) {
    return res.status(503).json({ error: 'Payment gateway not configured yet. Contact ist.sovereign.support@gmail.com to purchase.' });
  }

  try {
    const order = await razorpay.orders.create({
      amount: amounts[tier], currency: 'INR',
      receipt: `rcpt_${crypto.randomBytes(4).toString('hex')}`
    });
    res.json({ orderId: order.id, amount: order.amount, currency: 'INR' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/payment/verify', requireAuth, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, tier } = req.body;
  if (!process.env.RAZORPAY_KEY_SECRET)
    return res.status(503).json({ error: 'Payment not configured' });

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expected !== razorpay_signature)
    return res.status(400).json({ error: 'Invalid payment signature' });

  const db = loadDB();
  const k  = makeKey(tier, req.user.id);
  k.customerEmail = req.user.email;
  db.keys.unshift(k);
  saveDB(db);
  logAudit('PAYMENT_SUCCESS', k.keyCode, `${tier} ${req.user.email}`, req.ip);

  await sendEmail(req.user.email, `Your IST-Sovereign ${tier} Key`, `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
      <h2 style="color:#1a73e8">Payment Successful — ${tier} Plan</h2>
      <p>Your new key:</p>
      <div style="background:#f8f9fa;border:2px solid #1a73e8;padding:20px;text-align:center;margin:20px 0;border-radius:8px">
        <div style="font-family:monospace;font-size:22px;letter-spacing:3px;color:#1a73e8;font-weight:bold">
          ${k.keyCode}
        </div>
        <div style="color:#5f6368;font-size:13px;margin-top:8px">${TIERS[tier].channels}-channel mode | 30 days</div>
      </div>
      <p style="color:#5f6368;font-size:12px">IST-Sovereign | ist.sovereign.support@gmail.com</p>
    </div>
  `);

  res.json({ success: true, key: k });
});

// ═════════════════════════════════════════════════════════════════════════════
// WINDOWS AGENT ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.post('/api/activate', (req, res) => {
  const { keyCode, hardwareId } = req.body;
  if (!keyCode || !hardwareId)
    return res.status(400).json({ error: 'Missing fields' });

  const db  = loadDB();
  const row = db.keys.find(k => k.keyCode === keyCode);
  if (!row)  return res.status(404).json({ error: 'Key not found' });
  if (row.status === 'KILLED')  return res.status(403).json({ error: 'Key terminated' });
  if (new Date(row.expiresAt) < new Date()) return res.status(403).json({ error: 'Key expired' });
  if (row.hardwareId && row.hardwareId !== hardwareId)
    return res.status(403).json({ error: 'Hardware mismatch — key locked to another device' });

  if (!row.hardwareId) {
    row.hardwareId   = hardwareId;
    row.status       = 'ACTIVE';
    row.activatedAt  = new Date().toISOString();
    logAudit('FIRST_ACTIVATION', keyCode, hardwareId, req.ip);
  }
  row.lastSeen = new Date().toISOString();
  saveDB(db);

  res.json({
    valid: true, tier: row.tier,
    channels: TIERS[row.tier]?.channels || 128,
    expiresAt: row.expiresAt
  });
});

app.post('/api/process-signal', (req, res) => {
  const { keyCode, hardwareId, speed } = req.body;
  const db  = loadDB();
  const row = db.keys.find(k => k.keyCode === keyCode && k.hardwareId === hardwareId);
  if (!row || row.status !== 'ACTIVE')
    return res.status(403).json({ error: 'Unauthorized' });
  if (new Date(row.expiresAt) < new Date())
    return res.status(403).json({ error: 'Expired' });

  row.lastSeen = new Date().toISOString();
  saveDB(db);

  const s    = Math.max(1, Math.min(16, parseInt(speed) || 1));
  const norm = (s - 1) / 15;
  res.json({
    throughput:       +((VAR_A * s * VAR_C).toFixed(2)),
    latencyReduction: +(Math.min(norm * VAR_B * 100, 85).toFixed(1)),
    energyEfficiency: +(Math.min((VAR_D + norm * 0.15), 0.97) * 100).toFixed(1),
    visualFrequency:  +((VAR_A * s).toFixed(3)),
    channels: TIERS[row.tier]?.channels || 128,
    speed: s
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD)
    return res.status(403).json({ error: 'Wrong password' });
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET + '_admin', { expiresIn: '12h' });
  logAudit('ADMIN_LOGIN', null, 'Admin login', req.ip);
  res.json({ token });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const db  = loadDB();
  const now = new Date();
  res.json({
    totalKeys:    db.keys.length,
    activeKeys:   db.keys.filter(k => k.status === 'ACTIVE').length,
    trialKeys:    db.keys.filter(k => k.tier === 'TRIAL').length,
    killedKeys:   db.keys.filter(k => k.status === 'KILLED').length,
    expiredKeys:  db.keys.filter(k => k.status !== 'KILLED' && new Date(k.expiresAt) < now).length,
    totalUsers:   db.users.length,
    recentAudit:  db.audit.slice(0, 20)
  });
});

app.get('/api/admin/keys', requireAdmin, (req, res) => {
  res.json({ keys: loadDB().keys });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = loadDB().users.map(u => ({
    id: u.id, name: u.name, email: u.email, createdAt: u.createdAt
  }));
  res.json({ users });
});

app.post('/api/admin/generate-key', requireAdmin, async (req, res) => {
  const { tier = 'TRIAL', customerName, customerEmail, notes } = req.body;
  try {
    const k = makeKey(tier);
    k.customerName  = customerName  || null;
    k.customerEmail = customerEmail || null;
    k.notes         = notes         || null;
    const db = loadDB();
    db.keys.unshift(k);
    saveDB(db);
    logAudit('ADMIN_KEY_GENERATED', k.keyCode, `${tier} ${customerEmail || ''}`, req.ip);

    if (customerEmail) {
      await sendEmail(customerEmail, `Your IST-Sovereign ${k.label} Key`, `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
          <h2 style="color:#1a73e8">Your IST-Sovereign Key</h2>
          <p>Hello ${customerName || 'there'},</p>
          <div style="background:#f8f9fa;border:2px dashed #1a73e8;padding:20px;text-align:center;margin:20px 0;border-radius:8px">
            <div style="font-family:monospace;font-size:22px;letter-spacing:3px;color:#1a73e8;font-weight:bold">
              ${k.keyCode}
            </div>
            <div style="color:#5f6368;font-size:13px;margin-top:8px">${k.label} | Valid ${TIERS[tier].days} days</div>
          </div>
          <p>Download the agent from: <a href="https://ist-sovereign.vercel.app">ist-sovereign.vercel.app</a></p>
          <p style="color:#5f6368;font-size:12px">IST-Sovereign | ist.sovereign.support@gmail.com</p>
        </div>
      `);
    }
    res.json({ success: true, key: k });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/admin/kill-key', requireAdmin, (req, res) => {
  const db  = loadDB();
  const row = db.keys.find(k => k.keyCode === req.body.keyCode);
  if (row) { row.status = 'KILLED'; saveDB(db); }
  logAudit('KEY_KILLED', req.body.keyCode, 'Admin kill switch', req.ip);
  res.json({ success: true });
});

app.post('/api/admin/revive-key', requireAdmin, (req, res) => {
  const db  = loadDB();
  const row = db.keys.find(k => k.keyCode === req.body.keyCode);
  if (row) { row.status = 'ACTIVE'; saveDB(db); }
  logAudit('KEY_REVIVED', req.body.keyCode, 'Admin revive', req.ip);
  res.json({ success: true });
});

app.post('/api/admin/extend-key', requireAdmin, (req, res) => {
  const { keyCode, days } = req.body;
  const db  = loadDB();
  const row = db.keys.find(k => k.keyCode === keyCode);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const base = new Date(row.expiresAt) > new Date() ? new Date(row.expiresAt) : new Date();
  row.expiresAt = new Date(base.getTime() + days * 86400000).toISOString();
  saveDB(db);
  logAudit('KEY_EXTENDED', keyCode, `+${days} days`, req.ip);
  res.json({ success: true, newExpiry: row.expiresAt });
});

app.get('/api/admin/audit', requireAdmin, (req, res) => {
  res.json({ log: loadDB().audit.slice(0, 100) });
});

// ═════════════════════════════════════════════════════════════════════════════
// START
// ═════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;

app.get("/", (req, res) => {
  res.send("IST-Sovereign Backend Running");
});

app.listen(PORT, () => {
  console.log("\n====================================");
  console.log(`IST-Sovereign Backend running on PORT ${PORT}`);
  console.log("====================================");

  console.log(`Admin portal : http://localhost:${PORT}/admin`);
  console.log(`User site    : http://localhost:${PORT}/`);
  console.log(`Database     : db.json\n`);
});

