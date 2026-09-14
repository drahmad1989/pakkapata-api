/**
 * GeoPata — Public Lookup Controller (v0.7.0)
 *
 * Unauthenticated, privacy-safe address lookup.
 * Used by: public lookup page, RabtaChat users verifying addresses manually.
 *
 * PRIVACY CONTRACT (critical):
 *   Returns ONLY: code, display_name, village/area chain names, zone, block,
 *   house, property_type, verification_tier, lifecycle_status.
 *
 *   NEVER returns: gps_lat/gps_long, uprn, h3_index, plus_code, nfc_tag_id,
 *   occupants, CNIC, phone numbers, or any internal IDs.
 *
 * Lookup accepts BOTH code formats:
 *   - short_code:  BGL-0001         (entrances.short_code — internal style)
 *   - share_code:  BONG-Q07-025     (properties.share_code — public style)
 */

const db = require('../config/database');
const { prepare } = db;
const { HttpError } = require('../middleware/errorHandler');

const SQL_FIND_ENTRANCE_BY_SHORT_CODE = `
  SELECT e.entrance_id, e.short_code, e.lifecycle_status, e.created_at,
         p.display_name, p.share_code, p.property_type, p.verification_tier,
         p.block_code, p.street_number, p.house_number, p.area_code
  FROM entrances e
  JOIN properties p ON p.uprn = e.uprn
  WHERE e.short_code = ?
`;

const SQL_FIND_ENTRANCE_BY_SHARE_CODE = `
  SELECT e.entrance_id, e.short_code, e.lifecycle_status, e.created_at,
         p.display_name, p.share_code, p.property_type, p.verification_tier,
         p.block_code, p.street_number, p.house_number, p.area_code
  FROM entrances e
  JOIN properties p ON p.uprn = e.uprn
  WHERE p.share_code = ?
`;

const SQL_VILLAGE_FROM_ADDRESS_AREAS = `
  SELECT a.area_code, a.name, a.name_urdu, a.type
  FROM address_areas aa
  JOIN areas a ON a.area_code = aa.area_code
  WHERE aa.entrance_id = ? AND a.type IN ('village', 'union_council') AND a.is_active = 1
  LIMIT 1
`;

const SQL_AREA_BY_CODE = `SELECT area_code, name, name_urdu, type, parent_code FROM areas WHERE area_code = ?`;

// v0.4.0 block letters → Qibla zone letters (backward compat)
const BLOCK_TO_ZONE = { A: 'Q', B: 'R', C: 'B', D: 'L' };

const TIER_LABELS = {
  0: 'Unverified',
  1: 'Map-dropped',
  2: 'GIS verified',
  3: 'Tag installed',
  4: 'KYC linked',
};

/**
 * Resolve the village area for an entrance.
 * Priority: properties.area_code → address_areas link.
 */
function resolveVillage(entrance) {
  if (entrance.area_code) {
    const area = prepare(SQL_AREA_BY_CODE).get(entrance.area_code);
    if (area) {
      if (area.type === 'village' || area.type === 'union_council') return area;
      // Walk down is not possible; walk up instead to find a village ancestor
      return null;
    }
  }
  const linked = prepare(SQL_VILLAGE_FROM_ADDRESS_AREAS).get(entrance.entrance_id);
  return linked || null;
}

/**
 * Walk up from village to build a readable parent chain (tehsil/district/province).
 */
function buildPlaceChain(villageAreaCode) {
  const chain = { tehsil: null, district: null, province: null, country: null };
  if (!villageAreaCode) return chain;

  const typeToKey = {
    tehsil: 'tehsil',
    district: 'district',
    province: 'province',
    territory: 'province',
    country: 'country',
  };

  let current = prepare(SQL_AREA_BY_CODE).get(villageAreaCode)?.parent_code;
  let hops = 0;
  const visited = new Set();

  while (current && hops < 8 && !visited.has(current)) {
    visited.add(current);
    const area = prepare(SQL_AREA_BY_CODE).get(current);
    if (!area) break;
    const key = typeToKey[area.type];
    if (key && !chain[key]) chain[key] = area.name;
    current = area.parent_code;
    hops++;
  }

  return chain;
}

/**
 * Parse zone/block/house from the public code.
 * share_code format: VILLAGE-ZSS-NNN (e.g. BONG-Q07-025)
 *   Z = Qibla zone (Q/R/B/L), SS = block number, NNN = house number
 */
function parseCodeParts(entrance) {
  const result = { zone: null, block: null, house: null };

  if (entrance.share_code) {
    const parts = entrance.share_code.split('-');
    if (parts.length >= 3) {
      const zPart = parts[1]; // e.g. "Q07"
      const zoneLetter = zPart.charAt(0).toUpperCase();
      if ('QRBL'.includes(zoneLetter)) {
        result.zone = zoneLetter;
        result.block = zPart.slice(1) || null;
        result.house = parts[2] || null;
      }
    }
  }

  // Fallbacks from v0.4.0 fields
  if (!result.zone && entrance.block_code) {
    const bc = String(entrance.block_code).trim().toUpperCase();
    if (BLOCK_TO_ZONE[bc]) {
      result.zone = BLOCK_TO_ZONE[bc];
      result.block = result.block || null;
    } else if (bc.length > 0 && 'QRBL'.includes(bc.charAt(0))) {
      result.zone = bc.charAt(0);
      result.block = result.block || bc.slice(1) || null;
    }
  }
  if (!result.house && entrance.house_number) {
    result.house = String(entrance.house_number);
  }
  if (!result.block && entrance.street_number) {
    result.block = String(entrance.street_number);
  }

  return result;
}

/**
 * GET /api/public/address/:code  — privacy-safe lookup (no auth)
 */
function publicLookup(req, res) {
  const { code } = req.params;
  const normalized = String(code).trim().toUpperCase();

  let entrance = prepare(SQL_FIND_ENTRANCE_BY_SHARE_CODE).get(normalized);
  if (!entrance) {
    entrance = prepare(SQL_FIND_ENTRANCE_BY_SHORT_CODE).get(normalized);
  }
  if (!entrance) {
    throw new HttpError(404, `No address found for code ${normalized}`, 'ADDRESS_NOT_FOUND');
  }
  if (entrance.lifecycle_status === 'Deprecated' || entrance.lifecycle_status === 'Merged') {
    return res.json({
      found: false,
      message: `Address ${normalized} is ${entrance.lifecycle_status.toLowerCase()} and no longer in use.`,
    });
  }

  const village = resolveVillage(entrance);
  const chain = buildPlaceChain(village?.area_code);
  const parts = parseCodeParts(entrance);

  return res.json({
    found: true,
    data: {
      code: entrance.share_code || entrance.short_code,
      display_name: entrance.display_name || null,
      village: village ? { name: village.name, name_urdu: village.name_urdu || null } : null,
      tehsil: chain.tehsil,
      district: chain.district,
      province: chain.province,
      zone: parts.zone,
      block: parts.block,
      house: parts.house,
      property_type: entrance.property_type,
      verification_tier: entrance.verification_tier,
      verification_label: TIER_LABELS[entrance.verification_tier] || 'Unverified',
      lifecycle_status: entrance.lifecycle_status,
      registered_on: entrance.created_at ? String(entrance.created_at).slice(0, 10) : null,
    },
  });
}

module.exports = { publicLookup };
