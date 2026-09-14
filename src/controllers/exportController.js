/**
 * GeoPata — Export Controller
 *
 *   GET /api/admin/export.csv  — download all addresses as CSV (JWT admin only)
 *   GET /api/admin/export.json — same data as JSON (JWT admin only)
 *
 * Useful for backups, batch imports to other systems, analytics.
 */

const db = require('../config/database');
const { prepare } = db;
const audit = require('../services/auditService');

const SQL_EXPORT_ADDRESSES = `
  SELECT
    e.entrance_id,
    e.uprn,
    e.short_code,
    e.gps_lat,
    e.gps_long,
    e.nfc_tag_id,
    e.lifecycle_status,
    e.created_at,
    e.updated_at,
    p.h3_index,
    p.plus_code,
    p.property_type,
    p.verification_tier,
    (SELECT COUNT(*) FROM occupants o
       WHERE o.entrance_id = e.entrance_id AND o.is_active = 1) AS active_occupants
  FROM entrances e
  JOIN properties p ON p.uprn = e.uprn
  ORDER BY e.created_at DESC
`;

function exportCsv(req, res) {
  const rows = prepare(SQL_EXPORT_ADDRESSES).all();

  const headers = [
    'entrance_id', 'uprn', 'short_code', 'gps_lat', 'gps_long',
    'h3_index', 'plus_code', 'property_type', 'verification_tier',
    'lifecycle_status', 'nfc_tag_id', 'active_occupants',
    'created_at', 'updated_at',
  ];

  const escapeCsv = (val) => {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const csv = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escapeCsv(r[h])).join(',')),
  ].join('\r\n');

  audit.log({
    adminId: req.auth.adminId,
    action: 'EXPORT_ADDRESSES_CSV',
    resourceType: 'entrance',
    resourceId: 'all',
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { count: rows.length },
  });

  const filename = `geopata-addresses-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(csv);
}

function exportJson(req, res) {
  const rows = prepare(SQL_EXPORT_ADDRESSES).all();

  audit.log({
    adminId: req.auth.adminId,
    action: 'EXPORT_ADDRESSES_JSON',
    resourceType: 'entrance',
    resourceId: 'all',
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { count: rows.length },
  });

  return res.json({ count: rows.length, data: rows });
}

module.exports = { exportCsv, exportJson };
