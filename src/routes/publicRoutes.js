/**
 * GeoPata — Public Routes (v0.7.0)
 * Mounted at: /api/public
 *
 * Unauthenticated endpoints. These are SAFE to expose publicly:
 *   GET /address/:code  → privacy-safe lookup (no GPS, no occupants, no IDs)
 *
 * Rate limited separately (stricter than the global limiter) because
 * these endpoints accept no auth — see server.js for the limiter config.
 */

const express = require('express');
const router = express.Router();

const validate = require('../middleware/validate');
const { publicAddressCodeSchema, villageSearchSchema, createSuggestionSchema } = require('../schemas');
const { publicLookup } = require('../controllers/publicController');
const {
  upload, multerErrorHandler, villageSearch, createSuggestion,
} = require('../controllers/suggestionController');

// GET /api/public/address/:code — privacy-safe public lookup
router.get('/address/:code', validate(publicAddressCodeSchema), publicLookup);

// ─────────────────────────────────────────────
// Mashwara Box (v0.10.7) — public suggestion intake (no login)
// Rate limit: /api/public budget (30/15min) + dedicated POST limiter (server.js)
// ─────────────────────────────────────────────

// GET /api/public/suggest/villages?q= — village autocomplete (privacy-safe)
router.get('/suggest/villages', validate(villageSearchSchema), villageSearch);

// POST /api/public/suggest — multipart (photo optional), validated after multer
router.post('/suggest',
  (req, res, next) => {
    upload.single('photo')(req, res, (err) => {
      if (err) return multerErrorHandler(err, req, res, next);
      next();
    });
  },
  validate(createSuggestionSchema),
  createSuggestion
);

module.exports = router;
