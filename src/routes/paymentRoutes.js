/**
 * PakkaPata — Payment Routes (v0.10.4)
 *
 * Mount: app.use('/api', paymentRoutes)
 *
 *   POST /api/payments/webhook/jazzcash    signature-verified (no JWT/key)
 *   POST /api/payments/webhook/easypaisa   signature-verified (no JWT/key)
 *   POST /api/gs/purchase-intents          X-API-Key (write) — RabtaChat
 *   GET  /api/gs/issuances                 X-API-Key (read)  — RabtaChat poll
 *   POST /api/gs/issuances/ack             X-API-Key (write) — RabtaChat ack
 *   GET  /api/admin/payments               JWT admin
 *   POST /api/admin/payments/issuances/:id/cancel  JWT admin
 */

const express = require('express');
const router = express.Router();
const controller = require('../controllers/paymentController');
const { authenticateApiKey, authenticateJwt, requireRole } = require('../middleware/auth');

// Webhooks — signature hi auth hai (rate limiter server.js mein webhookLimiter)
router.post('/payments/webhook/jazzcash', controller.webhookJazzcash);
router.post('/payments/webhook/easypaisa', controller.webhookEasypaisa);

// GS contract — RabtaChat server-to-server (X-API-Key)
router.post('/gs/purchase-intents', authenticateApiKey('write'), controller.createPurchaseIntent);
router.get('/gs/issuances', authenticateApiKey('read'), controller.listIssuances);
router.post('/gs/issuances/ack', authenticateApiKey('write'), controller.ackIssuances);

// Admin — dashboard
router.get('/admin/payments', authenticateJwt, requireRole('admin'), controller.adminOverview);
router.post('/admin/payments/issuances/:id/cancel', authenticateJwt, requireRole('admin'), controller.cancelIssuance);

module.exports = router;
