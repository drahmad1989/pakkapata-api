/**
 * PakkaPata — GS Contract Routes (v0.10.9)
 *
 * Mount: app.use('/api/contract', require('./src/routes/contractRoutes'))
 *
 *   GET  /api/contract/ping                          PUBLIC  {ok,service,version,contract,time}
 *   GET  /api/contract/payments?status=&limit=       auth(read)   aliased superset feed
 *   POST /api/contract/payments/:payment_id/confirm  auth(write)  idempotent approved→acked
 *
 * v0.10.9 improvement #2 — DUAL AUTH:
 *   RabtaChat `X-API-Key: <key>` YA `Authorization: Bearer <key>` dono bhej sakta hai.
 *   normalizeAuth() pehle Bearer ko X-API-Key header mein normalize karta hai,
 *   phir shared authenticateApiKey (auth.js) chalta hai — 401 API_KEY_MISSING/
 *   API_KEY_INVALID/INSUFFICIENT_SCOPE sab waise hi jaise baaki API mein.
 */

const express = require('express');
const router = express.Router();
const controller = require('../controllers/contractController');
const { authenticateApiKey } = require('../middleware/auth');

/**
 * Bearer → X-API-Key normalize, phir scope-checked API key auth.
 * @param {string} requiredScope — 'read' | 'write'
 */
function normalizeAuth(requiredScope) {
  return (req, res, next) => {
    const hasApiKey = req.headers['x-api-key'] || req.headers['X-API-Key'];
    if (!hasApiKey) {
      const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
      if (auth.startsWith('Bearer ')) {
        const token = auth.slice(7).trim();
        if (token) req.headers['x-api-key'] = token; // normalize → shared middleware
      }
    }
    return authenticateApiKey(requiredScope)(req, res, next);
  };
}

// PUBLIC — no auth (RabtaChat "Test connection" yehi ping karta hai)
router.get('/ping', controller.contractPing);

// Settlement feed — read scope
router.get('/payments', normalizeAuth('read'), controller.contractPayments);

// Confirm/ack — write scope, idempotent
router.post('/payments/:payment_id/confirm', normalizeAuth('write'), controller.contractPaymentConfirm);

module.exports = router;
