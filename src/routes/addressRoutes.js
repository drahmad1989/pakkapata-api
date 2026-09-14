/**
 * GeoPata — Address Routes (v0.2.0)
 * Mounted at: /api/address
 *
 *   POST   /              → createAddress  (JWT any role OR API key:write)
 *   GET    /:code          → lookup         (JWT any role OR API key:read)
 *   PUT    /:code          → update         (JWT verifier+)
 *
 * Other address-related routes are mounted separately:
 *   GET    /api/addresses        → list + paginate (JWT only)
 *   POST   /api/verify/:code     → upgrade tier    (JWT verifier+)
 *   PATCH  /api/entrance/:id/lifecycle → change lifecycle (JWT verifier+)
 *   POST   /api/entrance/:id/nfc → bind NFC tag (JWT verifier+)
 *   DELETE /api/entrance/:id/nfc → unbind NFC tag (JWT verifier+)
 *   GET    /api/entrance/by-nfc/:nfcTagId → lookup by NFC (JWT or API key:read)
 *   GET    /api/radius           → spatial search (JWT or API key:read)
 */

const express = require('express');
const router = express.Router();

const validate = require('../middleware/validate');
const { authenticateAny, authenticateJwt, requireRole } = require('../middleware/auth');
const {
  createAddressSchema, addressByCodeSchema, updateAddressSchema,
} = require('../schemas');
const controller = require('../controllers/addressController');

// POST /api/address  — create
router.post('/', authenticateAny('write'), validate(createAddressSchema), controller.createAddress);

// GET /api/address/:code  — lookup
router.get('/:code', authenticateAny('read'), validate(addressByCodeSchema), controller.getAddressByCode);

// PUT /api/address/:code  — update property_type / verification_tier
router.put('/:code',
  authenticateJwt, requireRole('admin', 'verifier'),
  validate(updateAddressSchema), controller.updateAddress);

module.exports = router;
