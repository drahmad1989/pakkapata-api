/**
 * GeoPata — Village Boundary Routes (v0.4.2)
 * Mounted at: /api/village-boundaries
 *
 *   GET    /                          — list all boundaries (JWT any role)
 *   GET    /:areaCode                  — get specific boundary (JWT any role)
 *   POST   /                          — create/update boundary (JWT admin)
 *   DELETE /:areaCode                  — deactivate boundary (JWT admin)
 *   GET    /detect?lat=&lng=           — auto-detect block (JWT any role or API key)
 *   GET    /:areaCode/blocks           — get quadrant rectangles (JWT any role)
 */

const express = require('express');
const router = express.Router();

const validate = require('../middleware/validate');
const { authenticateAny, authenticateJwt, requireRole } = require('../middleware/auth');
const {
  createBoundarySchema, boundaryByAreaCodeSchema, detectBlockSchema,
} = require('../schemas');
const controller = require('../controllers/villageBoundaryController');

// GET /api/village-boundaries/detect — must be before :areaCode
router.get('/detect',
  authenticateAny('read'),
  validate(detectBlockSchema),
  controller.detectBlock
);

// POST /api/village-boundaries/generate-smart — smart boundary from OSM buildings
router.post('/generate-smart',
  authenticateJwt, requireRole('admin'),
  controller.generateSmart
);

// POST /api/village-boundaries/auto-fetch — auto-fetch boundary by place name
router.post('/auto-fetch',
  authenticateJwt, requireRole('admin'),
  controller.autoFetch
);

// GET /api/village-boundaries — list all
router.get('/',
  authenticateJwt,
  controller.listBoundaries
);

// POST /api/village-boundaries — create/update (admin)
router.post('/',
  authenticateJwt, requireRole('admin'),
  validate(createBoundarySchema),
  controller.createBoundary
);

// GET /api/village-boundaries/:areaCode — get one
router.get('/:areaCode',
  authenticateJwt,
  validate(boundaryByAreaCodeSchema),
  controller.getBoundary
);

// GET /api/village-boundaries/:areaCode/blocks — quadrant rectangles
router.get('/:areaCode/blocks',
  authenticateAny('read'),
  validate(boundaryByAreaCodeSchema),
  controller.getBlocks
);

// DELETE /api/village-boundaries/:areaCode — deactivate (admin)
router.delete('/:areaCode',
  authenticateJwt, requireRole('admin'),
  validate(boundaryByAreaCodeSchema),
  controller.deleteBoundary
);

module.exports = router;
