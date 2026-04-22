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

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ── Database ──────────────────────────────────────────────────────────────────
const DB_FILE = path.join(__dirname, 'ist_db.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE,
      JSON.stringify({ users: [], keys: [], audit: [] }, null, 2));
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
  try {
    const db = loadDB();
    db.audit.unshift({
      id: Date.now(), action,
      keyCode: keyCode || null,
      detail: detail || null,
      ip: ip || null,
      timestamp: new Date().toISOString()
    });
    if (db.audit.length > 300) db.audit = db.audit.slice(0, 300);
    saveDB(db);
  } catch(e) {}
}

// ── Config ────────────────────────────────────────────────────────────────────
const JWT_SECRET     = process.env.JWT_SECRET     || 'ist-sovereign-2026';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'IST-Admin-2026';
const VAR_A = parseFloat(process.env.VAR_A || '1.22');
const VAR_B = parseFloat(process.env.VAR_B || '1.618');
const VAR_C = parseFloat(process.env.VAR_C || '0.94');
const VAR_D = parseFloat(process.env.VAR_D || '0.82');

// ── Optional services — loaded safely, server never crashes without them ──────
let transporter = null;
let razorpayInstance = null;

async function initServices() {
  // Email
  try {
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      const nodemailer = (await import('nodemailer')).default;
      transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS
        }
      });
      // Verify connection
      await transporter.verify();
      console.log('✓ Email service ready');
    } else {
      console.log('⚠ Email not configured — keys will not be emailed');
    }
  } catch(e) {
    console.log('⚠ Email setup failed:', e.message);
    transporter = null;
  }

  // Razorpay
  try {
    if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
        && !process.env.RAZORPAY_KEY_ID.includes('dummy')) {
      const Razorpay = (await import('razorpay')).default;
      razorpayInstance = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
      });
      console.log('✓ Razorpay ready');
    } else {
      console.log('⚠ Razorpay not configured — payments via WhatsApp/email');
    }
  } catch(e) {
    console.log('⚠ Razorpay setup failed:', e.message);
    razorpayInstance = null;
  }
}

async function sendEmail(to, subject, html) {
  if (!transporter) {
    console.log(`[Email skipped — not configured] To: ${to} | ${subject}`);
    return false;
  }
  try {
    await transporter.sendMail({
      from: `"IST-Sovereign" <${process.env.EMAIL_USER}>`,
      to, subject, html
    });
    console.log(`✓ Email sent to ${to}`);
    return true;
  } catch(e) {
    console.error('Email error:', e.message);
    return false;
  }
}

// ── Tiers ─────────────────────────────────────────────────────────────────────
const TIERS = {
  TRIAL:        { days: 7,  channels: 1024, label: 'Free Trial',    prefix: 'ISTG', keys: 1 },
  STARTER:      { days: 30, channels: 1024, label: 'Starter',       prefix: 'ISTG', keys: 1 },
  PROFESSIONAL: { days: 30, channels: 1024, label: 'Professional',  prefix: 'ISTG', keys: 3 },
  BUSINESS:     { days: 30, channels: 1024, label: 'Business',      prefix: 'ISTG', keys: 8 },
};
// NOTE: ALL plans use ISTG prefix (Gold) and 1024 channels
// Difference is ONLY number of keys and duration

function makeKey(tier = 'TRIAL', userId = null) {
  const t = TIERS[tier];
  if (!t) throw new Error('Invalid tier');
  const r = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  const keyCode = `${t.prefix}-${r()}-${r()}-${r()}`;
  const now     = new Date();
  const expires = new Date(now.getTime() + t.days * 86400000);
  return {
    keyCode, tier, label: t.label, channels: t.channels,
    createdAt: now.toISOString(), expiresAt: expires.toISOString(),
    status: 'PENDING', hardwareId: null, userId,
    customerName: null, customerEmail: null,
    activatedAt: null, lastSeen: null, notes: null
  };
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'No admin token' });
  try {
    jwt.verify(token, JWT_SECRET + '_admin');
    next();
  } catch {
    res.status(401).json({ error: 'Invalid admin token' });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// USER ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.post('/api/user/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'All fields required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const db = loadDB();
  if (db.users.find(u => u.email === email))
    return res.status(400).json({ error: 'Email already registered' });

  const hashed = await bcrypt.hash(password, 10);
  const user = {
    id: crypto.randomUUID(), name, email,
    password: hashed,
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  saveDB(db);
  logAudit('USER_REGISTER', null, email, req.ip);

  await sendEmail(email, 'Welcome to IST-Sovereign', `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
      <h2 style="color:#1a73e8">Welcome to IST-Sovereign, ${name}!</h2>
      <p>Your account has been created successfully.</p>
      <p>Sign in at <a href="https://ist-sovereign-production.up.railway.app">ist-sovereign-production.up.railway.app</a> to generate your free 7-day trial key.</p>
      <p style="color:#5f6368;font-size:12px">IST-Sovereign | Hyderabad, India | ist.sovereign.support@gmail.com</p>
    </div>
  `);

  res.json({ success: true, message: 'Account created. Please sign in.' });
});

app.post('/api/user/login', async (req, res) => {
  const { email, password } = req.body;
  const db   = loadDB();
  const user = db.users.find(u => u.email === email);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: 'Invalid email or password' });

  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    JWT_SECRET, { expiresIn: '7d' }
  );
  logAudit('USER_LOGIN', null, email, req.ip);
  res.json({ token, user: { name: user.name, email: user.email } });
});

app.post('/api/user/forgot-password', async (req, res) => {
  const { email } = req.body;
  const db   = loadDB();
  const user = db.users.find(u => u.email === email);

  // Always return success (security — don't reveal if email exists)
  res.json({ success: true });

  if (user) {
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpiry = new Date(Date.now() + 3600000).toISOString(); // 1 hour
    user.resetToken  = resetToken;
    user.resetExpiry = resetExpiry;
    saveDB(db);

    const resetUrl = `https://ist-sovereign-production.up.railway.app/reset-password.html?token=${resetToken}`;
    await sendEmail(email, 'IST-Sovereign — Password Reset', `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
        <h2 style="color:#1a73e8">Password Reset Request</h2>
        <p>Click the link below to reset your password. Valid for 1 hour.</p>
        <p><a href="${resetUrl}" style="background:#1a73e8;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">Reset Password</a></p>
        <p>If you did not request this, ignore this email.</p>
        <p style="color:#5f6368;font-size:12px">IST-Sovereign | ist.sovereign.support@gmail.com</p>
      </div>
    `);
  }
});

app.get('/api/user/dashboard', requireAuth, (req, res) => {
  const db      = loadDB();
  const user    = db.users.find(u => u.id === req.user.id);
  const userKeys = db.keys.filter(k => k.userId === req.user.id);
  res.json({
    user: { name: user?.name, email: user?.email },
    keys: userKeys
  });
});

app.post('/api/user/trial', requireAuth, async (req, res) => {
  const db = loadDB();
  const hasTrial = db.keys.find(
    k => k.userId === req.user.id && k.tier === 'TRIAL');
  if (hasTrial)
    return res.status(400).json({
      error: 'You have already used your free trial. Please upgrade to continue.'
    });

  const k = makeKey('TRIAL', req.user.id);
  k.customerEmail = req.user.email;
  k.customerName  = req.user.name;
  db.keys.unshift(k);
  saveDB(db);
  logAudit('TRIAL_GENERATED', k.keyCode, req.user.email, req.ip);

  await sendEmail(req.user.email, 'Your IST-Sovereign 7-Day Trial Key', `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
      <h2 style="color:#1a73e8">Your Free Trial Key</h2>
      <p>Hello ${req.user.name},</p>
      <p>Here is your 7-day trial key:</p>
      <div style="background:#f8f9fa;border:2px dashed #1a73e8;padding:20px;
                  text-align:center;margin:20px 0;border-radius:8px">
        <div style="font-family:monospace;font-size:24px;letter-spacing:3px;
                    color:#1a73e8;font-weight:bold">${k.keyCode}</div>
        <div style="color:#5f6368;font-size:13px;margin-top:8px">
          Valid for 7 days · 1024-channel Gold · Full performance
        </div>
      </div>
      <p><strong>How to use:</strong></p>
      <ol style="color:#5f6368;line-height:2">
        <li>Download IST-Sovereign.exe from your dashboard</li>
        <li>Right-click → Run as Administrator</li>
        <li>Enter this key when prompted</li>
        <li>Enter your target app (e.g. Revit) and press ACTIVATE</li>
      </ol>
      <p>Need help? WhatsApp: +91 77022 49018</p>
      <p style="color:#5f6368;font-size:12px">
        IST-Sovereign | Hyderabad, India | ist.sovereign.support@gmail.com
      </p>
    </div>
  `);

  res.json({ success: true, key: k, keys: generatedKeys, keyCount });
});

// ═════════════════════════════════════════════════════════════════════════════
// PAYMENT ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.post('/api/payment/create-order', requireAuth, async (req, res) => {
  const { tier } = req.body;
  const amounts = { STARTER: 19900, PROFESSIONAL: 49900, BUSINESS: 99900 };
  if (!amounts[tier]) return res.status(400).json({ error: 'Invalid tier' });

  if (!razorpayInstance) {
    return res.status(503).json({
      error: 'Payment gateway not configured',
      fallback: true,
      message: 'Please contact us to purchase: WhatsApp +91 77022 49018'
    });
  }

  try {
    const order = await razorpayInstance.orders.create({
      amount: amounts[tier],
      currency: 'INR',
      receipt: `rcpt_${crypto.randomBytes(4).toString('hex')}`
    });
    res.json({ orderId: order.id, amount: order.amount, currency: 'INR' });
  } catch(e) {
    console.error('Razorpay order error:', e.message);
    res.status(500).json({ error: e.message, fallback: true });
  }
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

  const db       = loadDB();
  const tierInfo = TIERS[tier];
  const keyCount = tierInfo?.keys || 1;
  const generatedKeys = [];

  for (let i = 0; i < keyCount; i++) {
    const k = makeKey(tier, req.user.id);
    k.customerEmail = req.user.email;
    k.customerName  = req.user.name;
    db.keys.unshift(k);
    generatedKeys.push(k);
  }
  saveDB(db);
  logAudit('PAYMENT_SUCCESS', generatedKeys[0].keyCode,
    `${tier} x${keyCount} ${req.user.email}`, req.ip);

  const keyListHtml = generatedKeys.map((k, i) =>
    `<div style="font-family:monospace;font-size:18px;letter-spacing:2px;
     color:#1a73e8;font-weight:bold;margin:8px 0">Key ${i+1}: ${k.keyCode}</div>`
  ).join('');

  const k = generatedKeys[0]; // for response

  await sendEmail(req.user.email, `Your IST-Sovereign ${tierInfo?.label || tier} Keys`, `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
      <h2 style="color:#1a73e8">Payment Successful — ${tier} Plan</h2>
      <p>Thank you for your purchase!</p>
      <div style="background:#f8f9fa;border:2px solid #1a73e8;padding:20px;
                  margin:20px 0;border-radius:8px">
        \${keyListHtml}
        <div style="color:#5f6368;font-size:13px;margin-top:8px;text-align:center">
          \${tierInfo?.label || tier} · 1024-channel Gold · 30 days · \${keyCount} device\${keyCount>1?'s':''}
        </div>
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
  if (!row)
    return res.status(404).json({ error: 'Key not found' });
  if (row.status === 'KILLED')
    return res.status(403).json({ error: 'Key terminated by administrator' });
  if (new Date(row.expiresAt) < new Date())
    return res.status(403).json({ error: 'Key expired — please renew your subscription' });
  if (row.hardwareId && row.hardwareId !== hardwareId)
    return res.status(403).json({
      error: 'Hardware mismatch — this key is locked to another device'
    });

  if (!row.hardwareId) {
    row.hardwareId  = hardwareId;
    row.status      = 'ACTIVE';
    row.activatedAt = new Date().toISOString();
    logAudit('KEY_ACTIVATED', keyCode, `HW: ${hardwareId}`, req.ip);
  }
  row.lastSeen = new Date().toISOString();
  saveDB(db);

  res.json({
    valid: true,
    tier: row.tier,
    channels: TIERS[row.tier]?.channels || 128,
    expiresAt: row.expiresAt,
    label: TIERS[row.tier]?.label || 'Trial'
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
    channels:         TIERS[row.tier]?.channels || 128,
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
    totalKeys:   db.keys.length,
    activeKeys:  db.keys.filter(k => k.status === 'ACTIVE').length,
    trialKeys:   db.keys.filter(k => k.tier   === 'TRIAL').length,
    killedKeys:  db.keys.filter(k => k.status === 'KILLED').length,
    expiredKeys: db.keys.filter(k => k.status !== 'KILLED' && new Date(k.expiresAt) < now).length,
    totalUsers:  db.users.length,
    recentAudit: db.audit.slice(0, 20)
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
          <div style="background:#f8f9fa;border:2px dashed #1a73e8;padding:20px;
                      text-align:center;margin:20px 0;border-radius:8px">
            <div style="font-family:monospace;font-size:24px;letter-spacing:3px;
                        color:#1a73e8;font-weight:bold">${k.keyCode}</div>
            <div style="color:#5f6368;font-size:13px;margin-top:8px">
              ${k.label} · Valid ${TIERS[tier].days} days
            </div>
          </div>
          <p>Download: <a href="https://ist-sovereign-production.up.railway.app">
            ist-sovereign-production.up.railway.app</a></p>
          <p style="color:#5f6368;font-size:12px">
            IST-Sovereign | ist.sovereign.support@gmail.com
          </p>
        </div>
      `);
    }
    res.json({ success: true, key: k });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
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
  logAudit('KEY_REVIVED', req.body.keyCode, 'Revived', req.ip);
  res.json({ success: true });
});

app.post('/api/admin/extend-key', requireAdmin, (req, res) => {
  const { keyCode, days } = req.body;
  const db  = loadDB();
  const row = db.keys.find(k => k.keyCode === keyCode);
  if (!row) return res.status(404).json({ error: 'Key not found' });
  const base = new Date(row.expiresAt) > new Date()
    ? new Date(row.expiresAt) : new Date();
  row.expiresAt = new Date(base.getTime() + days * 86400000).toISOString();
  saveDB(db);
  logAudit('KEY_EXTENDED', keyCode, `+${days} days`, req.ip);
  res.json({ success: true, newExpiry: row.expiresAt });
});

app.get('/api/admin/audit', requireAdmin, (req, res) => {
  res.json({ log: loadDB().audit.slice(0, 100) });
});

// ═════════════════════════════════════════════════════════════════════════════
// START SERVER
// ═════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;

// Init optional services first, then start server
initServices().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(50));
    console.log(`IST-Sovereign Backend running on PORT ${PORT}`);
    console.log('='.repeat(50));
    console.log(`Admin portal : http://localhost:${PORT}/admin.html`);
    console.log(`User site    : http://localhost:${PORT}/`);
    console.log(`Database     : ist_db.json`);
    console.log('');
  });
}).catch(err => {
  console.error('Startup error:', err);
  // Start anyway even if services fail
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`IST-Sovereign running on PORT ${PORT} (reduced mode)`);
  });
});
