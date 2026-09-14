/**
 * GeoPata — Address Controller
 *
 * v0.2.0 endpoints:
 *   POST   /api/address              → create property + entrance  (JWT or API key:write)
 *   GET    /api/address/:code         → lookup by short code        (JWT or API key:read)
 *   GET    /api/addresses             → list + pagination           (JWT only)
 *   PUT    /api/address/:code         → update property_type/tier   (JWT verifier+)
 *   PATCH  /api/entrance/:id/lifecycle → change lifecycle status    (JWT verifier+)
 *   POST   /api/entrance/:id/nfc      → bind NFC tag                (JWT verifier+)
 *   POST   /api/verify/:code          → upgrade verification tier   (JWT verifier+)
 *   GET    /api/radius                → spatial radius search       (JWT or API key:read)
 *
 * Each new address is permanently identified by:
 *   - UPRN        (Unique Property Reference Number) — server-generated
 *   - short_code  (Human-friendly, e.g. BGL-0001)     — server-generated
 *   - h3_index    (Uber H3 Res 14 cell)               — computed from lat/lng
 *   - plus_code   (Open Location Code)                — computed from lat/lng
 */

const db = require('../config/database');
const { prepare } = db;
const { HttpError } = require('../middleware/errorHandler');
const geoService = require('../services/geoService');
const audit = require('../services/auditService');
const { generateUPRN, generateShortCode, generatePublicAddressId } = require('../services/idGenerator');

// ─────────────────────────────────────────────
// SQL templates (used with lazy prepare())
// ─────────────────────────────────────────────
const SQL_INSERT_PROPERTY = `
  INSERT INTO properties (uprn, h3_index, plus_code, property_type, verification_tier,
                          display_name, block_code, street_number, house_number, share_code)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;
const SQL_INSERT_ENTRANCE = `
  INSERT INTO entrances (uprn, short_code, gps_lat, gps_long)
  VALUES (?, ?, ?, ?)
`;
const SQL_GET_PROPERTY_BY_UPRN = 'SELECT 1 FROM properties WHERE uprn = ?';
const SQL_GET_ENTRANCE_BY_SHORT_CODE_EXISTS = 'SELECT 1 FROM entrances WHERE short_code = ?';

const ENTRANCE_DETAIL_SELECT = `
  SELECT e.entrance_id, e.uprn, e.short_code, e.gps_lat, e.gps_long,
         e.nfc_tag_id, e.lifecycle_status, e.created_at, e.updated_at,
         p.h3_index, p.plus_code, p.property_type, p.verification_tier,
         p.created_at AS property_created_at,
         p.display_name, p.block_code, p.street_number, p.house_number, p.share_code, p.area_code,
         (SELECT COUNT(*) FROM occupants o
            WHERE o.entrance_id = e.entrance_id AND o.is_active = 1) AS active_occupants
  FROM entrances e
  JOIN properties p ON p.uprn = e.uprn
`;
const SQL_GET_ENTRANCE_BY_ID = `${ENTRANCE_DETAIL_SELECT} WHERE e.entrance_id = ?`;
const SQL_GET_ENTRANCE_BY_SHORT_CODE = `${ENTRANCE_DETAIL_SELECT} WHERE e.short_code = ?`;
const SQL_GET_ENTRANCE_BY_NFC = `${ENTRANCE_DETAIL_SELECT} WHERE e.nfc_tag_id = ?`;

const SQL_UPDATE_PROPERTY = `
  UPDATE properties SET property_type     = COALESCE(?, property_type),
                        verification_tier = COALESCE(?, verification_tier),
                        updated_at = CURRENT_TIMESTAMP
  WHERE uprn = ?
`;
const SQL_TOUCH_ENTRANCE = `UPDATE entrances SET updated_at = CURRENT_TIMESTAMP WHERE entrance_id = ?`;
const SQL_SET_LIFECYCLE = `UPDATE entrances SET lifecycle_status = ?, updated_at = CURRENT_TIMESTAMP WHERE entrance_id = ?`;
const SQL_BIND_NFC = `UPDATE entrances SET nfc_tag_id = ?, updated_at = CURRENT_TIMESTAMP WHERE entrance_id = ?`;
const SQL_CLEAR_NFC_ON_OTHERS = `UPDATE entrances SET nfc_tag_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE nfc_tag_id = ? AND entrance_id != ?`;
const SQL_UPGRADE_TIER = `UPDATE properties SET verification_tier = ?, updated_at = CURRENT_TIMESTAMP WHERE uprn = ?`;

// ─────────────────────────────────────────────
// POST /api/address  — create
// ─────────────────────────────────────────────
function createAddress(req, res) {
  const {
    gps_lat,
    gps_long,
    property_type = 'Residential',
    verification_tier = 1,
    uprn: uprnOverride,
    short_code: shortCodeOverride,
    // v0.4.0 new fields (all optional — backward compatible)
    display_name,
    block_code,
    street_number,
    house_number,
  } = req.body;

  const h3_index = geoService.getH3Index(gps_lat, gps_long);
  const plus_code = geoService.getPlusCode(gps_lat, gps_long);
  const uprn = uprnOverride || generateUPRN();
  const short_code = shortCodeOverride || generateShortCode();

  // Auto-generate share_code if block/street/house provided
  // Format: LLLL-ZSS-NNN (v0.6.0 - Qibla-based zones)
  let share_code = null;
  let finalBlockCode = block_code;
  // v0.8.0: resolved area chain (village + ancestors) — auto-assigned after insert
  let resolvedAreaCodes = null;

  // v0.6.0: If block_code not provided, try auto-detect from village boundary (Qibla zones)
  if (!finalBlockCode) {
    try {
      const boundaryService = require('../services/villageBoundaryService');
      const detection = boundaryService.detectBlock(gps_lat, gps_long);
      if (detection.found && detection.block && detection.block !== '?') {
        finalBlockCode = detection.block;
        // Also get the zone (Q/R/B/L) for the public address ID
        if (detection.zone) {
          const villageName = detection.village_name || 'VILLAGE';
          const street = street_number || '01';
          const house = house_number || '001';
          share_code = generatePublicAddressId(villageName, detection.zone, street, house);
          if (detection.village_area_code) {
            try {
              const areaService = require('../services/areaService');
              resolvedAreaCodes = areaService.getAreaChain(detection.village_area_code).map(a => a.area_code);
            } catch { /* chain optional */ }
          }
        }
      }
    } catch {
      // Boundary service not available — skip auto-detect
    }
  }

  // Fallback: if we have block_code but no share_code yet, generate it
  if (!share_code && finalBlockCode && house_number) {
    try {
      const areaService = require('../services/areaService');
      const reverseResult = areaService.reverseGeocode(gps_lat, gps_long);
      const village = reverseResult.chain.find(a => a.type === 'village' || a.type === 'union_council');
      if (village) {
        // Map block_code to zone (A=Q, B=R, C=B, D=L for backward compat)
        const blockToZone = { 'A': 'Q', 'B': 'R', 'C': 'B', 'D': 'L' };
        const zone = blockToZone[finalBlockCode] || finalBlockCode;
        share_code = generatePublicAddressId(village.name, zone, street_number || '01', house_number);
        resolvedAreaCodes = reverseResult.chain.map(a => a.area_code);
      }
    } catch {
      // Area service not available
    }
  }

  // v0.8.0: Final fallback — no boundary polygon AND no block_code provided.
  // Derive the Qibla zone (Q/R/B/L) from the nearest village centroid (areas table),
  // so share codes (BONG-Q07-025) work across ALL seeded Pakistan villages
  // even before a verifier draws a real boundary polygon.
  if (!share_code) {
    try {
      const areaService = require('../services/areaService');
      const reverseResult = areaService.reverseGeocode(gps_lat, gps_long);
      const village = reverseResult.chain.find(a => a.type === 'village' || a.type === 'union_council');
      if (village && village.lat != null && village.lng != null) {
        const boundaryService = require('../services/villageBoundaryService');
        const zone = boundaryService.getQiblaZone(gps_lat, gps_long, village.lat, village.lng);
        share_code = generatePublicAddressId(village.name, zone, street_number || '01', house_number || '001');
        if (!finalBlockCode) {
          finalBlockCode = { Q: 'A', R: 'B', B: 'C', L: 'D' }[zone] || null;
        }
        resolvedAreaCodes = reverseResult.chain.map(a => a.area_code);
      }
    } catch {
      // best-effort — share_code stays null (address still created)
    }
  }

  const entranceId = db.transaction(() => {
    if (uprnOverride && prepare(SQL_GET_PROPERTY_BY_UPRN).get(uprn)) {
      throw new HttpError(409, `Property with UPRN ${uprn} already exists`, 'DUPLICATE_UPRN');
    }
    if (shortCodeOverride && prepare(SQL_GET_ENTRANCE_BY_SHORT_CODE_EXISTS).get(short_code)) {
      throw new HttpError(409, `Short code ${short_code} already exists`, 'DUPLICATE_SHORT_CODE');
    }
    // Check share_code uniqueness if provided
    if (share_code) {
      const existing = prepare('SELECT 1 FROM properties WHERE share_code = ?').get(share_code);
      if (existing) {
        // Append random suffix to make unique
        share_code = `${share_code}-${Math.floor(Math.random() * 99).toString().padStart(2, '0')}`;
      }
    }
    prepare(SQL_INSERT_PROPERTY).run(
      uprn, h3_index, plus_code, property_type, verification_tier,
      display_name || null, finalBlockCode || null, street_number || null,
      house_number || null, share_code
    );
    const result = prepare(SQL_INSERT_ENTRANCE).run(uprn, short_code, gps_lat, gps_long);
    return result.lastInsertRowid;
  })();

  const entrance = prepare(SQL_GET_ENTRANCE_BY_ID).get(entranceId);

  // v0.8.0: auto-assign the area chain (village + ancestors) so lookups,
  // area filters and the public page show village/tehsil/district immediately —
  // same behavior bulk import has always had.
  if (resolvedAreaCodes && resolvedAreaCodes.length > 0) {
    try {
      const areaService = require('../services/areaService');
      areaService.assignEntranceToAreas(entranceId, resolvedAreaCodes, 'auto');
    } catch {
      // non-fatal — address exists even if area assignment fails
    }
  }

  audit.log({
    adminId: req.auth?.adminId,
    apiKeyId: req.auth?.apiKeyId,
    action: 'CREATE_ADDRESS',
    resourceType: 'entrance',
    resourceId: entranceId,
    ipAddress: req.auth?.ipAddress,
    userAgent: req.auth?.userAgent,
    details: {
      uprn, short_code, share_code, display_name,
      block_code, street_number, house_number,
      gps_lat, gps_long, property_type, verification_tier,
    },
  });

  return res.status(201).json({
    message: 'Address created successfully',
    data: entrance,
  });
}

// ─────────────────────────────────────────────
// GET /api/address/:code  — lookup by short code
// ─────────────────────────────────────────────
function getAddressByCode(req, res) {
  const { code } = req.params;
  const row = prepare(SQL_GET_ENTRANCE_BY_SHORT_CODE).get(code);
  if (!row) {
    throw new HttpError(404, `Address with short code ${code} not found`, 'ADDRESS_NOT_FOUND');
  }
  return res.json({ data: row });
}

// ─────────────────────────────────────────────
// GET /api/entrance/by-nfc/:nfcTagId  — lookup by NFC tag
// ─────────────────────────────────────────────
function getEntranceByNfc(req, res) {
  const { nfcTagId } = req.params;
  const row = prepare(SQL_GET_ENTRANCE_BY_NFC).get(nfcTagId);
  if (!row) {
    throw new HttpError(404, `No entrance bound to NFC tag ${nfcTagId}`, 'NFC_NOT_FOUND');
  }
  return res.json({ data: row });
}

// ─────────────────────────────────────────────
// GET /api/addresses  — list + pagination
// Query: ?page=1&limit=20&tier=&type=&status=&q=
// ─────────────────────────────────────────────
function listAddresses(req, res) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
  const offset = (page - 1) * limit;

  const where = [];
  const params = [];
  if (req.query.tier != null) {
    where.push('p.verification_tier = ?');
    params.push(Number(req.query.tier));
  }
  if (req.query.type) {
    where.push('p.property_type = ?');
    params.push(req.query.type);
  }
  if (req.query.status) {
    where.push('e.lifecycle_status = ?');
    params.push(req.query.status);
  }
  if (req.query.q) {
    where.push('(e.short_code LIKE ? OR p.uprn LIKE ?)');
    const q = `%${req.query.q}%`;
    params.push(q, q);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = prepare(`SELECT COUNT(*) as c FROM entrances e JOIN properties p ON p.uprn = e.uprn ${whereClause}`).get(...params).c;

  const rows = prepare(`
    ${ENTRANCE_DETAIL_SELECT}
    ${whereClause}
    ORDER BY e.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return res.json({
    pagination: { page, limit, offset, total, pages: Math.ceil(total / limit) },
    count: rows.length,
    data: rows,
  });
}

// ─────────────────────────────────────────────
// PUT /api/address/:code  — update property_type / verification_tier
// Body: { property_type?, verification_tier? }
// ─────────────────────────────────────────────
function updateAddress(req, res) {
  const { code } = req.params;
  const { property_type, verification_tier } = req.body;

  const existing = prepare(SQL_GET_ENTRANCE_BY_SHORT_CODE).get(code);
  if (!existing) {
    throw new HttpError(404, `Address with short code ${code} not found`, 'ADDRESS_NOT_FOUND');
  }

  // Tier can only go UP via this endpoint (use dedicated verify endpoint for clarity)
  if (verification_tier != null && verification_tier < existing.verification_tier) {
    throw new HttpError(400, 'Cannot downgrade tier via PUT. Use a dedicated admin action.', 'TIER_DOWNGRADE_FORBIDDEN');
  }

  prepare(SQL_UPDATE_PROPERTY).run(
    property_type || null,
    verification_tier != null ? verification_tier : null,
    existing.uprn
  );
  prepare(SQL_TOUCH_ENTRANCE).run(existing.entrance_id);

  const updated = prepare(SQL_GET_ENTRANCE_BY_SHORT_CODE).get(code);

  audit.log({
    adminId: req.auth.adminId,
    action: 'UPDATE_ADDRESS',
    resourceType: 'property',
    resourceId: existing.uprn,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: {
      before: { property_type: existing.property_type, verification_tier: existing.verification_tier },
      after: { property_type: updated.property_type, verification_tier: updated.verification_tier },
    },
  });

  return res.json({ message: 'Address updated', data: updated });
}

// ─────────────────────────────────────────────
// PATCH /api/entrance/:id/lifecycle  — change lifecycle status
// Body: { lifecycle_status }
// ─────────────────────────────────────────────
function changeLifecycle(req, res) {
  const { id } = req.params;
  const { lifecycle_status } = req.body;

  const existing = prepare(SQL_GET_ENTRANCE_BY_ID).get(id);
  if (!existing) {
    throw new HttpError(404, `Entrance ${id} not found`, 'ENTRANCE_NOT_FOUND');
  }

  prepare(SQL_SET_LIFECYCLE).run(lifecycle_status, id);

  audit.log({
    adminId: req.auth.adminId,
    action: 'CHANGE_LIFECYCLE',
    resourceType: 'entrance',
    resourceId: id,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: {
      short_code: existing.short_code,
      before: existing.lifecycle_status,
      after: lifecycle_status,
    },
  });

  const updated = prepare(SQL_GET_ENTRANCE_BY_ID).get(id);
  return res.json({ message: 'Lifecycle updated', data: updated });
}

// ─────────────────────────────────────────────
// POST /api/entrance/:id/nfc  — bind NFC tag
// Body: { nfc_tag_id }
// ─────────────────────────────────────────────
function bindNfc(req, res) {
  const { id } = req.params;
  const { nfc_tag_id } = req.body;

  const existing = prepare(SQL_GET_ENTRANCE_BY_ID).get(id);
  if (!existing) {
    throw new HttpError(404, `Entrance ${id} not found`, 'ENTRANCE_NOT_FOUND');
  }

  // Check if NFC tag is already bound to another entrance
  const conflict = prepare(SQL_GET_ENTRANCE_BY_NFC).get(nfc_tag_id);
  if (conflict && conflict.entrance_id !== existing.entrance_id) {
    throw new HttpError(
      409,
      `NFC tag ${nfc_tag_id} already bound to entrance ${conflict.short_code} (id=${conflict.entrance_id})`,
      'NFC_ALREADY_BOUND'
    );
  }

  db.transaction(() => {
    // Clear this NFC tag from any other entrance (safety)
    prepare(SQL_CLEAR_NFC_ON_OTHERS).run(nfc_tag_id, existing.entrance_id);
    prepare(SQL_BIND_NFC).run(nfc_tag_id, existing.entrance_id);
  })();

  audit.log({
    adminId: req.auth.adminId,
    action: 'BIND_NFC',
    resourceType: 'entrance',
    resourceId: id,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: {
      short_code: existing.short_code,
      before: existing.nfc_tag_id,
      after: nfc_tag_id,
    },
  });

  const updated = prepare(SQL_GET_ENTRANCE_BY_ID).get(id);
  return res.json({ message: 'NFC tag bound', data: updated });
}

// ─────────────────────────────────────────────
// DELETE /api/entrance/:id/nfc  — unbind NFC tag
// ─────────────────────────────────────────────
function unbindNfc(req, res) {
  const { id } = req.params;
  const existing = prepare(SQL_GET_ENTRANCE_BY_ID).get(id);
  if (!existing) {
    throw new HttpError(404, `Entrance ${id} not found`, 'ENTRANCE_NOT_FOUND');
  }
  if (!existing.nfc_tag_id) {
    throw new HttpError(400, `Entrance ${id} has no NFC tag bound`, 'NFC_NOT_BOUND');
  }

  prepare(SQL_BIND_NFC).run(null, id);

  audit.log({
    adminId: req.auth.adminId,
    action: 'UNBIND_NFC',
    resourceType: 'entrance',
    resourceId: id,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { short_code: existing.short_code, removed_tag: existing.nfc_tag_id },
  });

  const updated = prepare(SQL_GET_ENTRANCE_BY_ID).get(id);
  return res.json({ message: 'NFC tag removed', data: updated });
}

// ─────────────────────────────────────────────
// POST /api/verify/:code  — upgrade verification tier
// Body: { to_tier, note? }
// ─────────────────────────────────────────────
function upgradeTier(req, res) {
  const { code } = req.params;
  const { to_tier, note } = req.body;

  const existing = prepare(SQL_GET_ENTRANCE_BY_SHORT_CODE).get(code);
  if (!existing) {
    throw new HttpError(404, `Address with short code ${code} not found`, 'ADDRESS_NOT_FOUND');
  }

  if (to_tier <= existing.verification_tier) {
    throw new HttpError(400, `Cannot upgrade to tier ${to_tier} (current: ${existing.verification_tier}). Tier can only increase.`, 'TIER_NOT_INCREASING');
  }
  if (to_tier > 4) {
    throw new HttpError(400, 'Maximum tier is 4', 'TIER_OUT_OF_RANGE');
  }

  prepare(SQL_UPGRADE_TIER).run(to_tier, existing.uprn);
  prepare(SQL_TOUCH_ENTRANCE).run(existing.entrance_id);

  audit.log({
    adminId: req.auth.adminId,
    action: 'UPGRADE_TIER',
    resourceType: 'property',
    resourceId: existing.uprn,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: {
      short_code: code,
      before: existing.verification_tier,
      after: to_tier,
      note: note || null,
    },
  });

  const updated = prepare(SQL_GET_ENTRANCE_BY_SHORT_CODE).get(code);
  return res.json({
    message: `Verification tier upgraded from ${existing.verification_tier} to ${to_tier}`,
    data: updated,
  });
}

// ─────────────────────────────────────────────
// GET /api/radius?lat=&long=&radius=
// ─────────────────────────────────────────────
function getAddressesInRadius(req, res) {
  const { lat, long, radius } = req.query;

  const bbox = geoService.boundingBox(lat, long, radius);

  const candidates = db.prepare(`
    SELECT e.entrance_id, e.uprn, e.short_code, e.gps_lat, e.gps_long,
           e.lifecycle_status, e.created_at,
           p.h3_index, p.plus_code, p.property_type, p.verification_tier
    FROM entrances e
    JOIN properties p ON p.uprn = e.uprn
    WHERE e.gps_lat BETWEEN ? AND ?
      AND e.gps_long BETWEEN ? AND ?
      AND e.lifecycle_status = 'Active'
  `).all(bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng);

  const results = candidates
    .map((row) => ({
      ...row,
      distance_m: Math.round(geoService.haversineMeters(lat, long, row.gps_lat, row.gps_long)),
    }))
    .filter((row) => row.distance_m <= radius)
    .sort((a, b) => a.distance_m - b.distance_m);

  return res.json({
    query: { lat, long, radius_m: radius },
    count: results.length,
    data: results,
  });
}

module.exports = {
  createAddress,
  getAddressByCode,
  getEntranceByNfc,
  listAddresses,
  updateAddress,
  changeLifecycle,
  bindNfc,
  unbindNfc,
  upgradeTier,
  getAddressesInRadius,
};
