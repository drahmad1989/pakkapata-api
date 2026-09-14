/**
 * GeoPata — Auth Service
 *
 * Password hashing (bcrypt) + API key generation/hashing.
 * Pure functions — no DB access here (callers handle persistence).
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const BCRYPT_ROUNDS = 10;

/**
 * Hash a plaintext password using bcrypt.
 * @param {string} password
 * @returns {string} bcrypt hash
 */
function hashPassword(password) {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

/**
 * Compare a plaintext password against a bcrypt hash.
 * @param {string} password
 * @param {string} hash
 * @returns {boolean}
 */
function comparePassword(password, hash) {
  try {
    return bcrypt.compareSync(password, hash);
  } catch {
    return false;
  }
}

/**
 * Generate a new API key pair.
 * Returns:
 *   - keyId:   public identifier (sk_live_<16 hex>)  — stored as PK
 *   - fullKey: secret portion (sk_live_<16 hex>_<32 hex>)  — shown to user ONCE
 *   - keyHash: SHA-256 of fullKey  — stored, used for lookup
 *
 * The fullKey is what the client sends in the X-API-Key header.
 * We never store the fullKey — only its hash. If the DB leaks, keys are safe.
 *
 * @param {'live'|'test'} [env='live']
 * @returns {{keyId: string, fullKey: string, keyHash: string}}
 */
function generateApiKey(env = 'live') {
  const prefix = env === 'test' ? 'sk_test_' : 'sk_live_';
  const idHex = crypto.randomBytes(8).toString('hex');   // 16 chars
  const secretHex = crypto.randomBytes(16).toString('hex'); // 32 chars

  const keyId = `${prefix}${idHex}`;
  const fullKey = `${prefix}${idHex}_${secretHex}`;
  const keyHash = sha256(fullKey);

  return { keyId, fullKey, keyHash };
}

/**
 * SHA-256 hex digest.
 * @param {string} input
 * @returns {string} 64-char hex
 */
function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

module.exports = {
  hashPassword,
  comparePassword,
  generateApiKey,
  sha256,
  BCRYPT_ROUNDS,
};
