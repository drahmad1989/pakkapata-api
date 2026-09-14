/**
 * GeoPata — Auth Middleware
 *
 * Provides 3 middleware factories:
 *
 *   1. authenticateJwt   — require a valid Bearer JWT (admin login session)
 *   2. requireRole(...roles) — restrict to specific roles (admin/verifier/viewer)
 *   3. authenticateApiKey — require a valid X-API-Key (service-to-service)
 *   4. authenticateAny   — accept either JWT or API key (for shared endpoints)
 *
 * All authenticated requests decorate `req.auth` with the identity:
 *   { type: 'jwt' | 'api_key', adminId?, apiKeyId?, username?, role?, scopes? }
 *
 * `req.auth` is then used by audit logging to attribute actions.
 */

const db = require('../config/database');
const { prepare } = db;
const { HttpError } = require('./errorHandler');
const { verifyToken } = require('../services/jwtService');
const { sha256 } = require('../services/authService');

/**
 * Extract Bearer token from Authorization header.
 */
function extractBearer(req) {
  const header = req.headers['authorization'] || req.headers['Authorization'];
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

/**
 * Extract API key from X-API-Key header (or ?api_key= query as fallback).
 */
function extractApiKey(req) {
  return req.headers['x-api-key'] || req.headers['X-API-Key'] || req.query.api_key || null;
}

/**
 * Client IP — uses X-Forwarded-For if behind proxy, else socket IP.
 */
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Middleware: require a valid JWT.
 * On success: req.auth = { type:'jwt', adminId, username, role }
 */
function authenticateJwt(req, res, next) {
  const token = extractBearer(req);
  if (!token) {
    throw new HttpError(401, 'Authentication required. Provide a Bearer token.', 'UNAUTHENTICATED');
  }

  let decoded;
  try {
    decoded = verifyToken(token, 'access');
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new HttpError(401, 'Access token expired. Use refresh token to obtain a new one.', 'TOKEN_EXPIRED');
    }
    throw new HttpError(401, 'Invalid access token', 'TOKEN_INVALID');
  }

  // Confirm admin still exists + is active
  const admin = prepare('SELECT admin_id, username, role, is_active FROM admins WHERE admin_id = ?')
    .get(decoded.adminId);

  if (!admin || !admin.is_active) {
    throw new HttpError(401, 'Account no longer active', 'ACCOUNT_INACTIVE');
  }

  req.auth = {
    type: 'jwt',
    adminId: admin.admin_id,
    username: admin.username,
    role: admin.role,
    ipAddress: getClientIp(req),
    userAgent: req.headers['user-agent'] || null,
  };
  next();
}

/**
 * Middleware factory: require a specific role.
 * Must be used AFTER authenticateJwt.
 *
 * @param {...string} roles — 'admin', 'verifier', 'viewer'
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth || req.auth.type !== 'jwt') {
      throw new HttpError(401, 'Authentication required', 'UNAUTHENTICATED');
    }
    if (!roles.includes(req.auth.role)) {
      throw new HttpError(403, `Forbidden. Required role: ${roles.join(' or ')}`, 'FORBIDDEN');
    }
    next();
  };
}

/**
 * Middleware: require a valid API key with at least one of the specified scopes.
 *
 * @param {...string} requiredScopes — 'read', 'write', 'admin'
 */
function authenticateApiKey(...requiredScopes) {
  return (req, res, next) => {
    const fullKey = extractApiKey(req);
    if (!fullKey) {
      throw new HttpError(401, 'API key required. Provide X-API-Key header.', 'API_KEY_MISSING');
    }

    const keyHash = sha256(fullKey);
    const apiKey = prepare(`
      SELECT key_id, name, scopes, is_active, expires_at, created_by
      FROM api_keys WHERE key_hash = ?
    `).get(keyHash);

    if (!apiKey || !apiKey.is_active) {
      throw new HttpError(401, 'Invalid or revoked API key', 'API_KEY_INVALID');
    }
    if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
      throw new HttpError(401, 'API key expired', 'API_KEY_EXPIRED');
    }

    const scopes = apiKey.scopes.split(',').map(s => s.trim());
    const hasScope = requiredScopes.some(s => scopes.includes(s));
    if (!hasScope) {
      throw new HttpError(403, `API key lacks required scope: ${requiredScopes.join(' or ')}`, 'INSUFFICIENT_SCOPE');
    }

    // Update last_used_at (non-blocking)
    try {
      prepare('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE key_id = ?')
        .run(apiKey.key_id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[api_key] failed to update last_used_at:', err.message);
    }

    req.auth = {
      type: 'api_key',
      apiKeyId: apiKey.key_id,
      apiKeyName: apiKey.name,
      scopes,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] || null,
    };
    next();
  };
}

/**
 * Middleware: accept EITHER a JWT (admin) OR an API key (service).
 * Useful for shared endpoints like POST /api/address that both admins and SikkaChat use.
 *
 * @param {...string} apiScopes — required API key scopes if API key is used
 */
function authenticateAny(...apiScopes) {
  return (req, res, next) => {
    const bearer = extractBearer(req);
    const apiKey = extractApiKey(req);

    if (bearer) {
      return authenticateJwt(req, res, next);
    }
    if (apiKey) {
      return authenticateApiKey(...apiScopes)(req, res, next);
    }
    throw new HttpError(401, 'Authentication required. Provide Bearer token or X-API-Key.', 'UNAUTHENTICATED');
  };
}

module.exports = {
  authenticateJwt,
  requireRole,
  authenticateApiKey,
  authenticateAny,
  getClientIp,
};
