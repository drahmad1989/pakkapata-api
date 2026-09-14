/**
 * GeoPata — Occupant Controller
 *
 * v0.2.1 endpoints:
 *   POST   /api/occupant              — link a resident to an entrance  (JWT or API key:write)
 *   GET    /api/entrance/:id/occupants — list residents of an entrance  (JWT only)
 *   DELETE /api/occupant/:id           — soft-delete (deactivate)        (JWT verifier+)
 *
 * Security:
 *   - Plain CNIC is NEVER stored, NEVER logged, NEVER returned.
 *   - CNIC is encrypted with AES-256-GCM (cnic_encrypted column).
 *   - A separate HMAC-SHA256 (cnic_hmac column) enables O(log n) lookup
 *     without revealing the original CNIC.
 *   - Response returns only a masked placeholder for CNIC.
 */

const db = require('../config/database');
const { prepare } = db;
const { HttpError } = require('../middleware/errorHandler');
const audit = require('../services/auditService');
const { encryptCnic, cnicHmac, normalizeCnic } = require('../services/cryptoService');

// SQL templates
const SQL_GET_ENTRANCE_BY_ID = 'SELECT entrance_id, short_code FROM entrances WHERE entrance_id = ?';
const SQL_CHECK_DUP_OCCUPANT = `
  SELECT 1 FROM occupants
  WHERE entrance_id = ? AND cnic_hmac = ? AND is_active = 1
`;
const SQL_INSERT_OCCUPANT = `
  INSERT INTO occupants (entrance_id, cnic_encrypted, cnic_hmac, phone_number, move_in_date)
  VALUES (?, ?, ?, ?, ?)
`;
const SQL_LIST_OCCUPANTS = `
  SELECT occupant_id, entrance_id, phone_number, is_active, move_in_date, created_at
  FROM occupants WHERE entrance_id = ?
  ORDER BY is_active DESC, created_at DESC
`;
const SQL_GET_OCCUPANT_BY_ID = `
  SELECT o.occupant_id, o.entrance_id, o.phone_number, o.is_active, o.move_in_date, o.created_at,
         e.short_code
  FROM occupants o
  JOIN entrances e ON e.entrance_id = o.entrance_id
  WHERE o.occupant_id = ?
`;
const SQL_DEACTIVATE_OCCUPANT = `UPDATE occupants SET is_active = 0 WHERE occupant_id = ?`;

/**
 * Mask a CNIC for display: 35202-1234567-8 → XXXXX-XXXXXXX-X
 * We never expose the original; but for already-stored ones, just show mask format.
 */
function maskCnic() {
  return 'XXXXX-XXXXXXX-X';
}

/**
 * POST /api/occupant — link a resident to an entrance
 */
function createOccupant(req, res) {
  const { entrance_id, cnic, phone_number, move_in_date } = req.body;

  const entrance = prepare(SQL_GET_ENTRANCE_BY_ID).get(entrance_id);
  if (!entrance) {
    throw new HttpError(404, `Entrance ${entrance_id} not found`, 'ENTRANCE_NOT_FOUND');
  }

  const cnic_encrypted = encryptCnic(cnic);
  const cnic_hmac = cnicHmac(cnic);

  const existing = prepare(SQL_CHECK_DUP_OCCUPANT).get(entrance_id, cnic_hmac);
  if (existing) {
    throw new HttpError(409, 'This CNIC is already linked to this entrance', 'DUPLICATE_OCCUPANT');
  }

  const result = prepare(SQL_INSERT_OCCUPANT).run(
    entrance_id,
    cnic_encrypted,
    cnic_hmac,
    phone_number,
    move_in_date || null
  );

  audit.log({
    adminId: req.auth?.adminId,
    apiKeyId: req.auth?.apiKeyId,
    action: 'CREATE_OCCUPANT',
    resourceType: 'occupant',
    resourceId: result.lastInsertRowid,
    ipAddress: req.auth?.ipAddress,
    userAgent: req.auth?.userAgent,
    details: { entrance_id, short_code: entrance.short_code, phone_number, move_in_date },
  });

  return res.status(201).json({
    message: 'Occupant linked successfully',
    data: {
      occupant_id: result.lastInsertRowid,
      entrance_id,
      short_code: entrance.short_code,
      phone_number,
      is_active: true,
      move_in_date: move_in_date || null,
      cnic_masked: maskCnic(),
    },
  });
}

/**
 * GET /api/entrance/:id/occupants — list all residents of an entrance
 * CNIC is never returned; only masked placeholder.
 */
function listOccupants(req, res) {
  const { id } = req.params;

  const entrance = prepare(SQL_GET_ENTRANCE_BY_ID).get(id);
  if (!entrance) {
    throw new HttpError(404, `Entrance ${id} not found`, 'ENTRANCE_NOT_FOUND');
  }

  const rows = prepare(SQL_LIST_OCCUPANTS).all(id).map((r) => ({
    ...r,
    cnic_masked: maskCnic(),
  }));

  return res.json({
    entrance_id: Number(id),
    short_code: entrance.short_code,
    count: rows.length,
    data: rows,
  });
}

/**
 * DELETE /api/occupant/:id — soft-delete (deactivate)
 * We never HARD delete residents — audit trail must remain intact.
 */
function deleteOccupant(req, res) {
  const { id } = req.params;

  const existing = prepare(SQL_GET_OCCUPANT_BY_ID).get(id);
  if (!existing) {
    throw new HttpError(404, `Occupant ${id} not found`, 'OCCUPANT_NOT_FOUND');
  }

  if (!existing.is_active) {
    throw new HttpError(400, `Occupant ${id} is already inactive`, 'OCCUPANT_ALREADY_INACTIVE');
  }

  prepare(SQL_DEACTIVATE_OCCUPANT).run(id);

  audit.log({
    adminId: req.auth.adminId,
    action: 'DEACTIVATE_OCCUPANT',
    resourceType: 'occupant',
    resourceId: id,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: {
      short_code: existing.short_code,
      phone_number: existing.phone_number,
    },
  });

  return res.json({ message: `Occupant ${id} deactivated (soft delete)` });
}

module.exports = {
  createOccupant,
  listOccupants,
  deleteOccupant,
};
