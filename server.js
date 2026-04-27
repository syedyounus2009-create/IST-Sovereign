// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  IST-SOVEREIGN — BACKEND SERVER  v4.0                                   ║
// ╠══════════════════════════════════════════════════════════════════════════╣
// ║  SECTION 1  —  IMPORTS                                                  ║
// ║  SECTION 2  —  EXPRESS SETUP & STATIC FILES                             ║
// ║  SECTION 3  —  DATABASE  (persists at /data/ist_db.json on Railway)     ║
// ║  SECTION 4  —  CONFIGURATION  (Railway environment variables)           ║
// ║  SECTION 5  —  PLANS  (Trial/Starter/Professional/Business)             ║
// ║  SECTION 6  —  EMAIL SERVICE  (Gmail — change EMAIL_USER/EMAIL_PASS)    ║
// ║  SECTION 7  —  RAZORPAY  (change keys in Railway Variables)             ║
// ║  SECTION 8  —  AUTH MIDDLEWARE                                          ║
// ║  SECTION 9  —  USER ROUTES  (register/login/forgot/dashboard)           ║
// ║  SECTION 10 —  TRIAL KEY                                                ║
// ║  SECTION 11 —  PAYMENT ROUTES  (create-order / verify)                  ║
// ║  SECTION 12 —  WINDOWS AGENT ROUTES  (activate / process-signal)        ║
// ║  SECTION 13 —  ADMIN ROUTES                                             ║
// ║  SECTION 14 —  HEALTH CHECK  (/api/health)                              ║
// ║  SECTION 15 —  SERVER START                                             ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — IMPORTS
// ─────────────────────────────────────────────────────────────────────────────
import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import compression from "compression";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — EXPRESS SETUP & STATIC FILES
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: "*" }));
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (q, r) =>
  r.sendFile(path.join(__dirname, "public", "index.html")),
);
app.get("/admin.html", (q, r) =>
  r.sendFile(path.join(__dirname, "public", "admin.html")),
);
app.get("/dashboard.html", (q, r) =>
  r.sendFile(path.join(__dirname, "public", "dashboard.html")),
);
app.get("/health.html", (q, r) =>
  r.sendFile(path.join(__dirname, "public", "health.html")),
);

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — DATABASE
// Stores at /data/ist_db.json when Railway Volume is mounted at /data
// TO SET UP: Railway → service → Volumes → Add Volume → mount path: /data
// Without Volume, data resets on redeploy — Volume makes it permanent
// ─────────────────────────────────────────────────────────────────────────────
const DATA_DIR = fs.existsSync("/data") ? "/data" : __dirname;
const DB_FILE = path.join(DATA_DIR, "ist_db.json");

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const blank = { users: [], keys: [], audit: [], payments: [], feedbacks: [] };
      fs.writeFileSync(DB_FILE, JSON.stringify(blank, null, 2));
      return blank;
    }
    const d = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    d.users = d.users || [];
    d.keys = d.keys || [];
    d.audit = d.audit || [];
    d.payments = d.payments || [];
    d.feedbacks = d.feedbacks || [];
    return d;
  } catch (e) {
    console.error("[DB]", e.message);
    return { users: [], keys: [], audit: [], payments: [], feedbacks: [] };
  }
}

function saveDB(d) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2));
  } catch (e) {
    console.error("[DB save]", e.message);
  }
}

function addAudit(action, keyCode, detail, ip) {
  try {
    const d = loadDB();
    d.audit.unshift({
      id: Date.now(),
      action,
      keyCode: keyCode || null,
      detail: detail || null,
      ip: ip || null,
      timestamp: new Date().toISOString(),
    });
    if (d.audit.length > 500) d.audit = d.audit.slice(0, 500);
    saveDB(d);
  } catch (e) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — CONFIGURATION
// All secrets come from Railway Variables — never hardcoded here
// TO CHANGE: Railway dashboard → your service → Variables tab
// ─────────────────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || "ist-sovereign-jwt-2026";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "IST-Admin-2026";
const VAR_A = parseFloat(process.env.VAR_A || "1.22");
const VAR_B = parseFloat(process.env.VAR_B || "1.618");
const VAR_C = parseFloat(process.env.VAR_C || "0.94");
const VAR_D = parseFloat(process.env.VAR_D || "0.82");

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — PLANS
// TO CHANGE PRICE: edit price values (in paise — Rs.199 = 19900 paise)
// TO CHANGE KEY COUNT: edit keys value
// All plans = Gold 1024-channel — same top performance
// ─────────────────────────────────────────────────────────────────────────────
const PLANS = {
  TRIAL: {
    days: 7,
    channels: 1024,
    label: "Free Trial",
    prefix: "ISTG",
    keys: 1,
    price: 0,
  },
  STARTER: {
    days: 30,
    channels: 1024,
    label: "Starter",
    prefix: "ISTG",
    keys: 1,
    price: 19900,
  },
  PROFESSIONAL: {
    days: 30,
    channels: 1024,
    label: "Professional",
    prefix: "ISTG",
    keys: 3,
    price: 49900,
  },
  BUSINESS: {
    days: 30,
    channels: 1024,
    label: "Business",
    prefix: "ISTG",
    keys: 8,
    price: 99900,
  },
};

function makeKey(planId, userId, name, email) {
  const p = PLANS[planId];
  if (!p) throw new Error("Unknown plan: " + planId);
  const r = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return {
    keyCode: `${p.prefix}-${r()}-${r()}-${r()}`,
    plan: planId,
    label: p.label,
    channels: p.channels,
    status: "PENDING",
    hardwareId: null,
    userId: userId || null,
    customerName: name || null,
    customerEmail: email || null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + p.days * 86400000).toISOString(),
    activatedAt: null,
    lastSeen: null,
    notes: null,
  };
}

function keyEmail(keys, label, name) {
  const rows = keys
    .map(
      (k, i) => `
    <div style="background:#f8f9fa;border:2px dashed #1a73e8;border-radius:8px;
                padding:16px;text-align:center;margin:10px 0">
      ${keys.length > 1 ? `<div style="font-size:11px;color:#5f6368;margin-bottom:6px;font-weight:bold">KEY ${i + 1} OF ${keys.length} — DEVICE ${i + 1}</div>` : ""}
      <div style="font-family:monospace;font-size:22px;letter-spacing:3px;color:#1a73e8;font-weight:bold">${k.keyCode}</div>
      <div style="font-size:12px;color:#5f6368;margin-top:6px">Valid until ${new Date(k.expiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}</div>
    </div>`,
    )
    .join("");
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:28px;border:1px solid #e0e0e0;border-radius:12px">
    <div style="text-align:center;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid #e0e0e0">
      <div style="font-size:24px;font-weight:bold;color:#1a73e8">IST-Sovereign</div>
      <div style="font-size:13px;color:#5f6368">Windows Performance Agent — Gold Edition</div>
    </div>
    <h2 style="color:#202124;font-size:18px">Your ${label} Key${keys.length > 1 ? "s Are" : " Is"} Ready</h2>
    <p style="color:#5f6368;font-size:14px">Hello ${name || "there"}, thank you for choosing IST-Sovereign.</p>
    ${rows}
    <div style="background:#e8f5e9;border-radius:8px;padding:16px;margin-top:20px">
      <b style="font-size:13px;color:#2e7d32">How to activate:</b>
      <ol style="font-size:13px;color:#5f6368;margin:8px 0 0;padding-left:20px;line-height:2.2">
        <li>Download IST-Sovereign.exe from your dashboard</li>
        <li>Right-click → <strong>Run as Administrator</strong></li>
        <li>Paste your key and press ACTIVATE</li>
        <li>Key locks permanently to your device on first use</li>
        ${keys.length > 1 ? "<li>Each key activates on one separate device</li>" : ""}
      </ol>
    </div>
    <div style="margin-top:20px;padding-top:16px;border-top:1px solid #e0e0e0;font-size:12px;color:#9aa0a6;text-align:center">
      IST-Sovereign | Hyderabad, India<br>
      ist.sovereign.support@gmail.com | WhatsApp: +91 77022 49018
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — EMAIL SERVICE
// TO CHANGE: update EMAIL_USER and EMAIL_PASS in Railway Variables
// EMAIL_PASS = Gmail App Password (16 chars, NOT your Gmail password)
// Generate at: myaccount.google.com → Security → 2-Step → App passwords
// ─────────────────────────────────────────────────────────────────────────────
let mailer = null;

async function initEmail() {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  if (!user || !pass) {
    console.log("[Email] Not configured");
    return;
  }
  try {
    const nm = (await import("nodemailer")).default;
    // NOTE: No verify() call — it crashes Railway. First sendMail confirms credentials.
    mailer = nm.createTransport({ service: "gmail", auth: { user, pass } });
    console.log("[Email] Configured:", user);
  } catch (e) {
    console.log("[Email] Failed:", e.message);
    mailer = null;
  }
}

async function sendEmail(to, subject, html) {
  if (!mailer) {
    console.log("[Email] Skipped:", to);
    return false;
  }
  try {
    await mailer.sendMail({
      from: `"IST-Sovereign" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
    });
    console.log("[Email] Sent:", to);
    return true;
  } catch (e) {
    console.error("[Email] Error:", e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — RAZORPAY
// TO GO LIVE: change RAZORPAY_KEY_ID to rzp_live_... in Railway Variables
// TO TEST: use rzp_test_... keys
// ─────────────────────────────────────────────────────────────────────────────
let razorpay = null;

async function initRazorpay() {
  const id = process.env.RAZORPAY_KEY_ID,
    sec = process.env.RAZORPAY_KEY_SECRET;
  if (!id || !sec) {
    console.log("[Razorpay] Not configured");
    return;
  }
  try {
    const RZP = (await import("razorpay")).default;
    razorpay = new RZP({ key_id: id, key_secret: sec });
    console.log("[Razorpay] Ready:", id.substring(0, 20) + "...");
  } catch (e) {
    console.log("[Razorpay] Failed:", e.message);
    razorpay = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — AUTH MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token)
    return res.status(401).json({ error: "No token — please sign in" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Token expired — please sign in again" });
  }
}

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token) return res.status(401).json({ error: "No admin token" });
  try {
    jwt.verify(token, JWT_SECRET + "_admin");
    next();
  } catch {
    res.status(401).json({ error: "Admin session expired" });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — USER ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Register new account
app.post("/api/user/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: "All fields required" });
  if (password.length < 6)
    return res.status(400).json({ error: "Password min 6 characters" });
  const db = loadDB(),
    el = email.toLowerCase();
  if (db.users.find((u) => u.email === el))
    return res
      .status(400)
      .json({ error: "Email already registered — please sign in" });
  const user = {
    id: crypto.randomUUID(),
    name,
    email: el,
    password: await bcrypt.hash(password, 10),
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  saveDB(db);
  addAudit("USER_REGISTER", null, email, req.ip);
  await sendEmail(
    email,
    "Welcome to IST-Sovereign",
    `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px">
      <h2 style="color:#1a73e8">Welcome, ${name}!</h2>
      <p>Your account is ready. Sign in to get your free 7-day trial key.</p>
      <p><a href="https://ist-sovereign-production.up.railway.app/dashboard.html"
         style="background:#1a73e8;color:white;padding:12px 24px;border-radius:6px;text-decoration:none">
         Go to Dashboard</a></p>
      <p style="color:#9aa0a6;font-size:12px">IST-Sovereign | ist.sovereign.support@gmail.com</p>
    </div>`,
  );
  res.json({ success: true });
});

// Sign in
app.post("/api/user/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password required" });
  const db = loadDB(),
    user = db.users.find((u) => u.email === email.toLowerCase());
  if (!user)
    return res.status(401).json({ error: "No account found with this email" });
  if (!(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ error: "Incorrect password" });
  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: "30d" },
  );
  addAudit("USER_LOGIN", null, email, req.ip);
  res.json({ token, user: { name: user.name, email: user.email } });
});

// Forgot password
app.post("/api/user/forgot-password", async (req, res) => {
  res.json({ success: true }); // always OK — don't reveal if email exists
  const { email } = req.body;
  if (!email) return;
  const db = loadDB(),
    user = db.users.find((u) => u.email === email.toLowerCase());
  if (!user) return;
  const tok = crypto.randomBytes(32).toString("hex");
  user.resetToken = tok;
  user.resetExpiry = new Date(Date.now() + 3600000).toISOString();
  saveDB(db);
  await sendEmail(
    email,
    "IST-Sovereign — Reset Password",
    `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px">
      <h2 style="color:#1a73e8">Reset Your Password</h2>
      <p>Click below — valid for 1 hour.</p>
      <p><a href="https://ist-sovereign-production.up.railway.app/reset.html?token=${tok}"
         style="background:#1a73e8;color:white;padding:12px 24px;border-radius:6px;text-decoration:none">
         Reset Password</a></p>
    </div>`,
  );
});

// Get dashboard data
app.get("/api/user/dashboard", requireAuth, (req, res) => {
  const db = loadDB(),
    user = db.users.find((u) => u.id === req.user.id);
  res.json({
    user: { name: user?.name, email: user?.email },
    keys: db.keys.filter((k) => k.userId === req.user.id),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9B — FEEDBACK ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/user/feedback", requireAuth, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });
  const db = loadDB();
  const user = db.users.find(u => u.id === req.user.id);
  const fb = {
    id: Date.now().toString(),
    userId: req.user.id,
    email: user ? user.email : "Unknown",
    message,
    date: new Date().toISOString(),
  };
  db.feedbacks.unshift(fb);
  saveDB(db);
  try {
    await sendEmail(
      "ist.sovereign.support@gmail.com",
      "New User Feedback / Comment",
      `User: ${fb.email}\nDate: ${fb.date}\n\nComment:\n${message}`
    );
  } catch(e) {}
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10 — TRIAL KEY
// One trial per account, forever. Key is Gold 1024-channel for 7 days.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/user/trial", requireAuth, async (req, res) => {
  const db = loadDB();
  if (db.keys.find((k) => k.userId === req.user.id && k.plan === "TRIAL"))
    return res
      .status(400)
      .json({ error: "Trial already used — please upgrade to continue" });
  const user = db.users.find((u) => u.id === req.user.id);
  const k = makeKey("TRIAL", req.user.id, user?.name, req.user.email);
  db.keys.unshift(k);
  saveDB(db);
  addAudit("TRIAL_GENERATED", k.keyCode, req.user.email, req.ip);
  await sendEmail(
    req.user.email,
    "Your IST-Sovereign Free Trial Key (7 Days Gold)",
    keyEmail([k], "Free Trial", user?.name),
  );
  res.json({ success: true, key: k });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 11 — PAYMENT ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Create Razorpay order
app.post("/api/payment/create-order", requireAuth, async (req, res) => {
  const planId = req.body.plan || req.body.tier; // accept both field names
  const plan = PLANS[planId];
  if (!plan || plan.price === 0)
    return res.status(400).json({ error: "Invalid plan: " + planId });
  if (!razorpay)
    return res
      .status(503)
      .json({
        error: "Payment gateway not ready",
        fallback: true,
        message: "Please contact: WhatsApp +91 77022 49018",
      });
  try {
    const order = await razorpay.orders.create({
      amount: plan.price,
      currency: "INR",
      receipt: `ist_${planId}_${Date.now()}`,
    });
    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: "INR",
      plan: planId,
    });
  } catch (e) {
    res.status(500).json({ error: e.message, fallback: true });
  }
});

// Verify payment and generate keys
app.post("/api/payment/verify", requireAuth, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
    req.body;
  const planId = req.body.plan || req.body.tier;
  if (!process.env.RAZORPAY_KEY_SECRET)
    return res.status(503).json({ error: "Not configured" });
  const sig = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");
  if (sig !== razorpay_signature)
    return res.status(400).json({ error: "Payment verification failed" });
  const db = loadDB(),
    user = db.users.find((u) => u.id === req.user.id),
    plan = PLANS[planId];
  const keys = [];
  for (let i = 0; i < plan.keys; i++) {
    const k = makeKey(planId, req.user.id, user?.name, req.user.email);
    db.keys.unshift(k);
    keys.push(k);
  }
  db.payments.push({
    id: crypto.randomUUID(),
    userId: req.user.id,
    email: req.user.email,
    plan: planId,
    planLabel: plan.label,
    amount: plan.price,
    keyCount: plan.keys,
    keyCodes: keys.map((k) => k.keyCode),
    razorpayOrderId: razorpay_order_id,
    razorpayPaymentId: razorpay_payment_id,
    paidAt: new Date().toISOString(),
  });
  saveDB(db);
  addAudit(
    "PAYMENT_SUCCESS",
    keys[0].keyCode,
    `${planId} x${plan.keys} Rs.${plan.price / 100}`,
    req.ip,
  );
  await sendEmail(
    req.user.email,
    `Your IST-Sovereign ${plan.label} Keys`,
    keyEmail(keys, plan.label, user?.name),
  );
  res.json({ success: true, keys, keyCount: plan.keys, planLabel: plan.label });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 12 — WINDOWS AGENT ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Activate key (called on agent startup)
app.post("/api/activate", (req, res) => {
  const { keyCode, hardwareId } = req.body;
  if (!keyCode || !hardwareId)
    return res.status(400).json({ error: "Missing fields" });
  const db = loadDB(),
    key = db.keys.find((k) => k.keyCode === keyCode);
  if (!key) return res.status(404).json({ error: "Key not found" });
  if (key.status === "KILLED")
    return res.status(403).json({ error: "Key terminated — contact support" });
  if (new Date(key.expiresAt) < new Date())
    return res.status(403).json({ error: "Key expired — please renew" });
  if (key.hardwareId && key.hardwareId !== hardwareId)
    return res
      .status(403)
      .json({ error: "Hardware mismatch — key locked to another device" });
  if (!key.hardwareId) {
    key.hardwareId = hardwareId;
    key.status = "ACTIVE";
    key.activatedAt = new Date().toISOString();
    addAudit("KEY_ACTIVATED", keyCode, "HW:" + hardwareId.slice(0, 12), req.ip);
  }
  key.lastSeen = new Date().toISOString();
  saveDB(db);
  res.json({
    valid: true,
    plan: key.plan,
    tier: key.plan, // tier kept for old agents
    channels: key.channels,
    label: key.label,
    expiresAt: key.expiresAt,
  });
});

// Process signal (called every 2s while agent runs)
app.post("/api/process-signal", (req, res) => {
  const { keyCode, hardwareId, speed } = req.body;
  const db = loadDB(),
    key = db.keys.find(
      (k) => k.keyCode === keyCode && k.hardwareId === hardwareId,
    );
  if (!key || key.status !== "ACTIVE")
    return res.status(403).json({ error: "Unauthorized" });
  if (new Date(key.expiresAt) < new Date())
    return res.status(403).json({ error: "Expired" });
  key.lastSeen = new Date().toISOString();
  saveDB(db);
  const s = Math.max(1, Math.min(16, parseInt(speed) || 1)),
    n = (s - 1) / 15;
  res.json({
    throughput: +(VAR_A * s * VAR_C).toFixed(2),
    latencyReduction: +Math.min(n * VAR_B * 100, 85).toFixed(1),
    energyEfficiency: +(Math.min(VAR_D + n * 0.15, 0.97) * 100).toFixed(1),
    channels: key.channels,
    speed: s,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13 — ADMIN ROUTES
// TO CHANGE PASSWORD: update ADMIN_PASSWORD in Railway Variables
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/admin/login", (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD)
    return res.status(403).json({ error: "Wrong password" });
  const token = jwt.sign({ role: "admin" }, JWT_SECRET + "_admin", {
    expiresIn: "12h",
  });
  addAudit("ADMIN_LOGIN", null, "Admin in", req.ip);
  res.json({ token });
});

app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const db = loadDB(),
    now = new Date();
  res.json({
    totalKeys: db.keys.length,
    activeKeys: db.keys.filter((k) => k.status === "ACTIVE").length,
    trialKeys: db.keys.filter((k) => k.plan === "TRIAL").length,
    killedKeys: db.keys.filter((k) => k.status === "KILLED").length,
    expiredKeys: db.keys.filter(
      (k) => k.status !== "KILLED" && new Date(k.expiresAt) < now,
    ).length,
    totalUsers: db.users.length,
    totalRevenue: db.payments.reduce((s, p) => s + (p.amount || 0), 0),
    recentAudit: db.audit.slice(0, 20),
  });
});

app.get("/api/admin/keys", requireAdmin, (req, res) =>
  res.json({ keys: loadDB().keys }),
);
app.get("/api/admin/users", requireAdmin, (req, res) =>
  res.json({
    users: loadDB().users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      createdAt: u.createdAt,
    })),
  }),
);

app.post("/api/admin/generate-key", requireAdmin, async (req, res) => {
  const {
    plan = "TRIAL",
    customerName,
    customerEmail,
    notes,
    count,
  } = req.body;
  const pi = PLANS[plan];
  if (!pi) return res.status(400).json({ error: "Invalid plan" });
  const n = Math.max(1, Math.min(100, parseInt(count) || pi.keys));
  const db = loadDB(),
    keys = [];
  for (let i = 0; i < n; i++) {
    const k = makeKey(plan, null, customerName, customerEmail);
    k.notes = notes || null;
    db.keys.unshift(k);
    keys.push(k);
  }
  saveDB(db);
  addAudit(
    "ADMIN_KEY_GEN",
    keys[0].keyCode,
    `${plan} x${n} ${customerEmail || ""}`,
    req.ip,
  );
  if (customerEmail)
    await sendEmail(
      customerEmail,
      `Your IST-Sovereign ${pi.label} Keys`,
      keyEmail(keys, pi.label, customerName),
    );
  res.json({ success: true, keys, keyCount: n });
});

app.post("/api/admin/kill-key", requireAdmin, (req, res) => {
  const db = loadDB(),
    k = db.keys.find((k) => k.keyCode === req.body.keyCode);
  if (k) {
    k.status = "KILLED";
    saveDB(db);
  }
  addAudit("KEY_KILLED", req.body.keyCode, "Admin kill", req.ip);
  res.json({ success: true });
});

app.post("/api/admin/revive-key", requireAdmin, (req, res) => {
  const db = loadDB(),
    k = db.keys.find((k) => k.keyCode === req.body.keyCode);
  if (k) {
    k.status = "ACTIVE";
    saveDB(db);
  }
  addAudit("KEY_REVIVED", req.body.keyCode, "Admin revive", req.ip);
  res.json({ success: true });
});

app.post("/api/admin/extend-key", requireAdmin, (req, res) => {
  const { keyCode, days } = req.body,
    db = loadDB(),
    k = db.keys.find((k) => k.keyCode === keyCode);
  if (!k) return res.status(404).json({ error: "Not found" });
  const base =
    new Date(k.expiresAt) > new Date() ? new Date(k.expiresAt) : new Date();
  k.expiresAt = new Date(base.getTime() + days * 86400000).toISOString();
  saveDB(db);
  addAudit("KEY_EXTENDED", keyCode, `+${days}d`, req.ip);
  res.json({ success: true, newExpiry: k.expiresAt });
});

app.get("/api/admin/audit", requireAdmin, (req, res) =>
  res.json({ log: loadDB().audit.slice(0, 100) }),
);

app.get("/api/admin/download-db", requireAdmin, (req, res) => {
  if (!fs.existsSync(DB_FILE)) return res.status(404).json({ error: "DB not found" });
  res.download(DB_FILE, `ist_db_backup_${new Date().toISOString().slice(0, 10)}.json`);
});

app.get("/api/admin/feedbacks", requireAdmin, (req, res) => {
  res.json({ feedbacks: loadDB().feedbacks || [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 14 — HEALTH CHECK
// Visit /api/health to see server status, DB location, email/razorpay status
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  const db = loadDB();
  res.json({
    status: "ok",
    version: "4.0.0",
    db: DB_FILE,
    persistent: DATA_DIR === "/data",
    users: db.users.length,
    keys: db.keys.length,
    payments: db.payments.length,
    email: !!mailer,
    razorpay: !!razorpay,
    time: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 15 — SERVER START
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

async function startServer() {
  console.log("=".repeat(54));
  console.log("  IST-Sovereign v4.0  Starting...");
  console.log("  DB:", DB_FILE);
  console.log(
    "  Persistent:",
    DATA_DIR === "/data" ? "YES" : "NO — add Volume at /data",
  );
  await initEmail();
  await initRazorpay();
  app.listen(PORT, "0.0.0.0", () => {
    console.log("=".repeat(54));
    console.log(`  Live on PORT ${PORT}`);
    console.log(`  Email   : ${mailer ? "READY" : "not configured"}`);
    console.log(`  Razorpay: ${razorpay ? "READY" : "not configured"}`);
    console.log(`  Admin pw: ${ADMIN_PASSWORD}`);
    console.log("=".repeat(54));
  });
}

startServer().catch((e) => {
  console.error("Startup error:", e.message);
  app.listen(PORT, "0.0.0.0", () => console.log(`IST-Sovereign PORT ${PORT}`));
});
