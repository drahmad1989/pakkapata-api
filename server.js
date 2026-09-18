/**
 * GeoPata — Main Server Entry Point (v0.2.0)
 *
 * Starts an Express server with:
 *   - Helmet        (security headers)
 *   - CORS          (open by default; tighten in production)
 *   - Rate limiting  (100 req / 15 min / IP on /api/)
 *   - JSON body parser
 *   - Auto-init SQLite DB + schema + seed default admin
 *
 *   Mounted REST APIs:
 *     Public:
 *       GET    /api/health
 *       POST   /api/auth/login
 *       POST   /api/auth/refresh
 *       GET    /api/public/address/:code   (privacy-safe lookup, no auth)
 *       GET    /uploads/verify/*           (verification photos, static)
 *
 *     JWT or API Key (shared — SikkaChat uses API key, admins use JWT):
 *       POST   /api/address
 *       GET    /api/address/:code
 *       POST   /api/occupant
 *       GET    /api/radius
 *       GET    /api/entrance/by-nfc/:nfcTagId
 *
 *     JWT only (admin/verifier/viewer):
 *       POST   /api/auth/logout
 *       GET    /api/auth/me
 *       PUT    /api/auth/password
 *       GET    /api/addresses
 *       PUT    /api/address/:code        (verifier+)
 *       POST   /api/verify/:code         (verifier+)
 *       PATCH  /api/entrance/:id/lifecycle (verifier+)
 *       POST   /api/entrance/:id/nfc     (verifier+)
 *       DELETE /api/entrance/:id/nfc     (verifier+)
 *
 *     JWT admin only:
 *       /api/admin/admins   (CRUD + reset-password)
 *       /api/admin/api-keys (CRUD + toggle)
 *       /api/admin/audit    (list)
 *
 *   - Centralized error handler + 404 fallback
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const addressRoutes = require('./src/routes/addressRoutes');
const entranceRoutes = require('./src/routes/entranceRoutes');
const verifyRoutes = require('./src/routes/verifyRoutes');
const occupantRoutes = require('./src/routes/occupantRoutes');
const geoRoutes = require('./src/routes/geoRoutes');
const authRoutes = require('./src/routes/authRoutes');
const adminRoutes = require('./src/routes/adminRoutes');
const seedRoutes = require('./src/routes/seedRoutes');
const areaRoutes = require('./src/routes/areaRoutes');
const villageBoundaryRoutes = require('./src/routes/villageBoundaryRoutes');
const publicRoutes = require('./src/routes/publicRoutes');
const paymentRoutes = require('./src/routes/paymentRoutes');
const contractRoutes = require('./src/routes/contractRoutes');
const { notFound, errorHandler } = require('./src/middleware/errorHandler');

// Initialize DB connection + auto-create tables + seed admin
const db = require('./src/config/database');
const geoService = require('./src/services/geoService');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// Security middleware
// ─────────────────────────────────────────────
app.use(helmet());
app.use(cors());

// ─────────────────────────────────────────────
// v0.10.1: SMART rate limiting — har traffic type ka APNA budget.
//
// BUGFIX (user report: "Too many requests" dashboard :3002 par):
// pehle general 100/15min limiter SAB /api/ requests pr lagta tha —
// dashboard ka JWT traffic (page loads + polling) usi bucket ko bhar
// raha tha, to 15 min mein hi RATE_LIMIT_EXCEEDED mil jata tha.
//
// Ab ek selector middleware pehle traffic type pehchanta hai aur
// request sirf usi limiter se count hoti hai:
//   valid X-API-Key            → apiKeyLimiter    (2000/15min/IP)
//   Authorization: Bearer JWT  → dashboardLimiter (1000/15min/IP)
//   anonymous / fake key       → generalLimiter   (100/15min/IP)
//
// GET /api/health bilkul free — login pill, bat smoke-test aur uptime
// probes isko poll karte hain (rate-limit se banda nahi hona chahiye).
// Fake/invalid keys general budget mein rehti hain (DoS-safe).
// ─────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests, please try again later.',
  },
});

// v0.10.1: dashboard/browser JWT traffic — 1000/15min/IP. Page loads,
// polling aur proactive refresh aaram se is budget mein rehte hain.
const dashboardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests, please try again later.',
  },
});

const apiKeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000, // ~2.2 req/s sustained per IP — enough for RabtaChat server proxying
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'API key rate limit exceeded (2000 req / 15 min). Add caching on GET lookups.',
  },
});

// v0.10.4: payment gateway webhooks — signature-verified anonymous traffic.
// Gateway IPs fix nahi hote aur retries karte hain — general 100/15min unhe
// block kar deta; alag budget (300/15min) di hai. GS contract calls valid
// API key ke saath aati hain to khud apiKeyLimiter (2000) mein count hoti hain.
const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Webhook rate limit exceeded (300 req / 15 min / IP).',
  },
});

// API-key validity cache (60s) — har request pr DB hit na lage
const { sha256 } = require('./src/services/authService');
const apiKeyRateCache = new Map(); // keyHash -> { ok: boolean, expires: epochMs }
const API_KEY_RATE_TTL_MS = 60 * 1000;

function isKnownActiveApiKey(fullKey) {
  if (!fullKey || typeof fullKey !== 'string' || fullKey.length < 16) return false;
  const keyHash = sha256(fullKey);
  const now = Date.now();
  const cached = apiKeyRateCache.get(keyHash);
  if (cached && cached.expires > now) return cached.ok;
  let ok = false;
  try {
    const row = db.prepare('SELECT key_id FROM api_keys WHERE key_hash = ? AND is_active = 1').get(keyHash);
    ok = !!row;
  } catch (err) {
    ok = false; // DB not ready → treat as unknown, still rate-limited (safe default)
  }
  apiKeyRateCache.set(keyHash, { ok, expires: now + API_KEY_RATE_TTL_MS });
  return ok;
}

// Selector: traffic type dekho, phir sirf usi ka limiter lagao.
app.use('/api/', (req, res, next) => {
  if (req.path === '/health') return next(); // v0.10.1: health probe free
  if (req.path.startsWith('/payments/webhook/')) return webhookLimiter(req, res, next); // v0.10.4: gateway webhooks apna budget

  const key = req.headers['x-api-key'] || req.query.api_key || null;
  if (key) {
    if (isKnownActiveApiKey(key)) return apiKeyLimiter(req, res, next);
    return generalLimiter(req, res, next); // fake/invalid key → general (DoS-safe)
  }

  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  // 'Bearer sk_live_...' (galat usage) ko dashboard budget NAHI milta — general.
  if (bearer && !bearer.startsWith('sk_')) return dashboardLimiter(req, res, next);

  return generalLimiter(req, res, next);
});

// ─────────────────────────────────────────────
// Stacked, path-specific limiters (additional budgets on top of the
// selector above — sirf apne paths pr, sab auth types ke liye)
// ─────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // 20 login attempts per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many login attempts. Please try again later.',
  },
});
app.use('/api/auth/login', authLimiter);

// v0.8.1: refresh gets its OWN, larger budget — the dashboard proactively
// refreshes the access token (~every 13 min per open tab) and must never
// collide with the strict login budget.
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many refresh attempts. Please login again.',
  },
});
app.use('/api/auth/refresh', refreshLimiter);

// v0.10.0: OTP endpoints — apna chhota budget (SMS-cost + brute-force guard).
// Per-phone cooldown/rate-limit otpService mein bhi hai; ye IP-level hai.
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many OTP attempts. Please try again later.',
  },
});
app.use('/api/auth/otp', otpLimiter);

// Public lookup limiter — no-auth endpoints get a stricter cap
// (30 lookups / 15 min / IP). Runs IN ADDITION to the general limiter.
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many public lookups from this IP. Please try again later.',
  },
});
app.use('/api/public', publicLimiter);

// v0.10.7: Mashwara Box — public suggestion submit ka apna strict budget.
// (POST /api/public/suggest — villagers ek shared NAT ke peeche ho sakte hain
// isliye 10/15min generous but spam-safe; duplicate-content guard bhi hai)
const suggestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Bohat zyada mashwaray is IP se. Thori dair baad koshish karein. / Too many suggestions from this IP.',
  },
});
app.use('/api/public/suggest', (req, res, next) => {
  if (req.method === 'POST') return suggestLimiter(req, res, next);
  next(); // GET search public budget (30/15min) mein count hota hai
});

// Body parsing (5mb — bulk address import sends up to 5000 rows)
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Simple request logger (dev only)
if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    const auth = req.headers.authorization ? ' [auth]' : '';
    const apiKey = req.headers['x-api-key'] ? ' [key]' : '';
    // eslint-disable-next-line no-console
    console.log(`${new Date().toISOString()}  ${req.method}  ${req.originalUrl}${auth}${apiKey}`);
    next();
  });
}

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────

// Public
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'pakkapata',
    version: '0.10.10',
    h3_resolution: geoService.H3_RESOLUTION,
    timestamp: new Date().toISOString(),
  });
});

// Auth (public login + refresh; JWT-protected me/logout/password)
app.use('/api/auth', authRoutes);

// Admin (JWT + admin role)
app.use('/api/admin', adminRoutes);

// Pakistan seed dashboard (v0.9.0 — JWT + admin role, background job + progress)
app.use('/api/admin/seed-pakistan', seedRoutes);

// Address CRUD (JWT or API key)
app.use('/api/address', addressRoutes);

// Entrance management (JWT verifier+ for mutations; JWT or API key for NFC lookup)
app.use('/api/entrance', entranceRoutes);

// Verify + list + area assignment (JWT only)
app.use('/api', verifyRoutes);

// Occupant (JWT or API key:write)
app.use('/api/occupant', occupantRoutes);

// Radius search (JWT or API key:read)
app.use('/api', geoRoutes);

// Areas (JWT or API key:read for GET; JWT admin for mutations)
app.use('/api/areas', areaRoutes);

// Village Boundaries (v0.4.2) — polygon-based block detection
app.use('/api/village-boundaries', villageBoundaryRoutes);

// Public lookup (v0.7.0) — unauthenticated, privacy-safe address lookup
app.use('/api/public', publicRoutes);

// Payments & GS issuance (v0.10.4) — JazzCash/Easypaisa webhooks + GS contract
app.use('/api', paymentRoutes);

// GS settlement contract (v0.10.9) — RabtaChat server-to-server (ping/payments/confirm)
app.use('/api/contract', contractRoutes);

// Verification photos (v0.7.0) — static serving of field-verification uploads
// Filenames contain timestamp + code, unguessable; no auth for image fetch.
app.use('/uploads/verify', express.static(path.resolve(process.cwd(), 'public/uploads/verify'), {
  maxAge: '7d',
  fallthrough: false,
}));

// Mashwara Box photos (v0.10.7) — public suggestion photos, random unguessable
// filenames (sug_<24hex>.jpg), no auth for image fetch (admin panel embeds URL).
app.use('/uploads/suggestions', express.static(path.resolve(process.cwd(), 'public/uploads/suggestions'), {
  maxAge: '7d',
  fallthrough: false,
}));

// ─────────────────────────────────────────────
// Fallback + error handlers (must be last)
// ─────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`🚀 PakkaPata Server v0.10.7 running on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`   H3 resolution: ${geoService.H3_RESOLUTION}`);
  // eslint-disable-next-line no-console
  console.log(`   Database: ${process.env.DB_PATH || './geopata.db'}`);
  // eslint-disable-next-line no-console
  console.log(`   Docs: POST /api/auth/login with admin/admin123 to start`);

  // v0.8.1: session-survival diagnostics — loud, actionable warnings.
  if (!process.env.JWT_SECRET) {
    // eslint-disable-next-line no-console
    console.warn('⚠️  JWT_SECRET NOT SET — using an ephemeral secret.');
    // eslint-disable-next-line no-console
    console.warn('   Har server restart par saare login sessions INVALID ho jayengi');
    // eslint-disable-next-line no-console
    console.warn('   (dashboard bar bar login maangega). Fix: copy .env.example → .env');
    // eslint-disable-next-line no-console
    console.warn('   and set a 32+ char JWT_SECRET, then restart.');
  } else {
    // eslint-disable-next-line no-console
    console.log('   Session: access token 15m · refresh token 7d (auto-renewed by dashboard)');
  }
});

// Clean shutdown
process.on('SIGINT', () => {
  // eslint-disable-next-line no-console
  console.log('\n👋 Shutting down GeoPata server...');
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});

module.exports = app;
