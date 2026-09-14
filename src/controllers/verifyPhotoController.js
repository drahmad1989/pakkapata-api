/**
 * GeoPata — Photo Verification Controller (v0.7.0)
 *
 * Field verification flow:
 *   1. Verifier physically visits the address
 *   2. Takes a photo of the entrance (dashboard uploads via this endpoint)
 *   3. Optional: verifier's GPS captured to confirm on-site presence
 *   4. Address tier upgraded (e.g. Tier 1 Map-dropped → Tier 2 GIS verified)
 *   5. Audit log records who verified, when, with which photo
 *
 * Endpoint:
 *   POST /api/verify/:code/photo   (JWT verifier+)
 *     FormData:
 *       photo     — image file (jpeg/png/webp/heic, max 10MB) [required]
 *       to_tier   — target tier 1-4, must be > current [required]
 *       note      — free-text note [optional]
 *       gps_lat   — verifier's GPS latitude [optional]
 *       gps_long  — verifier's GPS longitude [optional]
 *
 * Photo storage: <backend>/public/uploads/verify/<short_code>_<timestamp>.<ext>
 * Static serving: GET /uploads/verify/<filename> (no auth — filenames unguessable)
 *
 * PRIVACY: photos are stored server-side; dashboard fetches them via
 * /uploads/verify/... URLs. Filenames are not exposed in public lookup.
 */

const path = require('path');
const fs = require('fs');
const multer = require('multer');

const db = require('../config/database');
const { prepare } = db;
const { HttpError } = require('../middleware/errorHandler');
const audit = require('../services/auditService');

const UPLOAD_ROOT = path.resolve(process.cwd(), 'public/uploads/verify');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const ALLOWED_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

const SQL_GET_ENTRANCE = `
  SELECT e.entrance_id, e.uprn, e.short_code, e.lifecycle_status,
         p.verification_tier, p.display_name, p.share_code
  FROM entrances e
  JOIN properties p ON p.uprn = e.uprn
  WHERE e.short_code = ?
`;

const SQL_UPGRADE_TIER = `UPDATE properties SET verification_tier = ?, updated_at = CURRENT_TIMESTAMP WHERE uprn = ?`;
const SQL_TOUCH_ENTRANCE = `UPDATE entrances SET updated_at = CURRENT_TIMESTAMP WHERE entrance_id = ?`;

// ─────────────────────────────────────────────
// Multer configuration
// ─────────────────────────────────────────────

// Ensure upload dir exists (created lazily on first upload)
function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_ROOT)) {
    fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
  }
}

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    try {
      ensureUploadDir();
      cb(null, UPLOAD_ROOT);
    } catch (err) {
      cb(new Error('Failed to create upload directory'), null);
    }
  },
  filename(_req, file, cb) {
    // short_code is validated server-side before upload handler runs? No —
    // multer runs BEFORE controller, so we sanitize here defensively.
    const rawCode = String(_req.params?.code || 'unknown').toUpperCase();
    const safeCode = rawCode.replace(/[^A-Z0-9-]/g, '').slice(0, 40) || 'unknown';
    const ext = ALLOWED_MIME[file.mimetype] || 'bin';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `${safeCode}_${ts}.${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter(_req, file, cb) {
    if (ALLOWED_MIME[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new HttpError(400, `Unsupported image type: ${file.mimetype}. Allowed: JPEG, PNG, WebP, HEIC.`, 'INVALID_FILE_TYPE'));
    }
  },
});

/**
 * Multer error normalizer — converts multer errors into HttpError responses.
 */
function multerErrorHandler(err, _req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new HttpError(400, 'Photo too large. Maximum size is 10MB.', 'FILE_TOO_LARGE'));
    }
    return next(new HttpError(400, `Upload failed: ${err.message}`, 'UPLOAD_ERROR'));
  }
  next(err);
}

/**
 * Validate multipart text fields (they arrive as strings).
 */
function parseVerifyFields(body) {
  const toTier = parseInt(body.to_tier, 10);
  if (Number.isNaN(toTier) || toTier < 1 || toTier > 4) {
    throw new HttpError(400, 'to_tier must be an integer between 1 and 4', 'VALIDATION_ERROR');
  }

  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;

  let gpsLat = null;
  let gpsLong = null;
  if (body.gps_lat != null && body.gps_lat !== '') {
    gpsLat = parseFloat(body.gps_lat);
    if (Number.isNaN(gpsLat) || gpsLat < -90 || gpsLat > 90) {
      throw new HttpError(400, 'gps_lat must be a valid latitude', 'VALIDATION_ERROR');
    }
  }
  if (body.gps_long != null && body.gps_long !== '') {
    gpsLong = parseFloat(body.gps_long);
    if (Number.isNaN(gpsLong) || gpsLong < -180 || gpsLong > 180) {
      throw new HttpError(400, 'gps_long must be a valid longitude', 'VALIDATION_ERROR');
    }
  }

  return { toTier, note, gpsLat, gpsLong };
}

/**
 * POST /api/verify/:code/photo — upload photo + upgrade tier
 */
function verifyWithPhoto(req, res) {
  const { code } = req.params;
  const normalized = String(code).trim().toUpperCase();

  if (!req.file) {
    throw new HttpError(400, 'Photo is required. Attach it as the "photo" form field.', 'PHOTO_REQUIRED');
  }
  const { toTier, note, gpsLat, gpsLong } = parseVerifyFields(req.body);

  const existing = prepare(SQL_GET_ENTRANCE).get(normalized);
  if (!existing) {
    // Clean up the orphan file
    try { fs.unlinkSync(req.file.path); } catch {}
    throw new HttpError(404, `Address with short code ${normalized} not found`, 'ADDRESS_NOT_FOUND');
  }

  if (toTier <= existing.verification_tier) {
    try { fs.unlinkSync(req.file.path); } catch {}
    throw new HttpError(400,
      `Cannot verify to tier ${toTier} (current: ${existing.verification_tier}). Tier can only increase.`,
      'TIER_NOT_INCREASING');
  }

  const photoUrl = `/uploads/verify/${req.file.filename}`;

  prepare(SQL_UPGRADE_TIER).run(toTier, existing.uprn);
  prepare(SQL_TOUCH_ENTRANCE).run(existing.entrance_id);

  audit.log({
    adminId: req.auth.adminId,
    action: 'VERIFY_WITH_PHOTO',
    resourceType: 'property',
    resourceId: existing.uprn,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: {
      short_code: normalized,
      share_code: existing.share_code || null,
      before_tier: existing.verification_tier,
      after_tier: toTier,
      note,
      photo_url: photoUrl,
      photo_size: req.file.size,
      photo_mimetype: req.file.mimetype,
      verifier_gps: gpsLat != null && gpsLong != null ? { lat: gpsLat, long: gpsLong } : null,
    },
  });

  const updated = prepare(SQL_GET_ENTRANCE).get(normalized);

  return res.status(200).json({
    message: `Address verified — tier upgraded from ${existing.verification_tier} to ${toTier}`,
    data: {
      short_code: updated.short_code,
      share_code: updated.share_code || null,
      verification_tier: updated.verification_tier,
      verification_tier_before: existing.verification_tier,
      photo_url: photoUrl,
      verified_by: req.auth.username,
      verified_at: new Date().toISOString(),
      note,
    },
  });
}

module.exports = { upload, multerErrorHandler, verifyWithPhoto };
