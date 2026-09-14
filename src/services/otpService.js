/**
 * GeoPata — OTP Service (v0.10.0)
 *
 * Phone OTP login for field staff (verifier / viewer roles).
 * Codes are 6 digits, hashed (SHA-256) at rest, single-use, 5-minute TTL.
 *
 * Security model:
 *   - Previous unconsumed codes are invalidated on each new request
 *   - 60s resend cooldown per phone
 *   - Max 3 OTP requests per phone per 10 min (SMS-cost + abuse guard)
 *   - Max 5 wrong attempts per code, then it is burned
 *   - IP-level rate limiting lives in server.js (otpLimiter)
 *
 * Delivery: SMS gateway is not wired yet — codes print to the server
 * console (see deliverOtp). A real SMS provider plugs in THERE only.
 */

const crypto = require('crypto');
const { HttpError } = require('../middleware/errorHandler');
const { prepare } = require('../config/database');
const { sha256 } = require('./authService');

const OTP_TTL_MIN = 5;
const OTP_TTL_MS = OTP_TTL_MIN * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_S = 60;
const OTP_MAX_PER_WINDOW = 3;
const OTP_WINDOW_MS = 10 * 60 * 1000;

/**
 * Normalize a Pakistani mobile number to canonical +92XXXXXXXXXX.
 * Accepts: 03001234567 · +923001234567 · 923001234567 · 3001234567
 * Returns null when the input is not a valid PK mobile number.
 */
function normalizePkPhone(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/[\s\-().]/g, '');
  if (/^\+92\d{10}$/.test(s)) return s;
  if (/^92\d{10}$/.test(s)) return `+${s}`;
  if (/^(?:0)?3\d{9}$/.test(s)) return '+92' + s.replace(/^0/, '');
  return null;
}

/** Human-safe display: +92 •••••••4567 */
function maskPhone(phone) {
  if (!phone) return '';
  return `${phone.slice(0, 3)} •••••••${phone.slice(-4)}`;
}

/**
 * Generate, store (hashed) and deliver an OTP for the given phone.
 * Throws HttpError(429) on cooldown / per-window rate limit.
 */
function issueOtp(phone, ip) {
  const now = Date.now();

  purgeExpiredCodes();

  const win = prepare(
    'SELECT COUNT(*) AS c FROM otp_login_codes WHERE phone = ? AND created_at > ?'
  ).get(phone, now - OTP_WINDOW_MS);
  if (win.c >= OTP_MAX_PER_WINDOW) {
    throw new HttpError(
      429,
      `Is number pe bohot zyada OTP requests ho gayin. ${Math.ceil(OTP_WINDOW_MS / 60000)} min baad koshish karein.`,
      'OTP_RATE_LIMITED'
    );
  }

  const last = prepare(
    'SELECT created_at FROM otp_login_codes WHERE phone = ? ORDER BY id DESC LIMIT 1'
  ).get(phone);
  if (last) {
    const elapsed = Math.floor((now - last.created_at) / 1000);
    if (elapsed < OTP_RESEND_COOLDOWN_S) {
      const retry = OTP_RESEND_COOLDOWN_S - elapsed;
      throw new HttpError(
        429,
        `Naya OTP ${retry}s baad maangein (cooldown).`,
        'OTP_COOLDOWN'
      );
    }
  }

  // Burn any previous unconsumed codes — only the newest one counts
  prepare('UPDATE otp_login_codes SET consumed_at = ? WHERE phone = ? AND consumed_at IS NULL')
    .run(now, phone);

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  prepare(`
    INSERT INTO otp_login_codes (phone, code_hash, attempts, expires_at, created_at, ip)
    VALUES (?, ?, 0, ?, ?, ?)
  `).run(phone, sha256(code), now + OTP_TTL_MS, now, ip || null);

  return { code, expires_in: OTP_TTL_MIN * 60 };
}

/**
 * Verify a submitted code against the newest unconsumed OTP of the phone.
 * Throws descriptive HttpErrors; burns the code on success AND on
 * expiry / too-many-attempts (so it can never be reused).
 */
function verifyOtp(phone, code) {
  const now = Date.now();
  const row = prepare(`
    SELECT * FROM otp_login_codes
    WHERE phone = ? AND consumed_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(phone);

  if (!row) {
    throw new HttpError(
      400,
      'Is number pe koi active OTP nahi hai — pehle "OTP Bhejein" dabayen.',
      'OTP_NOT_REQUESTED'
    );
  }

  if (now > row.expires_at) {
    prepare('UPDATE otp_login_codes SET consumed_at = ? WHERE id = ?').run(now, row.id);
    throw new HttpError(400, 'OTP expire ho gaya hai. Naya OTP maangein.', 'OTP_EXPIRED');
  }

  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    prepare('UPDATE otp_login_codes SET consumed_at = ? WHERE id = ?').run(now, row.id);
    throw new HttpError(
      429,
      'Bohot zyada ghalat koshishen — code burn ho gaya. Naya OTP maangein.',
      'OTP_TOO_MANY_ATTEMPTS'
    );
  }

  const clean = String(code || '').trim();
  if (!/^\d{6}$/.test(clean) || sha256(clean) !== row.code_hash) {
    prepare('UPDATE otp_login_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    const left = OTP_MAX_ATTEMPTS - row.attempts - 1;
    throw new HttpError(
      400,
      left > 0
        ? `OTP ghalat hai. ${left} koshishen baqi hain.`
        : 'OTP ghalat hai. Aakhri koshish — iske baad naya OTP chahiye.',
      'OTP_INVALID'
    );
  }

  prepare('UPDATE otp_login_codes SET consumed_at = ? WHERE id = ?').run(now, row.id);
  return true;
}

/**
 * Delivery channel. SMS gateway aane tak OTP server console pe print hota hai
 * (backend chalane wali bat window). Yahan hi koi real SMS provider plug hoga.
 */
function deliverOtp(phone, code, maskedPhone) {
  const line = '─'.repeat(52);
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(`┌${line}┐`);
  // eslint-disable-next-line no-console
  console.log(`│  📱 OTP LOGIN CODE  ${maskedPhone.padEnd(36)}│`);
  // eslint-disable-next-line no-console
  console.log(`│                                                   │`);
  // eslint-disable-next-line no-console
  console.log(`│       ┌──────────┐                                │`);
  // eslint-disable-next-line no-console
  console.log(`│       │  ${code}  │   → staff ko is code ka batao  │`);
  // eslint-disable-next-line no-console
  console.log(`│       └──────────┘     (${OTP_TTL_MIN} min mein expire)              │`);
  // eslint-disable-next-line no-console
  console.log(`└${line}┘`);
  // eslint-disable-next-line no-console
  console.log('');
}

/** Housekeeping: delete consumed/expired rows older than 24h. */
function purgeExpiredCodes() {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    prepare('DELETE FROM otp_login_codes WHERE created_at < ?').run(cutoff);
  } catch {
    // non-fatal
  }
}

purgeExpiredCodes();

module.exports = {
  normalizePkPhone,
  maskPhone,
  issueOtp,
  verifyOtp,
  deliverOtp,
  purgeExpiredCodes,
  OTP_TTL_MIN,
  OTP_MAX_ATTEMPTS,
};
