/**
 * GeoPata — Bulk Address Import Controller (v0.7.0)
 *
 * Imports addresses from spreadsheets (CSV uploaded via dashboard).
 *
 * Endpoint:
 *   POST /api/addresses/bulk-import   (JWT verifier+)
 *   Body: { rows: [{ village_code, gps_lat, gps_long, display_name?, house_number?, property_type? }] }
 *   Max 5000 rows per request (zod schema enforces).
 *
 * Per-row flow:
 *   1. Resolve village_code → area (must exist, type village/union_council)
 *   2. Auto-detect Qibla zone + block via village boundary (if any)
 *   3. Create property + entrance (same logic as POST /api/address)
 *   4. Generate share_code (public address ID)
 *   5. Assign area chain (village + all parents) to address_areas
 *   6. Record per-row success/failure
 *
 * Invalid rows do NOT abort the batch — they are reported individually.
 * Audit: single BULK_IMPORT entry per batch + per-row CREATE_ADDRESS entries.
 */

const db = require('../config/database');
const { prepare } = db;
const { HttpError } = require('../middleware/errorHandler');
const geoService = require('../services/geoService');
const areaService = require('../services/areaService');
const audit = require('../services/auditService');
const { generateUPRN, generateShortCode, generatePublicAddressId } = require('../services/idGenerator');
const { bulkImportRowStrictSchema } = require('../schemas');

const SQL_GET_AREA = `SELECT * FROM areas WHERE area_code = ? AND is_active = 1`;

const SQL_INSERT_PROPERTY = `
  INSERT INTO properties (uprn, h3_index, plus_code, property_type, verification_tier,
                          display_name, block_code, street_number, house_number, share_code, area_code)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SQL_INSERT_ENTRANCE = `
  INSERT INTO entrances (uprn, short_code, gps_lat, gps_long)
  VALUES (?, ?, ?, ?)
`;

const SQL_INSERT_ADDRESS_AREA = `
  INSERT OR IGNORE INTO address_areas (entrance_id, area_code, assigned_by)
  VALUES (?, ?, 'bulk_import')
`;

const SQL_CHECK_SHARE_CODE = `SELECT 1 FROM properties WHERE share_code = ?`;
const SQL_CHECK_SHORT_CODE = `SELECT 1 FROM entrances WHERE short_code = ?`;

const BLOCK_TO_ZONE = { A: 'Q', B: 'R', C: 'B', D: 'L' };

/**
 * Import a single row. Returns the created entrance row.
 * Throws HttpError with a descriptive message on failure.
 */
function importRow(row) {
  // 1. Resolve village area
  const village = prepare(SQL_GET_AREA).get(row.village_code);
  if (!village) {
    throw new HttpError(400, `Village with code ${row.village_code} not found`, 'VILLAGE_NOT_FOUND');
  }
  if (village.type !== 'village' && village.type !== 'union_council') {
    throw new HttpError(400, `Area ${row.village_code} is a ${village.type}, not a village`, 'NOT_A_VILLAGE');
  }

  // 2. Zone + block detection (same as createAddress)
  const h3_index = geoService.getH3Index(row.gps_lat, row.gps_long);
  const plus_code = geoService.getPlusCode(row.gps_lat, row.gps_long);
  const uprn = generateUPRN();
  const short_code = generateShortCode();

  let blockCode = null;
  let zone = null;
  try {
    const boundaryService = require('../services/villageBoundaryService');
    const detection = boundaryService.detectBlock(row.gps_lat, row.gps_long);
    if (detection.found && detection.block && detection.block !== '?') {
      blockCode = detection.block;
      zone = detection.zone || null;
    }
  } catch {
    // no boundary — fall back to village-only addressing
  }

  // 3. Share code (public address ID) — guaranteed unique
  let share_code = null;
  if (zone) {
    share_code = generatePublicAddressId(village.name, zone, row.house_number || '01', row.house_number || '001');
    // v0.6.0 format puts street in second segment; bulk CSV has no street column,
    // so use house_number for both street + house (common in village data).
    if (share_code && prepare(SQL_CHECK_SHARE_CODE).get(share_code)) {
      // Append a 2-digit suffix until unique (same approach as createAddress)
      let suffix = 1;
      let candidate = `${share_code}-${String(suffix).padStart(2, '0')}`;
      while (prepare(SQL_CHECK_SHARE_CODE).get(candidate)) {
        suffix++;
        candidate = `${share_code}-${String(suffix).padStart(2, '0')}`;
      }
      share_code = candidate;
    }
  }

  // 4. Insert property + entrance in one transaction
  const entranceId = db.transaction(() => {
    prepare(SQL_INSERT_PROPERTY).run(
      uprn, h3_index, plus_code,
      row.property_type || 'Residential',
      1, // tier 1: map-dropped (imported from spreadsheet)
      row.display_name || null,
      blockCode, null, row.house_number || null,
      share_code,
      village.area_code
    );
    const result = prepare(SQL_INSERT_ENTRANCE).run(uprn, short_code, row.gps_lat, row.gps_long);
    return result.lastInsertRowid;
  })();

  // 5. Assign area chain (village + parents)
  try {
    const chain = areaService.getAreaChain(village.area_code);
    for (const area of chain) {
      prepare(SQL_INSERT_ADDRESS_AREA).run(entranceId, area.area_code);
    }
  } catch {
    // non-fatal: area link can be fixed later via assign-area
  }

  return { entranceId, uprn, short_code, share_code };
}

/**
 * POST /api/addresses/bulk-import
 */
async function bulkImport(req, res) {
  const { rows } = req.body;

  const results = {
    imported: 0,
    failed: 0,
    errors: [],
    imported_codes: [],
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // Per-row strict validation (GPS ranges, area code format, etc.)
    const parsed = bulkImportRowStrictSchema.safeParse(row);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      results.failed++;
      results.errors.push({
        row: i + 1,
        village_code: row?.village_code || null,
        display_name: row?.display_name || null,
        message: `Invalid row: ${firstIssue?.path?.join('.') || 'field'} — ${firstIssue?.message || 'validation failed'}`,
      });
      continue;
    }
    try {
      const created = importRow(parsed.data);
      results.imported++;
      results.imported_codes.push(created.short_code);

      audit.log({
        adminId: req.auth?.adminId,
        action: 'CREATE_ADDRESS',
        resourceType: 'entrance',
        resourceId: created.entranceId,
        ipAddress: req.auth?.ipAddress,
        userAgent: req.auth?.userAgent,
        details: {
          uprn: created.uprn,
          short_code: created.short_code,
          share_code: created.share_code,
          source: 'bulk_import',
          batch_row: i + 1,
          gps_lat: row.gps_lat,
          gps_long: row.gps_long,
          display_name: row.display_name || null,
          house_number: row.house_number || null,
        },
      });
    } catch (err) {
      results.failed++;
      results.errors.push({
        row: i + 1,
        village_code: row.village_code,
        display_name: row.display_name || null,
        message: err instanceof HttpError ? err.message : (err.message || 'Unknown error'),
      });
    }
  }

  audit.log({
    adminId: req.auth?.adminId,
    action: 'BULK_IMPORT',
    resourceType: 'property',
    resourceId: null,
    ipAddress: req.auth?.ipAddress,
    userAgent: req.auth?.userAgent,
    details: {
      total_rows: rows.length,
      imported: results.imported,
      failed: results.failed,
      error_count: results.errors.length,
    },
  });

  const status = results.imported > 0 ? 200 : (results.failed > 0 ? 422 : 400);
  return res.status(status).json({
    message: `Import complete: ${results.imported} imported, ${results.failed} failed`,
    ...results,
  });
}

module.exports = { bulkImport, importRow };
