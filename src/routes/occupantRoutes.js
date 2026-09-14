/**
 * GeoPata — Occupant Routes (v0.2.1)
 * Mounted at: /api/occupant  AND  /api/entrance (for list-by-entrance)
 *
 *   POST   /api/occupant              — createOccupant  (JWT any role OR API key:write)
 *   DELETE /api/occupant/:id           — deleteOccupant (JWT verifier+)
 *   GET    /api/entrance/:id/occupants — listOccupants  (JWT any role)
 *
 * Note: GET /api/entrance/:id/occupants is mounted at /api/entrance,
 *       not under /api/occupant. See server.js for mounting.
 */

const express = require('express');
const router = express.Router();

const validate = require('../middleware/validate');
const { authenticateAny, authenticateJwt, requireRole } = require('../middleware/auth');
const { createOccupantSchema } = require('../schemas');
const controller = require('../controllers/occupantController');

// POST /api/occupant — create
router.post('/', authenticateAny('write'), validate(createOccupantSchema), controller.createOccupant);

// DELETE /api/occupant/:id — soft delete (deactivate)
router.delete('/:id', authenticateJwt, requireRole('admin', 'verifier'), controller.deleteOccupant);

module.exports = router;
