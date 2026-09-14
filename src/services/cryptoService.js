/**
 * GeoPata — CNIC security utilities
 *
 * Storage strategy for the sensitive `occupants.cnic` field:
 *
 *   1. AES-256-GCM ciphertext  → stored in `cnic_encrypted`
 *      Reversible (with key) — needed if the operator must verify CNIC later.
 *      Auth tag prevents tampering.
 *
 *   2. HMAC-SHA256 of CNIC     → stored in `cnic_hmac`
 *      Deterministic — two CNICs with the same value produce the same HMAC,
 *      enabling O(log n) lookup via the `idx_occupants_cnic_hmac` index.
 *      One-way — HMAC cannot be reversed to recover the CNIC.
 *
 * Plain CNIC is NEVER written to disk, NEVER logged, NEVER returned by APIs.
 *
 * Production checklist:
 *   - Set CNIC_AES_KEY      to 64 hex chars (32 bytes) via `openssl rand -hex 32`
 *   - Set CNIC_HMAC_SECRET  to a long random string  via `openssl rand -hex 32`
 *   - Store keys in a secrets manager (Vault, AWS KMS, etc.) — NOT in git
 *   - Rotate keys periodically (re-encrypt all CNICs when rotating AES key)
 */

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;   // bytes (96 bits, recommended for GCM)
const TAG_LENGTH = 16;  // bytes (128 bits)

/**
 * Get the AES key — fail fast in production, dev-fallback in development.
 * @returns {Buffer} 32-byte key
 */
function getKey() {
  const hex = process.env.CNIC_AES_KEY;
  if (!hex || hex.length === 0) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CNIC_AES_KEY is not set. Aborting — production mode requires an explicit key.');
    }
    console.warn('⚠️  [dev] CNIC_AES_KEY not set. Using ephemeral random key — CNICs will not be decryptable after restart.');
    return crypto.randomBytes(32);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('CNIC_AES_KEY must be exactly 64 hex chars (32 bytes).');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Get the HMAC secret — same fail-fast pattern.
 * @returns {string}
 */
function getHmacSecret() {
  const secret = process.env.CNIC_HMAC_SECRET;
  if (!secret || secret.length === 0) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CNIC_HMAC_SECRET is not set. Aborting — production mode requires an explicit secret.');
    }
    console.warn('⚠️  [dev] CNIC_HMAC_SECRET not set. Using ephemeral random secret.');
    return crypto.randomBytes(32).toString('hex');
  }
  return secret;
}

// Load once at module init (so warnings fire only once)
const KEY = getKey();
const HMAC_SECRET = getHmacSecret();

/**
 * Normalize a CNIC by stripping all non-digit characters.
 * e.g. "35202-1234567-8" → "3520212345678"
 *
 * @param {string} cnic
 * @returns {string}
 */
function normalizeCnic(cnic) {
  return String(cnic).replace(/[^0-9]/g, '');
}

/**
 * Encrypt a CNIC using AES-256-GCM.
 *
 * Output format (base64):
 *   iv(12) || authTag(16) || ciphertext
 *
 * @param {string} cnic — plain CNIC (with or without dashes)
 * @returns {string} base64-encoded package
 */
function encryptCnic(cnic) {
  const normalized = normalizeCnic(cnic);
  if (normalized.length === 0) {
    throw new Error('Cannot encrypt empty CNIC');
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);

  const ciphertext = Buffer.concat([
    cipher.update(normalized, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack iv + authTag + ciphertext
  const packed = Buffer.concat([iv, authTag, ciphertext]);
  return packed.toString('base64');
}

/**
 * Decrypt a CNIC package back to the plain (normalized) CNIC.
 * Throws if the auth tag does not verify (tampered ciphertext).
 *
 * @param {string} encrypted — base64-encoded package
 * @returns {string} normalized CNIC (no dashes)
 */
function decryptCnic(encrypted) {
  const packed = Buffer.from(encrypted, 'base64');
  if (packed.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Invalid ciphertext package (too short)');
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(authTag);

  const plain = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

/**
 * Compute HMAC-SHA256 of a CNIC.
 * Deterministic — same CNIC always produces the same HMAC.
 * Use this for O(log n) lookup queries via `idx_occupants_cnic_hmac`.
 *
 * @param {string} cnic — plain CNIC (with or without dashes)
 * @returns {string} 64-char hex string
 */
function cnicHmac(cnic) {
  const normalized = normalizeCnic(cnic);
  return crypto.createHmac('sha256', HMAC_SECRET).update(normalized).digest('hex');
}

module.exports = {
  encryptCnic,
  decryptCnic,
  cnicHmac,
  normalizeCnic,
};
