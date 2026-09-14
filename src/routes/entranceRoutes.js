/**
 * GeoPata — Entrance Management Routes (v0.2.1)
 * Mounted at: /api/entrance
 *
 *   PATCH  /:id/lifecycle           — change lifecycle status (JWT verifier+)
 *   POST   /:id/nfc                  — bind NFC tag          (JWT verifier+)
 *   DELETE /:id/nfc                  — unbind NFC tag        (JWT verifier+)
 *   GET    /by-nfc/:nfcTagId         — lookup by NFC tag     (JWT or API key:read)
 *   GET    /:id/occupants            — list residents        (JWT any role)
 */

const express = require('express');
const router = express.Router();

const validate = require('../middleware/validate');
const { authenticateAny, authenticateJwt, requireRole } = require('../middleware/auth');
const {
  entranceIdSchema, changeLifecycleSchema, bindNfcSchema, nfcTagIdSchema,
} = require('../schemas');
const addressController = require('../controllers/addressController');
const occupantController = require('../controllers/occupantController');

// PATCH /api/entrance/:id/lifecycle
router.patch('/:id/lifecycle',
  authenticateJwt, requireRole('admin', 'verifier'),
  validate(changeLifecycleSchema), addressController.changeLifecycle);

// POST /api/entrance/:id/nfc — bind
router.post('/:id/nfc',
  authenticateJwt, requireRole('admin', 'verifier'),
  validate(bindNfcSchema), addressController.bindNfc);

// DELETE /api/entrance/:id/nfc — unbind
router.delete('/:id/nfc',
  authenticateJwt, requireRole('admin', 'verifier'),
  validate(entranceIdSchema), addressController.unbindNfc);

// GET /api/entrance/by-nfc/:nfcTagId — lookup
router.get('/by-nfc/:nfcTagId',
  authenticateAny('read'), validate(nfcTagIdSchema), addressController.getEntranceByNfc);

// GET /api/entrance/:id/occupants — list residents
router.get('/:id/occupants',
  authenticateJwt, validate(entranceIdSchema), occupantController.listOccupants);

module.exports = router;
