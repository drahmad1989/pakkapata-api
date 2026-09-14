/**
 * GeoPata — Village Boundary Service (v0.4.2)
 *
 * Handles polygon-based block detection:
 *  - Point-in-polygon check (is pin inside village boundary?)
 *  - Quadrant detection (NE/SE/SW/NW → Block A/B/C/D)
 *  - Polygon centroid calculation
 *
 * Polygon format (GeoJSON):
 *   {
 *     "type": "Polygon",
 *     "coordinates": [[[lat,lng], [lat,lng], ...]]
 *   }
 *   Note: First and last point should be same (closed ring).
 */

const db = require('../config/database');
const { prepare } = db;

// SQL templates
const SQL_GET_BOUNDARY_BY_AREA = `SELECT * FROM village_boundaries WHERE area_code = ? AND is_active = 1`;
const SQL_GET_BOUNDARY_BY_LATLNG = `
  SELECT * FROM village_boundaries WHERE is_active = 1
    AND centroid_lat BETWEEN ? AND ? AND centroid_lng BETWEEN ? AND ?
  ORDER BY (centroid_lat - ?) * (centroid_lat - ?) + (centroid_lng - ?) * (centroid_lng - ?) ASC
  LIMIT 1
`;
// v0.8.0: bbox prefilter window (~9km) — covers auto-seeded city circles (max 4km radius).
// Points farther than the window get found:false and fall back to village-centroid zoning.
const BBOX_BOUNDARY = 0.08; // degrees
const SQL_INSERT_BOUNDARY = `
  INSERT INTO village_boundaries (area_code, name, polygon_json, centroid_lat, centroid_lng, blocks_config)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(area_code) DO UPDATE SET
    name = excluded.name,
    polygon_json = excluded.polygon_json,
    centroid_lat = excluded.centroid_lat,
    centroid_lng = excluded.centroid_lng,
    blocks_config = excluded.blocks_config,
    updated_at = CURRENT_TIMESTAMP
`;
const SQL_LIST_BOUNDARIES = `SELECT boundary_id, area_code, name, centroid_lat, centroid_lng, blocks_config, is_active, created_at FROM village_boundaries ORDER BY name ASC`;
const SQL_LIST_BOUNDARIES_PAGED = `SELECT boundary_id, area_code, name, centroid_lat, centroid_lng, blocks_config, is_active, created_at FROM village_boundaries ORDER BY name ASC LIMIT ? OFFSET ?`;
const SQL_COUNT_BOUNDARIES = `SELECT COUNT(*) AS c FROM village_boundaries`;
const SQL_DELETE_BOUNDARY = `UPDATE village_boundaries SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE area_code = ?`;

/**
 * Calculate centroid of a polygon (simple average of vertices).
 * @param {number[][]} points — array of [lat, lng]
 * @returns {{lat: number, lng: number}}
 */
function calculateCentroid(points) {
  if (!points || points.length === 0) return { lat: 0, lng: 0 };
  // Remove duplicate last point if same as first
  const pts = points.slice();
  if (pts.length > 1) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) {
      pts.pop();
    }
  }
  let latSum = 0, lngSum = 0;
  for (const p of pts) {
    latSum += p[0];
    lngSum += p[1];
  }
  return {
    lat: latSum / pts.length,
    lng: lngSum / pts.length,
  };
}

/**
 * Point-in-polygon check (ray casting algorithm).
 * @param {number[]} point — [lat, lng]
 * @param {number[][]} polygon — array of [lat, lng]
 * @returns {boolean}
 */
function isPointInPolygon(point, polygon) {
  if (!polygon || polygon.length < 3) return false;
  const [lat, lng] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > lng) !== (yj > lng)) &&
      (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Determine quadrant of a point relative to centroid.
 * Returns 'NE' | 'SE' | 'SW' | 'NW'
 *
 * @param {number} lat
 * @param {number} lng
 * @param {number} centerLat
 * @param {number} centerLng
 * @returns {string}
 */
function getQuadrant(lat, lng, centerLat, centerLng) {
  const isNorth = lat >= centerLat;
  const isEast = lng >= centerLng;
  if (isNorth && isEast) return 'NE';
  if (!isNorth && isEast) return 'SE';
  if (!isNorth && !isEast) return 'SW';
  return 'NW';
}

/**
 * Calculate Qibla bearing from a given location to Kaaba (Makkah).
 * @param {number} lat
 * @param {number} lng
 * @returns {number} bearing in degrees (0-360)
 */
function calculateQiblaBearing(lat, lng) {
  const kaabaLat = 21.4225 * Math.PI / 180;
  const kaabaLng = 39.8262 * Math.PI / 180;
  const pointLat = lat * Math.PI / 180;
  const pointLng = lng * Math.PI / 180;

  const dLng = kaabaLng - pointLng;
  const y = Math.sin(dLng) * Math.cos(kaabaLat);
  const x = Math.cos(pointLat) * Math.sin(kaabaLat) - Math.sin(pointLat) * Math.cos(kaabaLat) * Math.cos(dLng);
  let bearing = Math.atan2(y, x) * 180 / Math.PI;
  return (bearing + 360) % 360;
}

/**
 * Calculate bearing from point A to point B.
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number} bearing in degrees (0-360)
 */
function calculateBearing(lat1, lng1, lat2, lng2) {
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const lambda1 = lng1 * Math.PI / 180;
  const lambda2 = lng2 * Math.PI / 180;
  const dLng = lambda2 - lambda1;
  const y = Math.sin(dLng) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
  let bearing = Math.atan2(y, x) * 180 / Math.PI;
  return (bearing + 360) % 360;
}

/**
 * Determine Qibla-based zone (Q/R/B/L) for a point relative to centroid.
 * Q = Qibla (Front), R = Right, B = Back, L = Left
 * 
 * @param {number} lat
 * @param {number} lng
 * @param {number} centerLat
 * @param {number} centerLng
 * @returns {string} 'Q' | 'R' | 'B' | 'L'
 */
function getQiblaZone(lat, lng, centerLat, centerLng) {
  const qiblaBearing = calculateQiblaBearing(centerLat, centerLng);
  const pointBearing = calculateBearing(centerLat, centerLng, lat, lng);
  
  // Difference between point bearing and Qibla bearing
  let diff = ((pointBearing - qiblaBearing) + 360) % 360;
  
  // 4 quadrants of 90 degrees each
  if (diff >= 315 || diff < 45) return 'Q';  // Front (Qibla)
  if (diff >= 45 && diff < 135) return 'R';   // Right
  if (diff >= 135 && diff < 225) return 'B';  // Back
  return 'L';                                   // Left
}

/**
 * Map quadrant to block letter using village's blocks_config.
 * Default config: {"A":"NE","B":"SE","C":"SW","D":"NW"}
 *
 * @param {string} quadrant — 'NE' | 'SE' | 'SW' | 'NW'
 * @param {object} blocksConfig — {A: "NE", B: "SE", ...}
 * @returns {string} block letter ('A' | 'B' | 'C' | 'D' | '?')
 */
function quadrantToBlock(quadrant, blocksConfig) {
  for (const [block, q] of Object.entries(blocksConfig)) {
    if (q === quadrant) return block;
  }
  return '?';
}

/**
 * Detect block for a given lat/lng.
 * Returns:
 *   {
 *     found: boolean,
 *     village_area_code: string | null,
 *     village_name: string | null,
 *     inside_boundary: boolean,  // is pin inside polygon?
 *     near_boundary: boolean,    // is pin within tolerance of polygon?
 *     quadrant: 'NE'|'SE'|'SW'|'NW' | null,
 *     block: 'A'|'B'|'C'|'D' | null,
 *     centroid: {lat, lng} | null
 *   }
 *
 * @param {number} lat
 * @param {number} lng
 */
function detectBlock(lat, lng) {
  // Find nearest village boundary (by centroid distance, bbox prefiltered)
  const boundary = prepare(SQL_GET_BOUNDARY_BY_LATLNG).get(
    lat - BBOX_BOUNDARY, lat + BBOX_BOUNDARY, lng - BBOX_BOUNDARY, lng + BBOX_BOUNDARY,
    lat, lat, lng, lng
  );
  if (!boundary) {
    return {
      found: false,
      village_area_code: null,
      village_name: null,
      inside_boundary: false,
      near_boundary: false,
      quadrant: null,
      block: null,
      centroid: null,
    };
  }

  let polygon;
  try {
    const geojson = JSON.parse(boundary.polygon_json);
    polygon = geojson.coordinates[0]; // first ring
  } catch {
    polygon = [];
  }

  const inside = isPointInPolygon([lat, lng], polygon);
  const centroid = { lat: boundary.centroid_lat, lng: boundary.centroid_lng };
  
  // Proximity Tolerance: Check if point is within 50 meters of the polygon edge
  let nearBoundary = false;
  if (!inside && polygon.length > 0) {
    let minDist = Infinity;
    for (const p of polygon) {
      const dist = geoService.haversineMeters(lat, lng, p[0], p[1]);
      if (dist < minDist) minDist = dist;
    }
    if (minDist <= 50) {
      nearBoundary = true;
    }
  }

  // v0.6.0: Use Qibla-based zones (Q/R/B/L) instead of NE/SE/SW/NW
  const zone = getQiblaZone(lat, lng, boundary.centroid_lat, boundary.centroid_lng);

  // Map zone to block letter (Q=A, R=B, B=C, L=D for backward compat)
  // But we'll return the Q/R/B/L directly for the new system
  const blockMap = { 'Q': 'A', 'R': 'B', 'B': 'C', 'L': 'D' };
  const block = blockMap[zone] || '?';

  return {
    found: true,
    village_area_code: boundary.area_code,
    village_name: boundary.name,
    inside_boundary: inside,
    near_boundary: nearBoundary,
    quadrant: zone, // Now returns Q/R/B/L instead of NE/SE/SW/NW
    block,
    zone, // Also return as 'zone' for clarity
    centroid,
  };
}

/**
 * Save/update a village boundary.
 * @param {object} params
 * @param {string} params.area_code — village area_code
 * @param {string} params.name — village name
 * @param {object} params.polygon — GeoJSON Polygon object
 * @param {object} [params.blocksConfig] — optional custom blocks config
 */
function saveBoundary({ area_code, name, polygon, blocksConfig }) {
  const points = polygon.coordinates[0];
  const centroid = calculateCentroid(points);
  const polygonJson = JSON.stringify(polygon);
  const config = JSON.stringify(blocksConfig || { A: 'NE', B: 'SE', C: 'SW', D: 'NW' });

  prepare(SQL_INSERT_BOUNDARY).run(
    area_code, name, polygonJson,
    centroid.lat, centroid.lng, config
  );

  return {
    area_code, name,
    centroid,
    blocks_config: blocksConfig || { A: 'NE', B: 'SE', C: 'SW', D: 'NW' },
  };
}

/**
 * Get a village boundary by area_code.
 */
function getBoundary(area_code) {
  return prepare(SQL_GET_BOUNDARY_BY_AREA).get(area_code);
}

/**
 * List all village boundaries.
 * v0.8.0: optional limit/offset (Pakistan seed can add thousands of rows).
 */
function listBoundaries(limit = null, offset = 0) {
  if (limit != null) {
    return prepare(SQL_LIST_BOUNDARIES_PAGED).all(limit, offset);
  }
  return prepare(SQL_LIST_BOUNDARIES).all();
}

/**
 * Count all village boundaries (v0.8.0, for pagination totals).
 */
function countBoundaries() {
  return prepare(SQL_COUNT_BOUNDARIES).get().c;
}

/**
 * Deactivate a village boundary (soft delete).
 */
function deactivateBoundary(area_code) {
  return prepare(SQL_DELETE_BOUNDARY).run(area_code);
}

/**
 * Generate 4 quadrant rectangles for visualization on map.
 * Each rectangle is [[southWestLat, southWestLng], [northEastLat, northEastLng]]
 *
 * @param {number} centerLat
 * @param {number} centerLng
 * @param {number} sizeLat — half-size in lat degrees
 * @param {number} sizeLng — half-size in lng degrees
 * @param {object} blocksConfig
 */
function generateQuadrantRectangles(centerLat, centerLng, sizeLat, sizeLng, blocksConfig = { A: 'NE', B: 'SE', C: 'SW', D: 'NW' }) {
  const quads = {
    NE: { south: centerLat, west: centerLng, north: centerLat + sizeLat, east: centerLng + sizeLng },
    SE: { south: centerLat - sizeLat, west: centerLng, north: centerLat, east: centerLng + sizeLng },
    SW: { south: centerLat - sizeLat, west: centerLng - sizeLng, north: centerLat, east: centerLng },
    NW: { south: centerLat, west: centerLng - sizeLng, north: centerLat + sizeLat, east: centerLng },
  };

  const result = {};
  for (const [block, q] of Object.entries(blocksConfig)) {
    const r = quads[q];
    result[block] = {
      name: block,
      bounds: [[r.south, r.west], [r.north, r.east]],
      quadrant: q,
    };
  }
  return result;
}

// ============================================================
// v0.4.3: Smart Boundary Generation
// ============================================================

/**
 * Convex Hull algorithm (Andrew's monotone chain).
 * Given a set of 2D points, returns the smallest convex polygon
 * that contains all the points.
 *
 * @param {number[][]} points — array of [lat, lng]
 * @returns {number[][]} convex hull points (closed ring)
 */
function convexHull(points) {
  if (points.length < 3) return points;

  // Sort points by lat, then by lng
  const sorted = points.slice().sort((a, b) => {
    if (a[0] !== b[0]) return a[0] - b[0];
    return a[1] - b[1];
  });

  // Cross product of vectors OA and OB
  // Returns positive if O->A->B is counter-clockwise
  const cross = (O, A, B) => {
    return (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);
  };

  // Build lower hull
  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  // Build upper hull
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  // Combine (remove last point of each because it's the first of the other)
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));

  // Close the ring
  if (hull.length > 0) {
    hull.push(hull[0]);
  }

  return hull;
}

/**
 * Generate a circular polygon (approximation using N vertices).
 * @param {number} centerLat
 * @param {number} centerLng
 * @param {number} radiusMeters
 * @param {number} segments — number of vertices (default 32)
 * @returns {number[][]} closed ring of [lat, lng]
 */
function generateCirclePolygon(centerLat, centerLng, radiusMeters, segments = 32) {
  const points = [];
  const R = 6378137; // Earth radius in meters

  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * 2 * Math.PI;
    const dLat = (radiusMeters * Math.cos(angle)) / R * (180 / Math.PI);
    const dLng = (radiusMeters * Math.sin(angle)) / (R * Math.cos(centerLat * Math.PI / 180)) * (180 / Math.PI);
    points.push([
      parseFloat((centerLat + dLat).toFixed(6)),
      parseFloat((centerLng + dLng).toFixed(6)),
    ]);
  }

  return points;
}

/**
 * Generate a rectangular polygon.
 * @param {number} centerLat
 * @param {number} centerLng
 * @param {number} widthMeters
 * @param {number} heightMeters
 * @returns {number[][]} closed ring of [lat, lng]
 */
function generateRectanglePolygon(centerLat, centerLng, widthMeters, heightMeters) {
  const R = 6378137;
  const halfW = widthMeters / 2;
  const halfH = heightMeters / 2;

  const dLat = halfH / R * (180 / Math.PI);
  const dLng = halfW / (R * Math.cos(centerLat * Math.PI / 180)) * (180 / Math.PI);

  return [
    [parseFloat((centerLat - dLat).toFixed(6)), parseFloat((centerLng - dLng).toFixed(6))], // SW
    [parseFloat((centerLat + dLat).toFixed(6)), parseFloat((centerLng - dLng).toFixed(6))], // NW
    [parseFloat((centerLat + dLat).toFixed(6)), parseFloat((centerLng + dLng).toFixed(6))], // NE
    [parseFloat((centerLat - dLat).toFixed(6)), parseFloat((centerLng + dLng).toFixed(6))], // SE
    [parseFloat((centerLat - dLat).toFixed(6)), parseFloat((centerLng - dLng).toFixed(6))], // close
  ];
}

/**
 * Fetch buildings from OpenStreetMap Overpass API.
 * Returns array of [lat, lng] building centroids.
 *
 * @param {number} centerLat
 * @param {number} centerLng
 * @param {number} radiusMeters — search radius (default 500m)
 * @returns {Promise<number[][]>} building centroids
 */
async function fetchBuildingsFromOSM(centerLat, centerLng, radiusMeters = 500) {
  const https = require('https');

  const query = `
    [out:json][timeout:25];
    (
      way["building"](around:${radiusMeters},${centerLat},${centerLng});
      relation["building"](around:${radiusMeters},${centerLat},${centerLng});
    );
    out center;
  `;

  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const buildings = [];

          if (json.elements) {
            for (const el of json.elements) {
              if (el.type === 'way' && el.center) {
                buildings.push([el.center.lat, el.center.lon]);
              } else if (el.type === 'relation' && el.center) {
                buildings.push([el.center.lat, el.center.lon]);
              } else if (el.type === 'way' && el.bounds) {
                // Fallback: use bounds center
                const lat = (el.bounds.minlat + el.bounds.maxlat) / 2;
                const lng = (el.bounds.minlon + el.bounds.maxlon) / 2;
                buildings.push([lat, lng]);
              }
            }
          }

          resolve(buildings);
        } catch (err) {
          reject(new Error('Failed to parse OSM response: ' + err.message));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error('OSM API error: ' + err.message));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('OSM API timeout'));
    });
  });
}

/**
 * Generate a smart boundary by:
 * 1. Querying OSM for buildings near the center point
 * 2. Computing convex hull of building centroids
 * 3. If no buildings found, falling back to a circle polygon
 *
 * @param {number} centerLat
 * @param {number} centerLng
 * @param {object} options — { radiusMeters, fallbackShape }
 * @returns {Promise<object>} { polygon, method, buildingCount, centroid }
 */
async function generateSmartBoundary(centerLat, centerLng, options = {}) {
  const radiusMeters = options.radiusMeters || 500;
  const fallbackShape = options.fallbackShape || 'circle'; // 'circle' | 'rectangle'

  try {
    // Step 1: Fetch buildings from OSM
    const buildings = await fetchBuildingsFromOSM(centerLat, centerLng, radiusMeters);

    if (buildings.length >= 3) {
      // Step 2: Compute convex hull
      const hull = convexHull(buildings);
      const centroid = calculateCentroid(hull);

      return {
        polygon: {
          type: 'Polygon',
          coordinates: [hull],
        },
        method: 'osm_convex_hull',
        buildingCount: buildings.length,
        centroid,
      };
    }

    // Fallback: not enough buildings
    let fallbackPoints;
    if (fallbackShape === 'rectangle') {
      fallbackPoints = generateRectanglePolygon(centerLat, centerLng, radiusMeters * 2, radiusMeters * 2);
    } else {
      fallbackPoints = generateCirclePolygon(centerLat, centerLng, radiusMeters);
    }

    return {
      polygon: {
        type: 'Polygon',
        coordinates: [fallbackPoints],
      },
      method: `fallback_${fallbackShape}`,
      buildingCount: buildings.length,
      centroid: { lat: centerLat, lng: centerLng },
      note: `Only ${buildings.length} buildings found in OSM. Used ${fallbackShape} fallback. You can manually draw for better accuracy.`,
    };
  } catch (err) {
    // Fallback on error
    const fallbackPoints = generateCirclePolygon(centerLat, centerLng, radiusMeters);
    return {
      polygon: {
        type: 'Polygon',
        coordinates: [fallbackPoints],
      },
      method: 'fallback_circle',
      buildingCount: 0,
      centroid: { lat: centerLat, lng: centerLng },
      note: `OSM API error: ${err.message}. Used circle fallback.`,
    };
  }
}

module.exports = {
  calculateCentroid,
  isPointInPolygon,
  getQuadrant,
  getQiblaZone,
  calculateQiblaBearing,
  calculateBearing,
  quadrantToBlock,
  detectBlock,
  saveBoundary,
  getBoundary,
  listBoundaries,
  countBoundaries,
  deactivateBoundary,
  generateQuadrantRectangles,
  // v0.4.3: Smart boundary
  convexHull,
  generateCirclePolygon,
  generateRectanglePolygon,
  fetchBuildingsFromOSM,
  generateSmartBoundary,
};
