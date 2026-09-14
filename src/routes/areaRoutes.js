/**
 * GeoPata — Area Routes (v0.3.0)
 *
 * Mounting strategy (see server.js):
 *   /api/areas                       → areaRoutes (general list, create, seed)
 *   /api/areas/:code                 → areaRoutes (get, update, delete, addresses)
 *   /api/areas/type/:type            → areaRoutes (list by type)
 *   /api/areas/reverse-geocode       → areaRoutes (reverse geocode)
 *   /api/addresses/:code/assign-area → verifyRoutes (assign area to address)
 *
 * Auth model:
 *   - GET endpoints: JWT or API key (read scope)
 *   - POST/PUT/DELETE: JWT admin only
 *   - POST /seed: JWT admin only (bulk import)
 */

const express = require('express');
const router = express.Router();

const validate = require('../middleware/validate');
const { authenticateAny, authenticateJwt, requireRole } = require('../middleware/auth');
const {
  createAreaSchema, updateAreaSchema, areaByCodeSchema, areaTypeParamSchema,
  listAreasSchema, reverseGeocodeSchema, seedAreasSchema,
} = require('../schemas');
const controller = require('../controllers/areaController');

// ─────────────────────────────────────────────
// Public/Read (JWT or API key:read)
// IMPORTANT: order matters — specific routes before :code
// ─────────────────────────────────────────────

// GET /api/areas — list with filters
router.get('/',
  authenticateAny('read'),
  validate(listAreasSchema),
  controller.listAreas
);

// GET /api/areas/reverse-geocode — must be before :code
router.get('/reverse-geocode',
  authenticateAny('read'),
  validate(reverseGeocodeSchema),
  controller.reverseGeocode
);

// GET /api/areas/type/:type — list by type (must be before :code)
router.get('/type/:type',
  authenticateAny('read'),
  validate(areaTypeParamSchema),
  controller.listAreasByType
);

// POST /api/areas/seed — bulk import (admin only) — must be before :code
router.post('/seed',
  authenticateJwt, requireRole('admin'),
  validate(seedAreasSchema),
  controller.seedAreas
);

// POST /api/areas/seed-default — load default Pakistan areas (admin only, no body)
router.post('/seed-default',
  authenticateJwt, requireRole('admin'),
  controller.seedDefaultAreas
);

// GET /api/areas/:code — get single area + chain + children
router.get('/:code',
  authenticateAny('read'),
  validate(areaByCodeSchema),
  controller.getArea
);

// GET /api/areas/:code/addresses — list all addresses in this area
router.get('/:code/addresses',
  authenticateAny('read'),
  validate(areaByCodeSchema),
  controller.listAddressesInArea
);

// ─────────────────────────────────────────────
// Mutations (JWT admin only)
// ─────────────────────────────────────────────

// POST /api/areas — create new area
router.post('/',
  authenticateJwt, requireRole('admin'),
  validate(createAreaSchema),
  controller.createArea
);

// PUT /api/areas/:code — update area
router.put('/:code',
  authenticateJwt, requireRole('admin'),
  validate(updateAreaSchema),
  controller.updateArea
);

// DELETE /api/areas/:code — deactivate area (soft delete)
router.delete('/:code',
  authenticateJwt, requireRole('admin'),
  validate(areaByCodeSchema),
  controller.deleteArea
);

// ─────────────────────────────────────────────
// Area name-lock (v0.10.7 — Mashwara Box / Stage-3 name plates)
// ─────────────────────────────────────────────

// POST /api/areas/:code/lock — names/codes IMMUTABLE (idempotent)
router.post('/:code/lock',
  authenticateJwt, requireRole('admin'),
  validate(areaByCodeSchema),
  controller.lockArea
);

// POST /api/areas/:code/unlock — exception path (loud audit)
router.post('/:code/unlock',
  authenticateJwt, requireRole('admin'),
  validate(areaByCodeSchema),
  controller.unlockArea
);

module.exports = router;
