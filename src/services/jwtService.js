/**
 * GeoPata — JWT Service
 *
 * Issues and verifies JSON Web Tokens for admin authentication.
 * Tokens contain: { adminId, username, role, type }
 *   type = 'access' (short-lived, 15 min) | 'refresh' (long-lived, 7 days)
 */

const jwt = require('jsonwebtoken');

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL = '7d';

/**
 * Get JWT secret — fail fast in production.
 */
function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET is not set. Production requires an explicit secret.');
    }
    // Dev fallback — ephemeral, won't survive restart
    console.warn('⚠️  [dev] JWT_SECRET not set. Using ephemeral secret — tokens will not survive restart.');
    return 'geopata_dev_jwt_secret_change_in_production';
  }
  if (secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters for security.');
  }
  return secret;
}

/**
 * Issue an access token (short-lived, used for API calls).
 * @param {{adminId: number, username: string, role: string}} payload
 * @returns {string}
 */
function signAccessToken(payload) {
  return jwt.sign(
    { ...payload, type: 'access' },
    getSecret(),
    { expiresIn: ACCESS_TOKEN_TTL, issuer: 'geopata', audience: 'geopata-admin' }
  );
}

/**
 * Issue a refresh token (long-lived, used to obtain new access tokens).
 * @param {{adminId: number, username: string, role: string}} payload
 * @returns {string}
 */
function signRefreshToken(payload) {
  return jwt.sign(
    { ...payload, type: 'refresh' },
    getSecret(),
    { expiresIn: REFRESH_TOKEN_TTL, issuer: 'geopata', audience: 'geopata-admin' }
  );
}

/**
 * Verify a token. Throws jwt.JsonWebTokenError on invalid/expired.
 * @param {string} token
 * @param {string} [expectedType] — if provided, rejects tokens of wrong type
 * @returns {object} decoded payload
 */
function verifyToken(token, expectedType) {
  const decoded = jwt.verify(token, getSecret(), {
    issuer: 'geopata',
    audience: 'geopata-admin',
  });
  if (expectedType && decoded.type !== expectedType) {
    const err = new Error(`Expected ${expectedType} token, got ${decoded.type}`);
    err.name = 'WrongTokenType';
    throw err;
  }
  return decoded;
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyToken,
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL,
};
