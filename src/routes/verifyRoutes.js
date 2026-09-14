/**
 * GeoPata — Verification, Listing & Area Assignment Routes (v0.3.0 / v0.7.0)
 *
 *   POST /api/verify/:code              → upgrade verification tier (JWT verifier+)
 *   POST /api/verify/:code/photo        → upload entrance photo + verify (JWT verifier+) [v0.7.0]
 *   GET  /api/addresses                 → list + paginate addresses  (JWT any role)
 *   POST /api/addresses/:code/assign-area → assign area chain to address (JWT verifier+)
 */

const express = require('express');
const router = express.Router();

const validate = require('../middleware/validate');
const { authenticateJwt, requireRole } = require('../middleware/auth');
const { upgradeTierSchema, listAddressesSchema, assignAreaSchema } = require('../schemas');
const controller = require('../controllers/addressController');
const areaController = require('../controllers/areaController');
const { upload, multerErrorHandler, verifyWithPhoto } = require('../controllers/verifyPhotoController');
const bulkImportController = require('../controllers/bulkImportController');
const { bulkImportSchema } = require('../schemas');

// POST /api/verify/:code — upgrade tier (no photo)
router.post('/verify/:code',
  authenticateJwt, requireRole('admin', 'verifier'),
  validate(upgradeTierSchema), controller.upgradeTier);

// POST /api/verify/:code/photo — upload entrance photo + upgrade tier (v0.7.0)
// Multipart: photo (file), to_tier, note?, gps_lat?, gps_long?
router.post('/verify/:code/photo',
  authenticateJwt, requireRole('admin', 'verifier'),
  (req, res, next) => {
    upload.single('photo')(req, res, (err) => {
      if (err) return multerErrorHandler(err, req, res, next);
      next();
    });
  },
  verifyWithPhoto);

// POST /api/addresses/bulk-import — CSV-driven bulk import (v0.7.0)
router.post('/addresses/bulk-import',
  authenticateJwt, requireRole('admin', 'verifier'),
  validate(bulkImportSchema), bulkImportController.bulkImport);

// GET /api/addresses — list with pagination
router.get('/addresses',
  authenticateJwt,
  validate(listAddressesSchema), controller.listAddresses);

// POST /api/addresses/:code/assign-area — manually assign address to area chain
router.post('/addresses/:code/assign-area',
  authenticateJwt, requireRole('admin', 'verifier'),
  validate(assignAreaSchema), areaController.assignAreaToAddress);

module.exports = router;
