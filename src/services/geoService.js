/**
 * GeoPata — Geospatial helpers
 *
 * Two coordinate systems are stored alongside every address:
 *   1. H3 hexagon ID  → fast spatial indexing, neighbor queries, no boundary issues
 *   2. Plus Code      → human-shareable global address (Google + OSM compatible)
 *
 * Raw lat/long is also stored for exact distance calculations.
 */

const h3 = require('h3-js');
const { OpenLocationCode } = require('open-location-code');

const olc = new OpenLocationCode();

const H3_RESOLUTION = parseInt(process.env.H3_RESOLUTION || '14', 10);

/**
 * Convert (lat, lng) → H3 hexagon ID at the configured resolution.
 * @param {number} lat
 * @param {number} lng
 * @param {number} [resolution=H3_RESOLUTION]
 * @returns {string} H3 cell ID, e.g. '871be2b89ffffff'
 */
function getH3Index(lat, lng, resolution = H3_RESOLUTION) {
  return h3.latLngToCell(lat, lng, resolution);
}

/**
 * Get the centroid of an H3 cell.
 * @param {string} h3Index
 * @returns {{lat: number, lng: number}}
 */
function getCellCenter(h3Index) {
  const [lat, lng] = h3.cellToLatLng(h3Index);
  return { lat, lng };
}

/**
 * Get all cells within `k` rings of the given cell (k=0 returns just the cell).
 * @param {string} h3Index
 * @param {number} [k=1]
 * @returns {string[]}
 */
function getNeighbors(h3Index, k = 1) {
  return h3.gridDisk(h3Index, k);
}

/**
 * Encode (lat, lng) → Plus Code (Open Location Code).
 * Default length = 10 → 8J6V+2X7 form (with locality removed).
 * Use length 11 for the full code with locality suffix.
 * @param {number} lat
 * @param {number} lng
 * @returns {string} e.g. '8J6V+2X7'
 */
function getPlusCode(lat, lng) {
  return olc.encode(lat, lng);
}

/**
 * Great-circle distance between two lat/lng points (Haversine formula).
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number} Distance in meters
 */
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius (meters)
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Compute an axis-aligned bounding box around (lat, lng) with radius in meters.
 * Approximate (spherical Earth) — accurate enough for radii < 100 km.
 * Used for fast SQL pre-filtering before exact Haversine refinement.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {number} radiusMeters
 * @returns {{minLat: number, maxLat: number, minLng: number, maxLng: number}}
 */
function boundingBox(lat, lng, radiusMeters) {
  const R = 6371000; // Earth radius (meters)
  const toRad = (deg) => (deg * Math.PI) / 180;

  // Delta in degrees for latitude
  const deltaLat = (radiusMeters / R) * (180 / Math.PI);

  // Delta in degrees for longitude (scales with cos(lat))
  const cosLat = Math.max(Math.cos(toRad(lat)), 1e-6); // avoid div-by-zero near poles
  const deltaLng = (radiusMeters / (R * cosLat)) * (180 / Math.PI);

  return {
    minLat: lat - deltaLat,
    maxLat: lat + deltaLat,
    minLng: lng - deltaLng,
    maxLng: lng + deltaLng,
  };
}

module.exports = {
  H3_RESOLUTION,
  getH3Index,
  getCellCenter,
  getNeighbors,
  getPlusCode,
  haversineMeters,
  boundingBox,
};
