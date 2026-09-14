/**
 * GeoPata — ID Generator (v0.6.0)
 *
 * Generates server-side permanent identifiers:
 *
 *   UPRN        (Unique Property Reference Number)
 *     Format: <COUNTRY>-<REGION>-<ZERO_PADDED_NUMBER>
 *     Example: PK-PB-000001
 *
 *   short_code  (Human-Friendly Short Code)
 *     Format: LLL-NNNN (3-letter locality prefix + 4-digit number)
 *     Example: BGL-0001
 *
 *   share_code  (Public Address ID - v0.6.0)
 *     Format: LLLL-ZSS-NNN
 *     LLLL = Locality code (4 chars, no confusing chars)
 *     Z    = Zone (Q=Qibla, R=Right, B=Back, L=Left)
 *     SS   = Street number (2 digits)
 *     NNN  = Property number (3 digits)
 *     Example: BONG-Q07-025
 */

const db = require('../config/database');
const { prepare } = db;

/**
 * Zero-pad a number to a given width.
 * @param {number} n
 * @param {number} width
 * @returns {string}
 */
function padNumber(n, width) {
  return String(n).padStart(width, '0');
}

/**
 * Extract the trailing numeric portion of a code (e.g. "PK-PB-000123" → 123).
 * @param {string} code
 * @returns {number}
 */
function extractNumericSuffix(code) {
  const match = String(code).match(/(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Generate the next UPRN by scanning existing rows and incrementing the
 * highest numeric suffix. Uses a transaction to serialize concurrent writers.
 *
 * @returns {string} e.g. "PK-PB-000001"
 */
function generateUPRN() {
  const country = process.env.UPRN_COUNTRY_PREFIX || 'PK';
  const region = process.env.UPRN_REGION_PREFIX || 'PB';
  const pad = parseInt(process.env.UPRN_NUMBER_PAD || '6', 10);

  const tx = db.transaction(() => {
    const row = prepare('SELECT uprn FROM properties ORDER BY uprn DESC LIMIT 1').get();
    const nextNum = row ? extractNumericSuffix(row.uprn) + 1 : 1;
    return `${country}-${region}-${padNumber(nextNum, pad)}`;
  });

  return tx();
}

/**
 * Generate the next short_code (same pattern as UPRN).
 *
 * @returns {string} e.g. "BGL-0001"
 */
function generateShortCode() {
  const city = process.env.SHORT_CODE_CITY_PREFIX || 'BGL';
  const pad = parseInt(process.env.SHORT_CODE_PAD || '4', 10);

  const tx = db.transaction(() => {
    const row = prepare('SELECT short_code FROM entrances ORDER BY short_code DESC LIMIT 1').get();
    const nextNum = row ? extractNumericSuffix(row.short_code) + 1 : 1;
    return `${city}-${padNumber(nextNum, pad)}`;
  });

  return tx();
}

/**
 * Generate a locality code from a village name.
 * Rules:
 * - Remove spaces and punctuation
 * - Take first 4 characters
 * - Exclude confusing characters (I, L, O, S, Z)
 * - Uppercase
 * 
 * @param {string} villageName
 * @returns {string} 4-character locality code
 */
function generateLocalityCode(villageName) {
  if (!villageName) return 'XXXX';
  
  // Remove spaces, punctuation, convert to uppercase
  let cleaned = villageName.toUpperCase().replace(/[^A-Z]/g, '');
  
  // Replace confusing characters
  cleaned = cleaned
    .replace(/I/g, 'Y')
    .replace(/O/g, 'U')
    .replace(/S/g, 'C')
    .replace(/Z/g, 'K');
  
  // Take first 4 characters
  if (cleaned.length >= 4) {
    return cleaned.substring(0, 4);
  } else {
    // Pad with 'X' if less than 4 chars
    return cleaned.padEnd(4, 'X');
  }
}

/**
 * Generate a fixed-length public address ID (v0.6.0).
 * Format: LLLL-ZSS-NNN
 * 
 * @param {string} villageName - Village name (for locality code)
 * @param {string} zone - Zone letter (Q, R, B, L)
 * @param {string|number} streetNumber - Street number
 * @param {string|number} propertyNumber - Property number
 * @returns {string} e.g. "BONG-Q07-025"
 */
function generatePublicAddressId(villageName, zone, streetNumber, propertyNumber) {
  const locality = generateLocalityCode(villageName);
  const street = padNumber(parseInt(streetNumber, 10) || 1, 2);
  const property = padNumber(parseInt(propertyNumber, 10) || 1, 3);
  
  return `${locality}-${zone}${street}-${property}`;
}

module.exports = {
  generateUPRN,
  generateShortCode,
  generateLocalityCode,
  generatePublicAddressId,
  padNumber,
  extractNumericSuffix,
};
