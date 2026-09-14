/**
 * GeoPata — Seed Routes (v0.9.0)
 * Mounted at: /api/admin/seed-pakistan
 * All routes require JWT + admin role.
 *
 *   POST /api/admin/seed-pakistan          — start seed job (202, background)
 *   GET  /api/admin/seed-pakistan/status   — live progress
 *   POST /api/admin/seed-pakistan/cancel   — cancel running job
 *   GET  /api/admin/seed-pakistan/stats    — counts + data file status
 */

const express = require('express');
const router = express.Router();

const { authenticateJwt, requireRole } = require('../middleware/auth');
const controller = require('../controllers/seedController');

router.use(authenticateJwt, requireRole('admin'));

router.post('/', controller.startSeed);
router.get('/status', controller.getStatus);
router.post('/cancel', controller.cancelSeed);
router.get('/stats', controller.getStats);

module.exports = router;
