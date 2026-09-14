/**
 * GeoPata — Geospatial Query Routes (v0.2.0)
 * Mounted at: /api  (for /api/radius)
 *
 *   GET  /radius?lat=&long=&radius=   → getAddressesInRadius  (JWT or API key:read)
 */

const express = require('express');
const router = express.Router();

const validate = require('../middleware/validate');
const { authenticateAny } = require('../middleware/auth');
const { radiusSearchSchema } = require('../schemas');
const controller = require('../controllers/addressController');

router.get('/radius', authenticateAny('read'), validate(radiusSearchSchema), controller.getAddressesInRadius);

module.exports = router;
