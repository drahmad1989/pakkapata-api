/**
 * GeoPata — Village Boundary Controller (v0.4.2)
 *
 * Endpoints:
 *   GET    /api/village-boundaries                — list all boundaries
 *   GET    /api/village-boundaries/:areaCode      — get specific boundary
 *   POST   /api/village-boundaries                — create/update boundary (admin only)
 *   DELETE /api/village-boundaries/:areaCode      — deactivate boundary (admin only)
 *   GET    /api/village-boundaries/detect?lat=&lng= — auto-detect block for a point
 *   GET    /api/village-boundaries/:areaCode/blocks — get 4 quadrant rectangles for visualization
 */

const { HttpError } = require('../middleware/errorHandler');
const audit = require('../services/auditService');
const boundaryService = require('../services/villageBoundaryService');

/**
 * GET /api/village-boundaries
 * v0.8.0: optional ?limit=&offset= pagination (default limit 1000, max 5000)
 * — Pakistan seed can create thousands of boundary rows.
 */
function listBoundaries(req, res) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 5000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const total = boundaryService.countBoundaries();
  const rows = boundaryService.listBoundaries(limit, offset);
  return res.json({ count: rows.length, total, data: rows });
}

/**
 * GET /api/village-boundaries/:areaCode
 */
function getBoundary(req, res) {
  const { areaCode } = req.params;
  const boundary = boundaryService.getBoundary(areaCode);
  if (!boundary) {
    throw new HttpError(404, `Boundary for ${areaCode} not found`, 'BOUNDARY_NOT_FOUND');
  }
  // Parse polygon JSON for response
  try {
    boundary.polygon = JSON.parse(boundary.polygon_json);
  } catch {
    boundary.polygon = null;
  }
  try {
    boundary.blocks_config = JSON.parse(boundary.blocks_config);
  } catch {}
  return res.json({ data: boundary });
}

/**
 * POST /api/village-boundaries
 * Body: {
 *   area_code: "PK-PB-LHR-KAS-PTK-BBG",
 *   name: "Bonga Balochan",
 *   polygon: { type: "Polygon", coordinates: [[[lat,lng], ...]] },
 *   blocksConfig: { A: "NE", B: "SE", C: "SW", D: "NW" }  // optional
 * }
 */
function createBoundary(req, res) {
  const { area_code, name, polygon, blocksConfig } = req.body;

  if (!area_code || !name || !polygon) {
    throw new HttpError(400, 'area_code, name, and polygon are required', 'VALIDATION_ERROR');
  }
  if (!polygon.type || polygon.type !== 'Polygon' || !polygon.coordinates || !polygon.coordinates[0]) {
    throw new HttpError(400, 'polygon must be a GeoJSON Polygon with coordinates', 'VALIDATION_ERROR');
  }
  if (polygon.coordinates[0].length < 4) {
    throw new HttpError(400, 'Polygon must have at least 4 points (closed ring)', 'VALIDATION_ERROR');
  }

  const result = boundaryService.saveBoundary({ area_code, name, polygon, blocksConfig });

  audit.log({
    adminId: req.auth.adminId,
    action: 'SAVE_VILLAGE_BOUNDARY',
    resourceType: 'village_boundary',
    resourceId: area_code,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { name, points: polygon.coordinates[0].length },
  });

  return res.status(201).json({
    message: 'Village boundary saved',
    data: result,
  });
}

/**
 * DELETE /api/village-boundaries/:areaCode
 */
function deleteBoundary(req, res) {
  const { areaCode } = req.params;
  const existing = boundaryService.getBoundary(areaCode);
  if (!existing) {
    throw new HttpError(404, `Boundary for ${areaCode} not found`, 'BOUNDARY_NOT_FOUND');
  }
  boundaryService.deactivateBoundary(areaCode);

  audit.log({
    adminId: req.auth.adminId,
    action: 'DEACTIVATE_VILLAGE_BOUNDARY',
    resourceType: 'village_boundary',
    resourceId: areaCode,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
  });

  return res.json({ message: `Boundary for ${areaCode} deactivated` });
}

/**
 * GET /api/village-boundaries/detect?lat=&lng=
 * Auto-detect which village + block a point belongs to.
 */
function detectBlock(req, res) {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);

  if (isNaN(lat) || isNaN(lng)) {
    throw new HttpError(400, 'lat and lng must be valid numbers', 'VALIDATION_ERROR');
  }

  const result = boundaryService.detectBlock(lat, lng);
  return res.json({
    query: { lat, lng },
    ...result,
  });
}

/**
 * GET /api/village-boundaries/:areaCode/blocks
 * Returns 4 quadrant rectangles for map visualization.
 */
function getBlocks(req, res) {
  const { areaCode } = req.params;
  const boundary = boundaryService.getBoundary(areaCode);
  if (!boundary) {
    throw new HttpError(404, `Boundary for ${areaCode} not found`, 'BOUNDARY_NOT_FOUND');
  }

  let blocksConfig = { A: 'NE', B: 'SE', C: 'SW', D: 'NW' };
  try {
    if (boundary.blocks_config) blocksConfig = JSON.parse(boundary.blocks_config);
  } catch {}

  // Default size ~0.005 degrees (~500m)
  const sizeLat = 0.005;
  const sizeLng = 0.005;

  const blocks = boundaryService.generateQuadrantRectangles(
    boundary.centroid_lat, boundary.centroid_lng, sizeLat, sizeLng, blocksConfig
  );

  return res.json({
    area_code: areaCode,
    village_name: boundary.name,
    centroid: { lat: boundary.centroid_lat, lng: boundary.centroid_lng },
    blocks,
  });
}

/**
 * POST /api/village-boundaries/generate-smart
 * Body: { lat, lng, radiusMeters?, fallbackShape? }
 *
 * Queries OSM Overpass API for buildings near the point,
 * computes convex hull, and returns a suggested polygon.
 * If no buildings found, falls back to circle/rectangle.
 */
async function generateSmart(req, res) {
  const { lat, lng, radiusMeters, fallbackShape } = req.body;

  if (typeof lat !== 'number' || typeof lng !== 'number') {
    throw new HttpError(400, 'lat and lng must be numbers', 'VALIDATION_ERROR');
  }

  const options = {
    radiusMeters: radiusMeters || 500,
    fallbackShape: fallbackShape || 'circle',
  };

  // eslint-disable-next-line no-console
  console.log(`[smart-boundary] Generating for (${lat}, ${lng}) radius=${options.radiusMeters}m`);

  const result = await boundaryService.generateSmartBoundary(lat, lng, options);

  return res.json({
    message: result.method === 'osm_convex_hull'
      ? `Smart boundary generated from ${result.buildingCount} buildings (OSM)`
      : `Fallback ${result.method} used. ${result.note || ''}`,
    data: result,
  });
}

/**
 * POST /api/village-boundaries/auto-fetch
 * Body: { query: "Bonga Balochan" }
 *
 * 1. Searches Nominatim for the place name.
 * 2. Fetches the official OSM administrative boundary polygon.
 * 3. Returns the polygon + centroid + name.
 */
async function autoFetch(req, res) {
  const { query } = req.body;

  if (!query || typeof query !== 'string') {
    throw new HttpError(400, 'query is required', 'VALIDATION_ERROR');
  }

  const https = require('https');

  // Step 1: Nominatim Search
  const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=pk`;

  const searchResult = await new Promise((resolve, reject) => {
    https.get(nominatimUrl, { headers: { 'User-Agent': 'PakkaPata/1.0' } }, (nRes) => {
      let data = '';
      nRes.on('data', (chunk) => { data += chunk; });
      nRes.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (err) {
          reject(new Error('Failed to parse Nominatim response'));
        }
      });
    }).on('error', reject);
  });

  if (!searchResult || searchResult.length === 0) {
    throw new HttpError(404, `Place "${query}" not found`, 'PLACE_NOT_FOUND');
  }

  const place = searchResult[0];
  const osmType = place.osm_type; // 'relation' or 'way' or 'node'
  const osmId = place.osm_id;

  // Step 2: Fetch boundary from Overpass API (if it's a relation)
  let polygon = null;
  if (osmType === 'relation' && osmId) {
    const overpassQuery = `[out:json][timeout:25];relation(${osmId});out geom;`;
    const overpassUrl = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`;

    // Respect Overpass rate limits — wait 5 seconds before issuing the request
    await new Promise((r) => setTimeout(r, 5000));

    try {
      const overpassResult = await new Promise((resolve, reject) => {
        https.get(overpassUrl, { timeout: 15000 }, (oRes) => {
          // 1. Check HTTP status code. If it's not 200, reject without parsing JSON.
          if (oRes.statusCode !== 200) {
            oRes.resume(); // drain the response so the underlying socket can be freed
            reject(new Error(`Overpass API returned HTTP status ${oRes.statusCode}`));
            return;
          }

          // 2. Check the Content-Type header. Overpass sometimes returns an HTML
          //    error page (429 Too Many Requests / 504 Gateway Timeout) instead of JSON.
          const contentType = oRes.headers['content-type'] || '';
          if (contentType.toLowerCase().includes('text/html')) {
            oRes.resume();
            reject(new Error(`Overpass API returned HTML error page (Content-Type: ${contentType})`));
            return;
          }

          let oData = '';
          oRes.on('data', (chunk) => { oData += chunk; });
          oRes.on('end', () => {
            // 3. Wrap JSON.parse in a try-catch that specifically handles the HTML scenario.
            try {
              resolve(JSON.parse(oData));
            } catch (e) {
              const trimmed = (oData || '').trim();
              if (trimmed.startsWith('<') || /<!DOCTYPE|<html/i.test(trimmed)) {
                reject(new Error(
                  'Overpass API returned HTML instead of JSON (possible rate limit or gateway error)'
                ));
              } else {
                reject(new Error(`Failed to parse OSM response: ${e.message}`));
              }
            }
          });
        }).on('error', reject).on('timeout', () => reject(new Error('Overpass timeout')));
      });

      if (overpassResult.elements && overpassResult.elements.length > 0) {
        const rel = overpassResult.elements[0];
        if (rel.members) {
          // Assemble polygon from members
          const points = [];
          for (const member of rel.members) {
            if (member.geometry) {
              for (const g of member.geometry) {
                points.push([g.lat, g.lon]);
              }
            }
          }
          if (points.length > 0) {
            // Close the ring
            if (points[0][0] !== points[points.length - 1][0] || points[0][1] !== points[points.length - 1][1]) {
              points.push(points[0]);
            }
            polygon = { type: 'Polygon', coordinates: [points] };
          }
        }
      }
    } catch (err) {
      // Log the Overpass failure for debuggability, then fall back to the
      // Nominatim bounding box below.
      // eslint-disable-next-line no-console
      console.warn(`[autoFetch] Overpass fetch failed: ${err.message}`);
    }
  }

  // Fallback: Use Nominatim bounding box to create a rectangle
  if (!polygon && place.boundingbox) {
    const bb = place.boundingbox; // [south, north, west, east]
    const points = [
      [parseFloat(bb[0]), parseFloat(bb[2])], // SW
      [parseFloat(bb[1]), parseFloat(bb[2])], // NW
      [parseFloat(bb[1]), parseFloat(bb[3])], // NE
      [parseFloat(bb[0]), parseFloat(bb[3])], // SE
      [parseFloat(bb[0]), parseFloat(bb[2])], // close
    ];
    polygon = { type: 'Polygon', coordinates: [points] };
  }

  if (!polygon) {
    throw new HttpError(500, 'Could not determine boundary for this place', 'BOUNDARY_FETCH_FAILED');
  }

  const centroid = boundaryService.calculateCentroid(polygon.coordinates[0]);

  return res.json({
    message: 'Boundary fetched successfully',
    data: {
      polygon,
      centroid,
      name: place.display_name.split(',')[0], // First part of name
      full_name: place.display_name,
      source: 'osm_relation',
    },
  });
}

module.exports = {
  listBoundaries,
  getBoundary,
  createBoundary,
  deleteBoundary,
  detectBlock,
  getBlocks,
  generateSmart,
  autoFetch,
};
