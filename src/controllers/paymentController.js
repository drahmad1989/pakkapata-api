/**
 * PakkaPata — Payment Controller (v0.10.4)
 *
 * Teen traffic types, teen auth models:
 *   1) Webhooks (JazzCash/Easypaisa)  → signature = auth (koi JWT/key nahi)
 *   2) GS contract (RabtaChat)        → X-API-Key (read/write scopes)
 *   3) Admin overview/cancel          → JWT + admin role
 */

const paymentService = require('../services/paymentService');

// ── 1) Provider webhooks ────────────────────────────────────
// NOTE: gateways form-urlencoded bhejte hain — express.json ke saath
// express.urlencoded({extended:true}) server.js mein already laga hai,
// to req.body dono cases mein object hota hai.

function webhookJazzcash(req, res, next) {
  try {
    const out = paymentService.processWebhook('jazzcash', req.body, {
      ip: req.ip, userAgent: req.get('user-agent'),
    });
    return res.status(out.http).json(out.body);
  } catch (err) { return next(err); }
}

function webhookEasypaisa(req, res, next) {
  try {
    const out = paymentService.processWebhook('easypaisa', req.body, {
      ip: req.ip, userAgent: req.get('user-agent'),
    });
    return res.status(out.http).json(out.body);
  } catch (err) { return next(err); }
}

// ── 2) GS contract (RabtaChat, X-API-Key) ───────────────────
function createPurchaseIntent(req, res, next) {
  try {
    const out = paymentService.createPurchaseIntent(req.body || {});
    if (out.error) return res.status(out.error.http).json(out.error.body);
    return res.status(201).json({ message: 'Purchase intent bani — payment aate hi auto-approve ho jayegi.', data: out.data });
  } catch (err) { return next(err); }
}

function listIssuances(req, res, next) {
  try {
    const out = paymentService.listIssuances({
      msisdn: req.query.msisdn,
      status: req.query.status,
    });
    if (out.error) return res.status(out.error.http).json(out.error.body);
    return res.json({ count: out.data.length, data: out.data });
  } catch (err) { return next(err); }
}

function ackIssuances(req, res, next) {
  try {
    const out = paymentService.ackIssuances((req.body || {}).issuance_ids);
    if (out.error) return res.status(out.error.http).json(out.error.body);
    return res.json({ message: 'Issuances ack ho gayin (GS credit ho gaya).', data: out.data });
  } catch (err) { return next(err); }
}

// ── 3) Admin (JWT) ──────────────────────────────────────────
function adminOverview(req, res, next) {
  try {
    const out = paymentService.adminOverview(req.query.limit);
    return res.json(out);
  } catch (err) { return next(err); }
}

function cancelIssuance(req, res, next) {
  try {
    const out = paymentService.cancelIssuance(req.params.id);
    if (out.error) return res.status(out.error.http).json(out.error.body);
    return res.json({ message: 'Issuance cancel ho gayi.', data: out.data });
  } catch (err) { return next(err); }
}

module.exports = {
  webhookJazzcash,
  webhookEasypaisa,
  createPurchaseIntent,
  listIssuances,
  ackIssuances,
  adminOverview,
  cancelIssuance,
};
