/**
 * PakkaPata — GS Settlement Contract Service (v0.10.9)
 *
 * RabtaChat server-to-server settlement contract (frozen handshake v0.10.6):
 *
 *   contractPing()                — GET  /api/contract/ping   (PUBLIC)
 *   listContractPayments()        — GET  /api/contract/payments?status=&limit=
 *   confirmContractPayment()      — POST /api/contract/payments/:payment_id/confirm
 *
 * Design rules (v0.10.9 improvements over v0.10.8):
 *   1) Dedicated clean module — payment files patched NAHI (naye files)
 *   2) Dual auth support routes-level (X-API-Key YA Bearer → normalize) — routes/contractRoutes.js
 *   3) Status whitelist validation — approved|acked|pending|failed|expired|initiated|credited
 *      (regex-injection band, koi string-concat SQL nahi — sirf prepared statements)
 *   4) limit bounds 1–200, default 50
 *   5) Feed row = ALIASED SUPERSET fields — RabtaChat ka frozen adapter jo expect kare wo mil jaye:
 *      payment_id + id, issuance_id, intent_id, status, amount + amount_pkr, currency,
 *      gs_amount + gs, gs_unit, phone + phone_e164, created_at, credited_at, acknowledged_at
 *   6) ping additive fields (service/version/contract/time)
 *   7) Har confirm par audit row; payments read par bhi light audit
 *   8) Consistent errors: {ok:false, error:'CODE'} + sahi 4xx
 *   9) payment_id path-param format validation — SQL injection safe
 *
 * Idempotency (double-mint guard):
 *   approved → acked  (audit: CONTRACT_PAYMENT_CONFIRMED, already_confirmed:false)
 *   acked    → 200 {ok, already_confirmed:true}  (koi dobara write NAHI)
 *   unknown  → 404 {ok:false, error:'NOT_FOUND'}
 */

const db = require('../config/database');
const { prepare } = db;
const audit = require('./auditService');

const CONTRACT_VERSION = 'v1';

// v0.10.9 improvement #3 — status whitelist (koi arbitrary string SQL mein nahi jata)
const STATUS_WHITELIST = ['approved', 'acked', 'pending', 'failed', 'expired', 'initiated', 'credited'];
const DEFAULT_STATUS = 'approved';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// v0.10.9 improvement #9 — payment_id format guard (gsi_/pi_ style ids safe, path traversal / SQL chars band)
const PAYMENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function pkgVersion() {
  try { return require('../../package.json').version; } catch { return '0.10.9'; }
}

// ─────────────────────────────────────────────
// 1) GET /api/contract/ping — PUBLIC, no auth
// ─────────────────────────────────────────────
function contractPing() {
  return {
    ok: true,
    service: 'pakkapata',
    version: pkgVersion(),
    contract: CONTRACT_VERSION,
    time: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────
// 2) GET /api/contract/payments?status=&limit= — auth (read)
//    gs_issuances LEFT JOIN payment_intents — aliased superset feed
// ─────────────────────────────────────────────
function listContractPayments({ status, limit } = {}, meta = {}) {
  // status whitelist
  const stRaw = String(status === undefined || status === null || String(status).trim() === ''
    ? DEFAULT_STATUS
    : status).trim().toLowerCase();
  if (!STATUS_WHITELIST.includes(stRaw)) {
    return {
      error: {
        http: 400,
        body: {
          ok: false,
          error: 'INVALID_STATUS',
          message: `status sirf in mein se ho sakta hai: ${STATUS_WHITELIST.join('|')}`,
        },
      },
    };
  }

  // limit bounds 1–200, default 50
  const limRaw = String(limit === undefined || limit === null ? '' : limit).trim();
  if (limRaw !== '' && !/^\d+$/.test(limRaw)) {
    return {
      error: {
        http: 400,
        body: { ok: false, error: 'LIMIT_INVALID', message: 'limit positive integer hona chahiye (1-200)' },
      },
    };
  }
  const lim = Math.min(Math.max(parseInt(limRaw || String(DEFAULT_LIMIT), 10), 1), MAX_LIMIT);

  // Prepared statement hi (better-sqlite3) — string-concat SQL KABHI nahi
  const rows = prepare(`
    SELECT i.id AS issuance_id, i.intent_id, i.msisdn, i.gs_amount, i.pkr_amount,
           i.status, i.approved_via, i.acknowledged_at, i.created_at,
           p.provider, p.provider_txn_id, p.status AS intent_status,
           p.amount_pkr AS intent_amount_pkr, p.processed_at AS credited_at
    FROM gs_issuances i
    LEFT JOIN payment_intents p ON p.id = i.intent_id
    WHERE i.status = ?
    ORDER BY i.created_at DESC
    LIMIT ?
  `).all(stRaw, lim);

  // v0.10.9 improvement #5 — aliased superset (RabtaChat frozen adapter compatible)
  const payments = rows.map((r) => ({
    payment_id: r.issuance_id,
    id: r.issuance_id,
    issuance_id: r.issuance_id,
    intent_id: r.intent_id,
    status: r.status,
    intent_status: r.intent_status || null,
    amount: r.pkr_amount,
    amount_pkr: r.pkr_amount != null ? r.pkr_amount : r.intent_amount_pkr,
    currency: 'PKR',
    gs_amount: r.gs_amount,
    gs: r.gs_amount,
    gs_unit: 'GS',
    phone: r.msisdn,
    phone_e164: r.msisdn,
    provider: r.provider || null,
    provider_txn_id: r.provider_txn_id || null,
    approved_via: r.approved_via,
    created_at: r.created_at,
    credited_at: r.credited_at || null,
    acknowledged_at: r.acknowledged_at || null,
  }));

  // v0.10.9 improvement #7 — payments read par light audit
  audit.log({
    apiKeyId: meta.apiKeyId || null,
    action: 'CONTRACT_PAYMENTS_LISTED',
    resourceType: 'gs_issuance',
    ipAddress: meta.ipAddress || null,
    userAgent: meta.userAgent || null,
    details: { status: stRaw, limit: lim, count: payments.length },
  });

  return {
    data: {
      ok: true,
      payments,
      count: payments.length,
      status: stRaw,
      limit: lim,
      generated_at: new Date().toISOString(),
    },
  };
}

// ─────────────────────────────────────────────
// 3) POST /api/contract/payments/:payment_id/confirm — auth (write), IDEMPOTENT
//    approved → acked | repeat → already_confirmed:true | unknown → 404
// ─────────────────────────────────────────────
function confirmContractPayment(paymentId, meta = {}) {
  const pid = String(paymentId === undefined || paymentId === null ? '' : paymentId).trim();

  // v0.10.9 improvement #9 — format validation (prepared statement phir bhi use hota hai)
  if (!pid || !PAYMENT_ID_RE.test(pid)) {
    return {
      error: {
        http: 400,
        body: { ok: false, error: 'PAYMENT_ID_INVALID', message: 'payment_id format invalid (A-Za-z0-9_- only, max 64)' },
      },
    };
  }

  const row = prepare('SELECT id, status, msisdn, gs_amount, pkr_amount FROM gs_issuances WHERE id = ?').get(pid);

  if (!row) {
    audit.log({
      apiKeyId: meta.apiKeyId || null,
      action: 'CONTRACT_PAYMENT_CONFIRM_UNKNOWN',
      resourceType: 'gs_issuance',
      resourceId: pid,
      ipAddress: meta.ipAddress || null,
      userAgent: meta.userAgent || null,
      details: { reason: 'payment_id not found' },
    });
    return {
      error: {
        http: 404,
        body: { ok: false, error: 'NOT_FOUND', message: 'payment_id unknown' },
      },
    };
  }

  // IDEMPOTENT repeat — koi dobara write NAHI (double-mint guard)
  if (row.status === 'acked') {
    audit.log({
      apiKeyId: meta.apiKeyId || null,
      action: 'CONTRACT_PAYMENT_CONFIRMED',
      resourceType: 'gs_issuance',
      resourceId: pid,
      ipAddress: meta.ipAddress || null,
      userAgent: meta.userAgent || null,
      details: { already_confirmed: true, msisdn: row.msisdn, gs_amount: row.gs_amount },
    });
    return {
      data: {
        ok: true,
        already_confirmed: true,
        payment_id: row.id,
        status: 'acked',
        acknowledged_at: row.acknowledged_at || null,
      },
    };
  }

  if (row.status !== 'approved') {
    audit.log({
      apiKeyId: meta.apiKeyId || null,
      action: 'CONTRACT_PAYMENT_CONFIRM_REJECTED',
      resourceType: 'gs_issuance',
      resourceId: pid,
      ipAddress: meta.ipAddress || null,
      userAgent: meta.userAgent || null,
      details: { reason: `status '${row.status}' confirm-able nahi (sirf approved)` },
    });
    return {
      error: {
        http: 409,
        body: {
          ok: false,
          error: 'INVALID_STATE',
          message: `payment status '${row.status}' hai — sirf 'approved' confirm ho sakta hai`,
        },
      },
    };
  }

  const ts = Date.now();
  prepare('UPDATE gs_issuances SET status = ?, acknowledged_at = ? WHERE id = ?').run('acked', ts, pid);

  // v0.10.9 improvement #7 — har confirm par audit row
  audit.log({
    apiKeyId: meta.apiKeyId || null,
    action: 'CONTRACT_PAYMENT_CONFIRMED',
    resourceType: 'gs_issuance',
    resourceId: pid,
    ipAddress: meta.ipAddress || null,
    userAgent: meta.userAgent || null,
    details: {
      already_confirmed: false,
      msisdn: row.msisdn,
      gs_amount: row.gs_amount,
      pkr_amount: row.pkr_amount,
      transition: 'approved->acked',
    },
  });

  return {
    data: {
      ok: true,
      already_confirmed: false,
      payment_id: pid,
      status: 'acked',
      gs_amount: row.gs_amount,
      acknowledged_at: ts,
    },
  };
}

module.exports = {
  CONTRACT_VERSION,
  STATUS_WHITELIST,
  contractPing,
  listContractPayments,
  confirmContractPayment,
};
