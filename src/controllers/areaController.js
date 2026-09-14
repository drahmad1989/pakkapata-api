/**
 * GeoPata — Area Controller (v0.3.0)
 *
 * Endpoints:
 *   GET    /api/areas/:code                — get area + parent + children
 *   GET    /api/areas                       — list with filters (type, parent, q)
 *   GET    /api/areas/type/:type            — list all areas of a type
 *   GET    /api/areas/reverse-geocode       — lat/lng → area chain
 *   GET    /api/areas/:code/addresses       — list addresses in area
 *   POST   /api/areas                       — create (admin only)
 *   PUT    /api/areas/:code                 — update (admin only)
 *   DELETE /api/areas/:code                 — deactivate (admin only)
 *   POST   /api/areas/seed                  — bulk import from JSON body (admin only)
 *   POST   /api/areas/seed-default          — load default Pakistan areas (admin only, no body needed)
 *   POST   /api/addresses/:code/assign-area — manually assign (verifier+)
 */

const path = require('path');
const fs = require('fs');

const db = require('../config/database');
const { prepare } = db;
const { HttpError } = require('../middleware/errorHandler');
const audit = require('../services/auditService');
const areaService = require('../services/areaService');
const geoService = require('../services/geoService');

// SQL templates
const SQL_INSERT_AREA = `
  INSERT INTO areas (area_code, name, name_urdu, type, parent_code, lat, lng, h3_index, population)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;
const SQL_GET_AREA_BY_CODE = `SELECT * FROM areas WHERE area_code = ?`;
const SQL_UPDATE_AREA = `
  UPDATE areas SET name = COALESCE(?, name),
                   name_urdu = COALESCE(?, name_urdu),
                   lat = COALESCE(?, lat),
                   lng = COALESCE(?, lng),
                   h3_index = COALESCE(?, h3_index),
                   population = COALESCE(?, population),
                   is_active = COALESCE(?, is_active),
                   updated_at = CURRENT_TIMESTAMP
  WHERE area_code = ?
`;
const SQL_DEACTIVATE_AREA = `UPDATE areas SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE area_code = ?`;

// v0.10.7 — Mashwara Box: area name-lock (Stage-3 name plate finalization)
const SQL_LOCK_AREA = `UPDATE areas SET locked_at = ?, locked_by = ?, updated_at = CURRENT_TIMESTAMP WHERE area_code = ?`;
const SQL_UNLOCK_AREA = `UPDATE areas SET locked_at = NULL, locked_by = NULL, updated_at = CURRENT_TIMESTAMP WHERE area_code = ?`;

// H3 resolution per area type
const H3_RES_BY_TYPE = {
  country: 2,
  province: 4,
  division: 5,
  district: 6,
  tehsil: 7,
  village: 10,
  union_council: 10,
};

/**
 * GET /api/areas/:code — get area + parent + children
 */
function getArea(req, res) {
  const { code } = req.params;
  const area = prepare(SQL_GET_AREA_BY_CODE).get(code);
  if (!area) {
    throw new HttpError(404, `Area ${code} not found`, 'AREA_NOT_FOUND');
  }

  const chain = areaService.getAreaChain(code);    // top-down: country → this
  const children = areaService.getAreaChildren(code);

  return res.json({
    data: area,
    chain,            // ordered top-down
    children,
  });
}

/**
 * GET /api/areas — list with filters
 * Query: ?type=&parent=&q=&limit=&offset=
 */
function listAreas(req, res) {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const where = [];
  const params = [];
  if (req.query.type) {
    where.push('type = ?');
    params.push(req.query.type);
  }
  if (req.query.parent) {
    where.push('parent_code = ?');
    params.push(req.query.parent);
  }
  if (req.query.q) {
    where.push('(name LIKE ? OR area_code LIKE ? OR name_urdu LIKE ?)');
    const q = `%${req.query.q}%`;
    params.push(q, q, q);
  }
  if (req.query.active !== undefined) {
    where.push('is_active = ?');
    params.push(req.query.active === 'true' ? 1 : 0);
  } else {
    where.push('is_active = 1');
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = prepare(`SELECT COUNT(*) as c FROM areas ${whereClause}`).get(...params).c;
  const rows = prepare(`
    SELECT * FROM areas ${whereClause}
    ORDER BY type, name
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return res.json({ count: rows.length, total, data: rows });
}

/**
 * GET /api/areas/type/:type — list all areas of a type
 */
function listAreasByType(req, res) {
  const { type } = req.params;
  const validTypes = ['country', 'province', 'division', 'district', 'tehsil', 'village', 'union_council'];
  if (!validTypes.includes(type)) {
    throw new HttpError(400, `Invalid type. Must be one of: ${validTypes.join(', ')}`, 'VALIDATION_ERROR');
  }

  const rows = prepare(`SELECT * FROM areas WHERE type = ? AND is_active = 1 ORDER BY name`).all(type);
  return res.json({ count: rows.length, data: rows });
}

/**
 * GET /api/areas/reverse-geocode?lat=&lng=
 * Returns area chain (country → village) for a given point.
 */
function reverseGeocode(req, res) {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);

  if (isNaN(lat) || isNaN(lng)) {
    throw new HttpError(400, 'lat and lng must be valid numbers', 'VALIDATION_ERROR');
  }
  if (lat < -90 || lat > 90) {
    throw new HttpError(400, 'lat must be between -90 and 90', 'VALIDATION_ERROR');
  }
  if (lng < -180 || lng > 180) {
    throw new HttpError(400, 'lng must be between -180 and 180', 'VALIDATION_ERROR');
  }

  const result = areaService.reverseGeocode(lat, lng);

  return res.json({
    query: { lat, lng },
    chain: result.chain,
    matched_village: result.matched_village || null,
    warnings: result.warnings,
    count: result.chain.length,
  });
}

/**
 * GET /api/areas/:code/addresses — list all addresses in area (incl. descendants)
 */
function listAddressesInArea(req, res) {
  const { code } = req.params;
  const area = prepare(SQL_GET_AREA_BY_CODE).get(code);
  if (!area) {
    throw new HttpError(404, `Area ${code} not found`, 'AREA_NOT_FOUND');
  }

  const entranceIds = areaService.getEntrancesInArea(code);
  if (entranceIds.length === 0) {
    return res.json({ area: code, count: 0, data: [] });
  }

  const placeholders = entranceIds.map(() => '?').join(',');
  const rows = prepare(`
    SELECT e.entrance_id, e.uprn, e.short_code, e.gps_lat, e.gps_long,
           e.lifecycle_status, e.created_at,
           p.h3_index, p.plus_code, p.property_type, p.verification_tier, p.area_code
    FROM entrances e
    JOIN properties p ON p.uprn = e.uprn
    WHERE e.entrance_id IN (${placeholders})
    ORDER BY e.created_at DESC
  `).all(...entranceIds);

  return res.json({ area: code, count: rows.length, data: rows });
}

/**
 * POST /api/areas — create new area (admin only)
 */
function createArea(req, res) {
  const { area_code, name, name_urdu, type, parent_code, lat, lng, population } = req.body;

  // Validate parent exists (if provided)
  if (parent_code) {
    const parent = prepare(SQL_GET_AREA_BY_CODE).get(parent_code);
    if (!parent) {
      throw new HttpError(400, `Parent area ${parent_code} not found`, 'PARENT_NOT_FOUND');
    }
  }

  // Compute H3 index from lat/lng if not provided
  let h3_index = null;
  if (lat != null && lng != null) {
    const h3Res = H3_RES_BY_TYPE[type] || 7;
    h3_index = geoService.getH3Index(lat, lng, h3Res);
  }

  // Check duplicate
  const existing = prepare(SQL_GET_AREA_BY_CODE).get(area_code);
  if (existing) {
    throw new HttpError(409, `Area ${area_code} already exists`, 'DUPLICATE_AREA');
  }

  prepare(SQL_INSERT_AREA).run(
    area_code, name, name_urdu || null, type,
    parent_code || null,
    lat ?? null, lng ?? null, h3_index, population ?? null
  );

  const area = prepare(SQL_GET_AREA_BY_CODE).get(area_code);

  audit.log({
    adminId: req.auth.adminId,
    action: 'CREATE_AREA',
    resourceType: 'area',
    resourceId: area_code,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { name, type, parent_code, lat, lng },
  });

  return res.status(201).json({ message: 'Area created', data: area });
}

/**
 * PUT /api/areas/:code — update area (admin only)
 */
function updateArea(req, res) {
  const { code } = req.params;
  const { name, name_urdu, lat, lng, population, is_active } = req.body;

  const existing = prepare(SQL_GET_AREA_BY_CODE).get(code);
  if (!existing) {
    throw new HttpError(404, `Area ${code} not found`, 'AREA_NOT_FOUND');
  }

  // v0.10.7 AREA LOCK: name-plate finalization ke baad names/codes IMMUTABLE.
  // locked area ka naam, Urdu naam ya deactivate/activate kuch bhi change nahi hota.
  if (existing.locked_at) {
    throw new HttpError(409, `Area ${code} LOCKED hai (name plates finalized) — naam/codes change nahi ho sakte. Unlock pehle karo (sirf exception approval par).`, 'AREA_LOCKED');
  }

  // Recompute H3 if lat/lng changed
  let h3_index = null;
  if (lat != null && lng != null) {
    const h3Res = H3_RES_BY_TYPE[existing.type] || 7;
    h3_index = geoService.getH3Index(lat, lng, h3Res);
  }

  prepare(SQL_UPDATE_AREA).run(
    name || null, name_urdu || null,
    lat ?? null, lng ?? null,
    h3_index, population ?? null,
    is_active ?? null,
    code
  );

  const updated = prepare(SQL_GET_AREA_BY_CODE).get(code);

  audit.log({
    adminId: req.auth.adminId,
    action: 'UPDATE_AREA',
    resourceType: 'area',
    resourceId: code,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { before: existing, after: updated },
  });

  return res.json({ message: 'Area updated', data: updated });
}

/**
 * DELETE /api/areas/:code — deactivate area (admin only, soft delete)
 */
function deleteArea(req, res) {
  const { code } = req.params;
  const existing = prepare(SQL_GET_AREA_BY_CODE).get(code);
  if (!existing) {
    throw new HttpError(404, `Area ${code} not found`, 'AREA_NOT_FOUND');
  }

  // v0.10.7 AREA LOCK: locked area deactivate bhi nahi hota
  if (existing.locked_at) {
    throw new HttpError(409, `Area ${code} LOCKED hai — deactivate nahi ho sakta. Unlock pehle karo.`, 'AREA_LOCKED');
  }

  // Check if area has children — don't allow deactivation if so
  const children = areaService.getAreaChildren(code);
  if (children.length > 0) {
    throw new HttpError(400, `Cannot deactivate ${code} — has ${children.length} active children. Deactivate them first.`, 'AREA_HAS_CHILDREN');
  }

  prepare(SQL_DEACTIVATE_AREA).run(code);

  audit.log({
    adminId: req.auth.adminId,
    action: 'DEACTIVATE_AREA',
    resourceType: 'area',
    resourceId: code,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { name: existing.name, type: existing.type },
  });

  return res.json({ message: `Area ${code} deactivated` });
}

/**
 * POST /api/areas/seed — bulk import areas from JSON (admin only)
 *
 * Body format:
 * {
 *   "areas": [
 *     { "area_code": "PK", "name": "Pakistan", "type": "country", "lat": 30.3753, "lng": 69.3451 },
 *     ...
 *   ]
 * }
 */
function seedAreas(req, res) {
  const { areas } = req.body;

  if (!Array.isArray(areas) || areas.length === 0) {
    throw new HttpError(400, 'Body must contain "areas" array', 'VALIDATION_ERROR');
  }

  let inserted = 0;
  let skipped = 0;
  const errors = [];

  const insertTx = db.transaction((items) => {
    for (const item of items) {
      try {
        // Check if already exists (idempotent)
        const existing = prepare(SQL_GET_AREA_BY_CODE).get(item.area_code);
        if (existing) {
          skipped++;
          continue;
        }

        // Validate parent if provided
        if (item.parent_code) {
          const parent = prepare(SQL_GET_AREA_BY_CODE).get(item.parent_code);
          if (!parent) {
            errors.push(`Area ${item.area_code}: parent ${item.parent_code} not found (skipping)`);
            skipped++;
            continue;
          }
        }

        // Compute H3 index
        let h3_index = null;
        if (item.lat != null && item.lng != null) {
          const h3Res = H3_RES_BY_TYPE[item.type] || 7;
          h3_index = geoService.getH3Index(item.lat, item.lng, h3Res);
        }

        prepare(SQL_INSERT_AREA).run(
          item.area_code,
          item.name,
          item.name_urdu || null,
          item.type,
          item.parent_code || null,
          item.lat ?? null,
          item.lng ?? null,
          h3_index,
          item.population ?? null
        );
        inserted++;
      } catch (err) {
        errors.push(`Area ${item.area_code || '(unknown)'}: ${err.message}`);
        skipped++;
      }
    }
  });

  insertTx(areas);

  audit.log({
    adminId: req.auth.adminId,
    action: 'SEED_AREAS',
    resourceType: 'area',
    resourceId: 'bulk',
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { total_input: areas.length, inserted, skipped, errors_count: errors.length },
  });

  return res.status(201).json({
    message: `Seed complete: ${inserted} inserted, ${skipped} skipped`,
    total_input: areas.length,
    inserted,
    skipped,
    errors: errors.length > 0 ? errors.slice(0, 20) : undefined, // first 20 errors
  });
}

/**
 * POST /api/addresses/:code/assign-area — manually assign address to area chain
 * Body: { area_codes: ['PK', 'PK-PB', ...] } OR { lat, lng } (auto reverse-geocode)
 */
function assignAreaToAddress(req, res) {
  const { code } = req.params;
  const { area_codes, lat, lng, assigned_by } = req.body;

  // Get entrance by short_code
  const entrance = prepare('SELECT entrance_id, short_code FROM entrances WHERE short_code = ?').get(code);
  if (!entrance) {
    throw new HttpError(404, `Address ${code} not found`, 'ADDRESS_NOT_FOUND');
  }

  let finalAreaCodes = area_codes;

  // If lat/lng provided instead, reverse-geocode
  if (!area_codes && lat != null && lng != null) {
    const result = areaService.reverseGeocode(lat, lng);
    finalAreaCodes = result.chain.map(a => a.area_code);

    if (finalAreaCodes.length === 0) {
      throw new HttpError(400, 'Reverse geocode returned no areas. Seed area data first.', 'NO_AREAS_FOUND');
    }
  }

  if (!finalAreaCodes || finalAreaCodes.length === 0) {
    throw new HttpError(400, 'Either area_codes array or lat/lng must be provided', 'VALIDATION_ERROR');
  }

  areaService.assignEntranceToAreas(entrance.entrance_id, finalAreaCodes, assigned_by || 'manual');

  audit.log({
    adminId: req.auth.adminId,
    action: 'ASSIGN_AREA',
    resourceType: 'entrance',
    resourceId: entrance.entrance_id,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { short_code: code, area_codes: finalAreaCodes, assigned_by: assigned_by || 'manual' },
  });

  const areas = areaService.getEntranceAreas(entrance.entrance_id);
  return res.json({
    message: 'Area assigned',
    data: {
      entrance_id: entrance.entrance_id,
      short_code: entrance.short_code,
      areas,
    },
  });
}

/**
 * POST /api/areas/seed-default
 * Loads default Pakistan areas from bundled JSON file.
 * No body needed. Admin only.
 */
function seedDefaultAreas(req, res) {
  const seedFilePath = path.join(__dirname, '..', 'data', 'seed-areas-pakistan.json');

  if (!fs.existsSync(seedFilePath)) {
    throw new HttpError(500, 'Seed file not found on server', 'SEED_FILE_MISSING');
  }

  const fileContent = fs.readFileSync(seedFilePath, 'utf8');
  let seedData;
  try {
    seedData = JSON.parse(fileContent);
  } catch (err) {
    throw new HttpError(500, 'Invalid seed file format', 'SEED_FILE_INVALID');
  }

  const areas = seedData.areas;
  if (!Array.isArray(areas) || areas.length === 0) {
    throw new HttpError(400, 'Seed file must contain "areas" array', 'VALIDATION_ERROR');
  }

  let inserted = 0;
  let skipped = 0;
  const errors = [];

  const insertTx = db.transaction((items) => {
    for (const item of items) {
      try {
        const existing = prepare(SQL_GET_AREA_BY_CODE).get(item.area_code);
        if (existing) {
          skipped++;
          continue;
        }

        if (item.parent_code) {
          const parent = prepare(SQL_GET_AREA_BY_CODE).get(item.parent_code);
          if (!parent) {
            errors.push(`Area ${item.area_code}: parent ${item.parent_code} not found (skipping)`);
            skipped++;
            continue;
          }
        }

        let h3_index = null;
        if (item.lat != null && item.lng != null) {
          const h3Res = H3_RES_BY_TYPE[item.type] || 7;
          h3_index = geoService.getH3Index(item.lat, item.lng, h3Res);
        }

        prepare(SQL_INSERT_AREA).run(
          item.area_code,
          item.name,
          item.name_urdu || null,
          item.type,
          item.parent_code || null,
          item.lat ?? null,
          item.lng ?? null,
          h3_index,
          item.population ?? null
        );
        inserted++;
      } catch (err) {
        errors.push(`Area ${item.area_code || '(unknown)'}: ${err.message}`);
        skipped++;
      }
    }
  });

  insertTx(areas);

  audit.log({
    adminId: req.auth.adminId,
    action: 'SEED_DEFAULT_AREAS',
    resourceType: 'area',
    resourceId: 'default',
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { total_input: areas.length, inserted, skipped, errors_count: errors.length },
  });

  return res.status(201).json({
    message: `Default seed complete: ${inserted} inserted, ${skipped} skipped`,
    total_input: areas.length,
    inserted,
    skipped,
    errors: errors.length > 0 ? errors.slice(0, 20) : undefined,
  });
}

/**
 * POST /api/areas/:code/lock — v0.10.7 Mashwara Box
 * Stage-3 (name plates finalized) par village ka naam/code FOREVER immutable.
 * Idempotent: pehle se locked → 200 (no-op), koi error nahi.
 */
function lockArea(req, res) {
  const { code } = req.params;
  const existing = prepare(SQL_GET_AREA_BY_CODE).get(code);
  if (!existing) {
    throw new HttpError(404, `Area ${code} not found`, 'AREA_NOT_FOUND');
  }

  if (!existing.locked_at) {
    prepare(SQL_LOCK_AREA).run(Date.now(), req.auth.adminId, code);
    audit.log({
      adminId: req.auth.adminId,
      action: 'LOCK_AREA',
      resourceType: 'area',
      resourceId: code,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      details: { name: existing.name, type: existing.type, warning: 'names/codes ab IMMUTABLE hain' },
    });
  }

  const updated = prepare(SQL_GET_AREA_BY_CODE).get(code);
  return res.json({ message: `Area ${code} locked — naam/codes ab immutable hain`, data: { area_code: code, locked_at: updated.locked_at, locked_by: updated.locked_by } });
}

/**
 * POST /api/areas/:code/unlock — v0.10.7 Mashwara Box
 * EXCEPTION path — sirf documented approval par (audit loud hai).
 */
function unlockArea(req, res) {
  const { code } = req.params;
  const existing = prepare(SQL_GET_AREA_BY_CODE).get(code);
  if (!existing) {
    throw new HttpError(404, `Area ${code} not found`, 'AREA_NOT_FOUND');
  }

  if (existing.locked_at) {
    prepare(SQL_UNLOCK_AREA).run(code);
    audit.log({
      adminId: req.auth.adminId,
      action: 'UNLOCK_AREA',
      resourceType: 'area',
      resourceId: code,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      details: { name: existing.name, type: existing.type, was_locked_at: existing.locked_at, warning: 'LOCK EXCEPTION — reason document karo' },
    });
  }

  const updated = prepare(SQL_GET_AREA_BY_CODE).get(code);
  return res.json({ message: `Area ${code} unlocked`, data: { area_code: code, locked_at: updated.locked_at } });
}

module.exports = {
  getArea,
  listAreas,
  listAreasByType,
  reverseGeocode,
  listAddressesInArea,
  createArea,
  updateArea,
  deleteArea,
  lockArea,
  unlockArea,
  seedAreas,
  seedDefaultAreas,
  assignAreaToAddress,
};
