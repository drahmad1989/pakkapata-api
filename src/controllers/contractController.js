/**
 * PakkaPata — GS Contract Controller (v0.10.9)
 *
 * RabtaChat server-to-server contract endpoints (frozen handshake v0.10.6):
 *
 *   GET  /api/contract/ping                          — PUBLIC (no auth)
 *   GET  /api/contract/payments?status=&limit=       — X-API-Key (read) YA Bearer (auto-normalize)
 *   POST /api/contract/payments/:payment_id/confirm  — X-API-Key (write) YA Bearer (auto-normalize)
 *
 * Auth middleware routes/contractRoutes.js mein hai — Bearer header ko
 * X-API-Key mein normalize karke shared authenticateApiKey chalata hai
 * (v0.10.9 improvement #2: dual auth header).
 */

const contractService = require('../services/contractService');

// auth middleware req.auth mein yeh decorate karta hai (auth.js)
function metaFrom(req) {
  return {
    apiKeyId: req.auth ? req.auth.apiKeyId : null,
    ipAddress: req.auth ? req.auth.ipAddress : (req.ip || null),
    userAgent: req.auth ? req.auth.userAgent : (req.get ? req.get('user-agent') : null),
  };
}

// ── 1) GET /api/contract/ping (public) ──────────────────────
function contractPing(req, res, next) {
  try {
    return res.json(contractService.contractPing());
  } catch (err) { return next(err); }
}

// ── 2) GET /api/contract/payments?status=&limit= ────────────
function contractPayments(req, res, next) {
  try {
    const out = contractService.listContractPayments(
      { status: req.query.status, limit: req.query.limit },
      metaFrom(req)
    );
    if (out.error) return res.status(out.error.http).json(out.error.body);
    return res.json(out.data);
  } catch (err) { return next(err); }
}

// ── 3) POST /api/contract/payments/:payment_id/confirm ──────
function contractPaymentConfirm(req, res, next) {
  try {
    const out = contractService.confirmContractPayment(req.params.payment_id, metaFrom(req));
    if (out.error) return res.status(out.error.http).json(out.error.body);
    return res.json(out.data);
  } catch (err) { return next(err); }
}

module.exports = {
  contractPing,
  contractPayments,
  contractPaymentConfirm,
};
