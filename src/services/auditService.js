/**
 * GeoPata — Audit Service
 *
 * Immutable record of all privileged actions.
 * Insert-only — no update/delete methods by design.
 *
 * Each audit entry captures:
 *   - WHO     (admin_id OR api_key_id)
 *   - WHAT    (action verb, e.g., 'CREATE_ADDRESS')
 *   - ON WHAT (resource_type + resource_id)
 *   - CONTEXT (ip, user-agent, JSON details with before/after)
 *   - WHEN    (created_at)
 */

const db = require('../config/database');
const { prepare } = db;

/**
 * Log an action. Non-blocking on failure — audit must never break the request.
 *
 * @param {object} entry
 * @param {number|null} [entry.adminId]
 * @param {string|null} [entry.apiKeyId]
 * @param {string} entry.action — e.g., 'CREATE_ADDRESS', 'UPDATE_TIER', 'LOGIN'
 * @param {string} [entry.resourceType] — 'property' | 'entrance' | 'occupant' | 'admin' | 'api_key'
 * @param {string|number} [entry.resourceId]
 * @param {string} [entry.ipAddress]
 * @param {string} [entry.userAgent]
 * @param {object|string} [entry.details] — object will be JSON.stringified
 */
function log(entry) {
  try {
    const details = typeof entry.details === 'string'
      ? entry.details
      : JSON.stringify(entry.details || {});
    prepare(`
      INSERT INTO audit_log (admin_id, api_key_id, action, resource_type, resource_id, ip_address, user_agent, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.adminId || null,
      entry.apiKeyId || null,
      entry.action,
      entry.resourceType || null,
      entry.resourceId != null ? String(entry.resourceId) : null,
      entry.ipAddress || null,
      entry.userAgent || null,
      details
    );
  } catch (err) {
    // Audit must never break the request — log and continue
    // eslint-disable-next-line no-console
    console.error('[audit] failed to log:', err.message);
  }
}

/**
 * Query audit log with filters. Returns paginated results.
 *
 * @param {object} [filters]
 * @param {number} [filters.adminId]
 * @param {string} [filters.action]
 * @param {string} [filters.resourceType]
 * @param {string} [filters.resourceId]
 * @param {number} [filters.limit=50]
 * @param {number} [filters.offset=0]
 * @returns {{rows: object[], total: number}}
 */
function query(filters = {}) {
  const limit = Math.min(filters.limit || 50, 500);
  const offset = Math.max(filters.offset || 0, 0);

  const where = [];
  const params = [];
  if (filters.adminId != null) { where.push('admin_id = ?'); params.push(filters.adminId); }
  if (filters.action) { where.push('action = ?'); params.push(filters.action); }
  if (filters.resourceType) { where.push('resource_type = ?'); params.push(filters.resourceType); }
  if (filters.resourceId != null) { where.push('resource_id = ?'); params.push(String(filters.resourceId)); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = prepare(`SELECT COUNT(*) as c FROM audit_log ${whereClause}`).get(...params).c;
  const rows = prepare(`
    SELECT a.*, adm.username AS admin_username
    FROM audit_log a
    LEFT JOIN admins adm ON adm.admin_id = a.admin_id
    ${whereClause}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return { rows, total };
}

module.exports = {
  log,
  query,
};
