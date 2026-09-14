/**
 * GeoPata — Area Service (v0.3.0)
 *
 * Helpers for:
 *  - Reverse geocoding (lat/lng → area chain)
 *  - Hierarchy traversal (area → parent chain → children)
 *  - Area assignment for entrances
 *
 * Phase 1 (current): nearest-centroid matching with Haversine.
 * Phase 2 (future): point-in-polygon with GeoJSON boundaries.
 */

const db = require('../config/database');
const { prepare } = db;
const geoService = require('./geoService');

// SQL templates
const SQL_GET_AREA_BY_CODE = `SELECT * FROM areas WHERE area_code = ?`;
const SQL_GET_AREA_CHILDREN = `SELECT * FROM areas WHERE parent_code = ? AND is_active = 1 ORDER BY name`;
const SQL_GET_ALL_ACTIVE_AREAS = `SELECT * FROM areas WHERE is_active = 1 ORDER BY type, name`;
const SQL_LIST_AREAS_BY_TYPE = `SELECT * FROM areas WHERE type = ? AND is_active = 1 ORDER BY name`;

// Reverse geocoding: find nearest areas at each level.
// Strategy: at each level (village, tehsil, district, division, province, country),
// find the area with minimum Haversine distance to the input point.
//
// v0.8.0: bbox prefilter on villages (150k+ rows after Pakistan seed).
// Uses idx_areas_lat_lng for a fast range scan before the distance ordering.
// Window 0.15 deg (~16km) safely covers the 10km village threshold.
const SQL_NEAREST_VILLAGES = `
  SELECT * FROM areas
  WHERE type IN ('village','union_council') AND is_active = 1
    AND lat IS NOT NULL AND lng IS NOT NULL
    AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
  ORDER BY (lat - ?) * (lat - ?) + (lng - ?) * (lng - ?) ASC
  LIMIT 10
`;
const SQL_NEAREST_TEHSILS = `
  SELECT * FROM areas
  WHERE type = 'tehsil' AND is_active = 1
    AND lat IS NOT NULL AND lng IS NOT NULL
  ORDER BY (lat - ?) * (lat - ?) + (lng - ?) * (lng - ?) ASC
  LIMIT 5
`;
const SQL_NEAREST_DISTRICTS = `
  SELECT * FROM areas
  WHERE type = 'district' AND is_active = 1
    AND lat IS NOT NULL AND lng IS NOT NULL
  ORDER BY (lat - ?) * (lat - ?) + (lng - ?) * (lng - ?) ASC
  LIMIT 5
`;
const SQL_NEAREST_DIVISIONS = `
  SELECT * FROM areas
  WHERE type = 'division' AND is_active = 1
    AND lat IS NOT NULL AND lng IS NOT NULL
  ORDER BY (lat - ?) * (lat - ?) + (lng - ?) * (lng - ?) ASC
  LIMIT 5
`;
const SQL_GET_PROVINCES = `SELECT * FROM areas WHERE type IN ('province', 'territory') AND is_active = 1 ORDER BY name`;
const SQL_GET_COUNTRY = `SELECT * FROM areas WHERE type = 'country' AND is_active = 1 LIMIT 1`;

// Thresholds (km) — if nearest area at a level is farther than this, skip it.
const THRESHOLDS_KM = {
  village: 10,        // 10 km — villages are close
  tehsil: 50,         // 50 km
  district: 100,      // 100 km
  division: 300,      // 300 km
};

/**
 * Walk up the parent chain from a given area code.
 * Returns array from country → ... → given area (top-down).
 *
 * @param {string} areaCode
 * @returns {object[]} ordered chain
 */
function getAreaChain(areaCode) {
  const chain = [];
  let current = areaCode;
  const visited = new Set(); // prevent infinite loops

  while (current && !visited.has(current)) {
    visited.add(current);
    const area = prepare(SQL_GET_AREA_BY_CODE).get(current);
    if (!area) break;
    chain.unshift(area); // prepend so order is top-down
    current = area.parent_code;
  }

  return chain;
}

/**
 * Get children of an area (immediate level only).
 * @param {string} areaCode
 * @returns {object[]}
 */
function getAreaChildren(areaCode) {
  return prepare(SQL_GET_AREA_CHILDREN).all(areaCode);
}

/**
 * Reverse geocode: lat/lng → area chain (country → village).
 *
 * Phase 1 algorithm (nearest centroid):
 *   1. Find nearest village within 10km
 *   2. Find nearest tehsil within 50km
 *   3. Find nearest district within 100km
 *   4. Find nearest division within 300km
 *   5. Get all provinces (small list, pick nearest by Haversine)
 *   6. Get country (single row)
 *   7. Validate chain consistency (child's parent_code matches upper level)
 *   8. Return ordered chain top-down
 *
 * If a village is found, prefer walking up its parent chain (more accurate).
 *
 * @param {number} lat
 * @param {number} lng
 * @returns {{chain: object[], matched_village?: object, warnings: string[]}}
 */
function reverseGeocode(lat, lng) {
  const warnings = [];

  // Step 1: Find nearest village (bbox prefilter ~16km window, then precise check)
  const BBOX_VILLAGE = 0.15; // degrees
  const villageCandidates = prepare(SQL_NEAREST_VILLAGES).all(
    lat - BBOX_VILLAGE, lat + BBOX_VILLAGE, lng - BBOX_VILLAGE, lng + BBOX_VILLAGE,
    lat, lat, lng, lng
  );
  let nearestVillage = null;
  let nearestVillageDist = Infinity;

  for (const v of villageCandidates) {
    const d = geoService.haversineMeters(lat, lng, v.lat, v.lng) / 1000; // km
    if (d < nearestVillageDist) {
      nearestVillageDist = d;
      nearestVillage = v;
    }
  }

  // If nearest village is within threshold, walk up its chain — most accurate
  if (nearestVillage && nearestVillageDist <= THRESHOLDS_KM.village) {
    const chain = getAreaChain(nearestVillage.area_code);
    return {
      chain,
      matched_village: { ...nearestVillage, distance_km: parseFloat(nearestVillageDist.toFixed(2)) },
      warnings,
    };
  }

  if (nearestVillage) {
    warnings.push(`Nearest village ${nearestVillage.name} is ${nearestVillageDist.toFixed(2)} km away (threshold: ${THRESHOLDS_KM.village} km). Skipping village level.`);
  } else {
    warnings.push('No villages found in DB. Skipping village level.');
  }

  // Step 2-5: Build chain level-by-level with fallbacks
  const chain = [];

  // Country (single row, always)
  const country = prepare(SQL_GET_COUNTRY).get();
  if (country) chain.push(country);

  // Provinces (pick nearest by Haversine)
  const provinces = prepare(SQL_GET_PROVINCES).all();
  let nearestProvince = null;
  let nearestProvinceDist = Infinity;
  for (const p of provinces) {
    if (p.lat == null || p.lng == null) continue;
    const d = geoService.haversineMeters(lat, lng, p.lat, p.lng) / 1000;
    if (d < nearestProvinceDist) {
      nearestProvinceDist = d;
      nearestProvince = p;
    }
  }
  if (nearestProvince) chain.push(nearestProvince);
  else warnings.push('No provinces in DB.');

  // Division (nearest within 300km)
  const division = findNearest(SQL_NEAREST_DIVISIONS, lat, lng, THRESHOLDS_KM.division, warnings, 'division');
  if (division) {
    // If division's parent doesn't match our province, still include but warn
    if (nearestProvince && division.parent_code !== nearestProvince.area_code) {
      warnings.push(`Division ${division.name} belongs to ${division.parent_code}, not ${nearestProvince.area_code}. Including anyway.`);
    }
    chain.push(division);
  }

  // District (nearest within 100km)
  const district = findNearest(SQL_NEAREST_DISTRICTS, lat, lng, THRESHOLDS_KM.district, warnings, 'district');
  if (district) {
    if (division && district.parent_code !== division.area_code) {
      warnings.push(`District ${district.name} belongs to ${district.parent_code}, not ${division.area_code}. Including anyway.`);
    }
    chain.push(district);
  }

  // Tehsil (nearest within 50km)
  const tehsil = findNearest(SQL_NEAREST_TEHSILS, lat, lng, THRESHOLDS_KM.tehsil, warnings, 'tehsil');
  if (tehsil) {
    if (district && tehsil.parent_code !== district.area_code) {
      warnings.push(`Tehsil ${tehsil.name} belongs to ${tehsil.parent_code}, not ${district.area_code}. Including anyway.`);
    }
    chain.push(tehsil);
  }

  return { chain, matched_village: null, warnings };
}

/**
 * Helper: find nearest area from a SQL query, within threshold (km).
 */
function findNearest(sql, lat, lng, thresholdKm, warnings, label) {
  const candidates = prepare(sql).all(lat, lat, lng, lng);
  let nearest = null;
  let nearestDist = Infinity;
  for (const c of candidates) {
    const d = geoService.haversineMeters(lat, lng, c.lat, c.lng) / 1000;
    if (d < nearestDist) {
      nearestDist = d;
      nearest = c;
    }
  }
  if (!nearest) {
    warnings.push(`No ${label} found in DB.`);
    return null;
  }
  if (nearestDist > thresholdKm) {
    warnings.push(`Nearest ${label} ${nearest.name} is ${nearestDist.toFixed(2)} km away (threshold: ${thresholdKm} km). Skipping.`);
    return null;
  }
  return nearest;
}

/**
 * Assign an entrance to its area chain.
 * Replaces any existing assignments (deletes + reinserts in transaction).
 *
 * @param {number} entranceId
 * @param {string[]} areaCodes (ordered top-down: country → village)
 * @param {string} assignedBy ('auto' | 'admin' | 'manual')
 */
function assignEntranceToAreas(entranceId, areaCodes, assignedBy = 'auto') {
  if (!areaCodes || areaCodes.length === 0) return;

  const tx = db.transaction(() => {
    // Clear existing assignments
    prepare('DELETE FROM address_areas WHERE entrance_id = ?').run(entranceId);

    // Insert new assignments
    const stmt = prepare(`
      INSERT INTO address_areas (entrance_id, area_code, assigned_by)
      VALUES (?, ?, ?)
    `);
    for (const code of areaCodes) {
      stmt.run(entranceId, code, assignedBy);
    }

    // Update properties.area_code to most specific (last in chain)
    const mostSpecific = areaCodes[areaCodes.length - 1];
    const entrance = prepare('SELECT uprn FROM entrances WHERE entrance_id = ?').get(entranceId);
    if (entrance) {
      prepare('UPDATE properties SET area_code = ?, updated_at = CURRENT_TIMESTAMP WHERE uprn = ?')
        .run(mostSpecific, entrance.uprn);
    }
  });

  tx();
}

/**
 * Get all area codes linked to an entrance.
 * @param {number} entranceId
 * @returns {object[]} area rows
 */
function getEntranceAreas(entranceId) {
  return prepare(`
    SELECT a.* FROM address_areas aa
    JOIN areas a ON a.area_code = aa.area_code
    WHERE aa.entrance_id = ?
    ORDER BY a.type DESC
  `).all(entranceId);
}

/**
 * Get all entrances in a given area (direct + descendants).
 * Walks down the area subtree to include all child areas.
 *
 * @param {string} areaCode
 * @returns {number[]} entrance IDs
 */
function getEntrancesInArea(areaCode) {
  // Collect area_code + all descendant area_codes
  const allCodes = collectDescendantCodes(areaCode);
  if (allCodes.length === 0) return [];

  const placeholders = allCodes.map(() => '?').join(',');
  return prepare(`
    SELECT DISTINCT entrance_id FROM address_areas
    WHERE area_code IN (${placeholders})
  `).all(...allCodes).map(r => r.entrance_id);
}

/**
 * Recursively collect area_code + all descendants.
 */
function collectDescendantCodes(areaCode) {
  const result = [areaCode];
  const stack = [areaCode];
  while (stack.length) {
    const current = stack.pop();
    const children = prepare('SELECT area_code FROM areas WHERE parent_code = ?').all(current);
    for (const c of children) {
      if (!result.includes(c.area_code)) {
        result.push(c.area_code);
        stack.push(c.area_code);
      }
    }
  }
  return result;
}

module.exports = {
  getAreaChain,
  getAreaChildren,
  reverseGeocode,
  assignEntranceToAreas,
  getEntranceAreas,
  getEntrancesInArea,
  collectDescendantCodes,
  THRESHOLDS_KM,
};
