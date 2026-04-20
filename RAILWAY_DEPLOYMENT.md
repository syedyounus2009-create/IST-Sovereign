# IST-Sovereign — Railway Only Deployment Guide
# Everything runs from ONE server. No Vercel needed.
# ════════════════════════════════════════════════════════════

## WHY RAILWAY ONLY (not split between Vercel + Railway)
# ─────────────────────────────────────────────────────────
# Split setup problems:
#   - Two deployments to manage and update
#   - Cross-origin API errors (CORS issues)
#   - Two bills instead of one
#   - Confusing URLs to manage
#
# Railway-only solution:
#   - ONE server serves website AND API
#   - ONE URL for everything
#   - ONE deployment to manage
#   - $5/month total
#   - Zero CORS issues (same origin)

## YOUR FINAL FOLDER STRUCTURE
# ─────────────────────────────
# Create exactly this on your laptop, then upload to GitHub:

IST-SOVEREIGN/
├── server.js                    ← Backend (serves website + API)
├── package.json                 ← Node dependencies
├── .env                         ← YOUR SECRETS (never on GitHub)
├── .gitignore                   ← Blocks secrets from GitHub
│
└── public/                      ← Everything Railway will serve
    ├── index.html               ← Main website (dark/light theme)
    ├── dashboard.html           ← Customer My Account page
    ├── admin.html               ← Your private admin portal
    └── IST-Sovereign.exe        ← Windows agent download

## WHAT EACH URL DOES ON RAILWAY
# ─────────────────────────────────
# https://your-app.up.railway.app/              → index.html
# https://your-app.up.railway.app/dashboard.html → dashboard
# https://your-app.up.railway.app/admin.html    → admin portal
# https://your-app.up.railway.app/IST-Sovereign.exe → EXE download
# https://your-app.up.railway.app/api/...       → all API routes

## STEP 1 — PREPARE YOUR GITHUB REPO
# ─────────────────────────────────────
# Go to github.com/syedyounus2009-create/IST-Sovereign
# Make sure these files are there (and nothing else sensitive):
#
# ✓ server.js
# ✓ package.json
# ✓ .gitignore
# ✓ public/index.html
# ✓ public/dashboard.html
# ✓ public/admin.html
# ✓ public/IST-Sovereign.exe
#
# ✗ DO NOT upload: .env, ist_db.json, node_modules

## STEP 2 — DEPLOY TO RAILWAY
# ─────────────────────────────
# 1. Go to railway.app → Sign in with GitHub
# 2. Click "New Project"
# 3. Click "Deploy from GitHub repo"
# 4. Select "IST-Sovereign" repository
# 5. Railway detects Node.js automatically
# 6. Click "Variables" tab and add EVERY line from your .env:

RAZORPAY_KEY_ID=rzp_test_Se9gXNic02I9UW
RAZORPAY_KEY_SECRET=FFOZj7J6tKjtKOdmwymjalgT
EMAIL_USER=ist.sovereign.support@gmail.com
EMAIL_PASS=uawv nurz ghjk swez
JWT_SECRET=ist-sovereign-secure-jwt-2026-hyderabad-syed-younus
ADMIN_PASSWORD=IST-Admin-2026
VAR_A=1.22
VAR_B=1.618
VAR_C=0.94
VAR_D=0.82

# 7. Under Settings → add Start Command: node server.js
# 8. Click Deploy
# 9. Wait 2 minutes
# 10. Railway gives you: https://ist-sovereign-production.up.railway.app

## STEP 3 — UPDATE THE AGENT EXE
# ─────────────────────────────────
# Open agent_gui.py — find line:
#   API_URL = "http://localhost:3001"
# Change to:
#   API_URL = "https://ist-sovereign-production.up.railway.app"
# Rebuild the EXE with BUILD_EXE.bat
# Upload new IST-Sovereign.exe to GitHub public/ folder

## STEP 4 — DELETE VERCEL (optional)
# ────────────────────────────────────
# Once Railway is live and working:
# - Test your Railway URL in browser
# - Test sign in, trial key generation, EXE download
# - If all working, you can delete the Vercel project
# - Railway is now your only server

## STEP 5 — RAZORPAY LIVE KEYS (when ready)
# ───────────────────────────────────────────
# Current: rzp_test_... = test mode, no real money
# To go live:
# 1. razorpay.com → Settings → Bank Account
# 2. Add: Account Number, IFSC, Bank Name
# 3. Complete KYC: Aadhaar + PAN card
# 4. Get rzp_live_... keys
# 5. Update in Railway Variables (not in any file)

## STEP 6 — CUSTOM DOMAIN (when you buy ist-sovereign.com)
# ──────────────────────────────────────────────────────────
# Railway → Your project → Settings → Domains
# Click "Add Custom Domain"
# Enter: ist-sovereign.com
# Railway gives you DNS records
# In your domain registrar (Google Domains):
#   Add the CNAME record Railway provides
# Within 24 hours: ist-sovereign.com works

## PACKAGE.JSON — must have this exactly
# ────────────────────────────────────────
# {
#   "name": "ist-sovereign-backend",
#   "version": "1.0.0",
#   "type": "module",
#   "scripts": {
#     "start": "node server.js"
#   },
#   "dependencies": {
#     "bcryptjs": "^2.4.3",
#     "cors": "^2.8.5",
#     "express": "^4.18.0",
#     "jsonwebtoken": "^9.0.0",
#     "nodemailer": "^6.9.0",
#     "razorpay": "^2.9.0"
#   }
# }

