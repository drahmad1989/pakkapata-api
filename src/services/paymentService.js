/**
 * PakkaPata — Payment & GS Issuance Service (v0.10.4)
 *
 * JazzCash/Easypaisa payment webhooks → GS auto-approval pipeline:
 *
 *   1) parseWebhookPayload()  — JSON ya form-urlencoded provider payload ko
 *                               normalize karo (txn id / amount / msisdn / status)
 *   2) verifySignature()      — JazzCash: HMAC-SHA256(sorted pp_* values, salt)
 *                               Easypaisa: HMAC-SHA256(sorted values, hash key)
 *                               PAYMENTS_DEBUG=1 → unsigned test webhooks allowed
 *   3) processWebhook()       — idempotent insert (provider+txn_id unique) →
 *                               auto-approve → gs_issuance (1 GS = 1 PKR peg)
 *   4) Issuance query/ack     — RabtaChat approved issuances fetch + ack karta hai
 *                               (X-API-Key contract endpoints)
 *
 * Security rules:
 *   - Idempotency: gateway retries ko 200 duplicate milta hai, dobara issuance
 *     KABHI nahi banti (double-credit impossible)
 *   - Failed transactions store hoti hain magar issuance NAHI banti
 *   - Full key/signature secrets response mein kabhi nahi jate
 *   - Har fs/DB operation try/catch — provider retry storms se crash nahi
 *
 * Jab real gateway credentials aa jayen (JAZZCASH_SALT / EASYPAISA_HASH_KEY)
 * to sirf .env bharna hai — field mappings yahan centralized hain.
 */

const crypto = require('crypto');
const db = require('../config/database');
const { prepare } = db;
const { normalizePkPhone } = require('./otpService');
const audit = require('./auditService');

// 1 GS = 1 PKR (RabtaChat purchase-request route.ts ke peg ke mutabiq)
const GS_PKR_PEG = 1;

const PROVIDERS = ['jazzcash', 'easypaisa', 'bank', 'crypto', 'manual'];

function nowMs() { return Date.now(); }

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

// ─────────────────────────────────────────────
// AMOUNT PARSING
// ─────────────────────────────────────────────
/**
 * Provider amount → PKR (rupees, float).
 * JazzCash IPN: pure digits = PAISA (10000 = Rs 100); "PKR.100.0" = Rs 100.
 * Easypaisa: transactionAmount paisa string (10000 = Rs 100).
 * Debug JSON: amount_pkr already in rupees.
 */
function parseAmountToPkr(raw, provider) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.round(raw * 100) / 100;
  const s = String(raw).trim();
  // "PKR.100.0" / "PKR 100.0" hosted-checkout format → rupees.paisa
  const pkrFmt = s.match(/^PKR\.?\s*(\d+)(?:\.(\d{1,2}))?$/i);
  if (pkrFmt) {
    const rupees = parseInt(pkrFmt[1], 10);
    const paisa = pkrFmt[2] ? parseInt(pkrFmt[2].padEnd(2, '0'), 10) : 0;
    return Math.round((rupees + paisa / 100) * 100) / 100;
  }
  const digits = s.replace(/[^\d.]/g, '');
  if (!digits || Number.isNaN(parseFloat(digits))) return null;
  const val = parseFloat(digits);
  if (!Number.isFinite(val) || val <= 0) return null;
  // Pure digits → paisa (gateway convention), convert ÷100
  const rupees = provider === 'manual' ? val : val / 100;
  return Math.round(rupees * 100) / 100;
}

// ─────────────────────────────────────────────
// PAYLOAD PARSING (JSON + form-urlencoded dono)
// ─────────────────────────────────────────────
function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
  }
  return null;
}

function parseJazzcash(body) {
  const b = body || {};
  const rawTxn = pick(b, ['pp_TxnRefNo', 'pp_TxnRef', 'pp_RetreivalReferenceNo', 'transaction_id', 'txn_id']);
  const rawAmount = pick(b, ['pp_Amount', 'amount']);
  const rawMsisdn = pick(b, ['pp_MobileNo', 'pp_Msisdn', 'msisdn']);
  const respCode = pick(b, ['pp_ResponseCode', 'response_code']);
  const ok = respCode === null ? true : respCode === '000' || respCode.toUpperCase() === 'SUCCESS';
  return { provider_txn_id: rawTxn, raw_amount: rawAmount, msisdn_raw: rawMsisdn, success: ok, fields: b };
}

function parseEasypaisa(body) {
  const b = body || {};
  const rawTxn = pick(b, ['transactionId', 'orderReferenceNumber', 'transaction_id', 'txn_id']);
  const rawAmount = pick(b, ['transactionAmount', 'amount']);
  const rawMsisdn = pick(b, ['msisdn', 'customerMsisdn', 'phone']);
  const st = pick(b, ['transactionStatus', 'status']);
  const ok = st === null ? true : ['0000', 'success', 'succeeded', 'completed'].includes(st.toLowerCase());
  return { provider_txn_id: rawTxn, raw_amount: rawAmount, msisdn_raw: rawMsisdn, success: ok, fields: b };
}

// ─────────────────────────────────────────────
// SIGNATURE VERIFICATION
// ─────────────────────────────────────────────
/**
 * JazzCash secure hash: HMAC-SHA256(key=salt, msg=sorted pp_* VALUES joined '&').
 * pp_SecureHash khud message se EXCLUDE hota hai. Case-insensitive hex compare.
 */
function verifyJazzcashSignature(fields, salt) {
  if (!salt) return { valid: false, reason: 'JAZZCASH_SALT not configured' };
  const provided = String(fields.pp_SecureHash || fields.pp_secureHash || '').toLowerCase();
  if (!provided) return { valid: false, reason: 'pp_SecureHash missing' };
  const parts = Object.keys(fields)
    .filter((k) => k.toLowerCase().startsWith('pp_') && k.toLowerCase() !== 'pp_securehash')
    .sort()
    .map((k) => String(fields[k]));
  const msg = `${parts.join('&')}&`;
  const expected = crypto.createHmac('sha256', salt).update(msg).digest('hex').toLowerCase();
  try {
    const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided.padEnd(expected.length, '0').slice(0, expected.length)));
    return { valid: ok, reason: ok ? null : 'HMAC mismatch' };
  } catch { return { valid: false, reason: 'HMAC compare error' }; }
}

/** Easypaisa: HMAC-SHA256(key=hashKey, msg=sorted values joined '&') over sab fields (signature exclude). */
function verifyEasypaisaSignature(fields, hashKey) {
  if (!hashKey) return { valid: false, reason: 'EASYPAISA_HASH_KEY not configured' };
  const provided = String(fields.signature || fields.Signature || '').toLowerCase();
  if (!provided) return { valid: false, reason: 'signature missing' };
  const parts = Object.keys(fields)
    .filter((k) => k.toLowerCase() !== 'signature')
    .sort()
    .map((k) => String(fields[k]));
  const expected = crypto.createHmac('sha256', hashKey).update(parts.join('&')).digest('hex').toLowerCase();
  try {
    const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided.padEnd(expected.length, '0').slice(0, expected.length)));
    return { valid: ok, reason: ok ? null : 'HMAC mismatch' };
  } catch { return { valid: false, reason: 'HMAC compare error' }; }
}

// ─────────────────────────────────────────────
// WEBHOOK PROCESSING (idempotent core)
// ─────────────────────────────────────────────
/**
 * @returns {number} status code jo controller bhejna chahta hai
 * Full result: { http, body }
 */
function processWebhook(provider, body, meta = {}) {
  const debugMode = process.env.PAYMENTS_DEBUG === '1';
  const saltCfg = provider === 'jazzcash' ? process.env.JAZZCASH_SALT : process.env.EASYPAISA_HASH_KEY;

  if (provider === 'jazzcash' && !saltCfg && !debugMode) {
    return { http: 503, body: { error: 'PAYMENTS_NOT_CONFIGURED', message: 'JAZZCASH_SALT set nahi hai (ya PAYMENTS_DEBUG=1 karo testing ke liye)' } };
  }
  if (provider === 'easypaisa' && !saltCfg && !debugMode) {
    return { http: 503, body: { error: 'PAYMENTS_NOT_CONFIGURED', message: 'EASYPAISA_HASH_KEY set nahi hai (ya PAYMENTS_DEBUG=1 karo testing ke liye)' } };
  }

  // Debug mode: clean JSON body {provider_txn_id, amount_pkr, msisdn, success?}
  let parsed;
  if (debugMode && body && body.amount_pkr !== undefined && !body.pp_Amount && !body.transactionAmount) {
    parsed = {
      provider_txn_id: body.provider_txn_id ? String(body.provider_txn_id) : null,
      raw_amount: null,
      msisdn_raw: body.msisdn ? String(body.msisdn) : null,
      success: body.success !== false,
      fields: body,
      debug_amount_pkr: Number(body.amount_pkr),
    };
  } else {
    parsed = provider === 'jazzcash' ? parseJazzcash(body) : parseEasypaisa(body);
  }

  // Signature verify
  let signatureValid = false;
  let signatureReason = null;
  if (debugMode && parsed.debug_amount_pkr !== undefined) {
    signatureValid = false;
    signatureReason = 'PAYMENTS_DEBUG unsigned test webhook';
  } else if (provider === 'jazzcash') {
    const v = verifyJazzcashSignature(parsed.fields, saltCfg);
    signatureValid = v.valid; signatureReason = v.reason;
  } else {
    const v = verifyEasypaisaSignature(parsed.fields, saltCfg);
    signatureValid = v.valid; signatureReason = v.reason;
  }
  if (!signatureValid && !debugMode) {
    audit.log({
      action: 'PAYMENT_WEBHOOK_REJECTED',
      resourceType: 'payment_intent',
      resourceId: parsed.provider_txn_id || 'unknown',
      ipAddress: meta.ip || null,
      userAgent: meta.userAgent || null,
      details: { provider, reason: signatureReason },
    });
    return { http: 401, body: { error: 'SIGNATURE_INVALID', message: `Webhook signature verify nahi hui: ${signatureReason}` } };
  }

  // Amount + msisdn normalize
  const amountPkr = parsed.debug_amount_pkr !== undefined
    ? (Number.isFinite(parsed.debug_amount_pkr) && parsed.debug_amount_pkr > 0 ? Math.round(parsed.debug_amount_pkr * 100) / 100 : null)
    : parseAmountToPkr(parsed.raw_amount, provider);
  const msisdn = parsed.msisdn_raw ? normalizePkPhone(parsed.msisdn_raw) : null;

  const baseRecord = {
    provider,
    provider_txn_id: parsed.provider_txn_id,
    msisdn,
    amount_pkr: amountPkr,
    signature_valid: signatureValid ? 1 : 0,
    raw_payload: JSON.stringify(parsed.fields).slice(0, 8000),
  };

  // Validation — bina amount/txn ke process nahi kar sakte
  if (!baseRecord.provider_txn_id || baseRecord.amount_pkr === null) {
    return insertIntentAndRespond({ ...baseRecord, status: 'failed', failure_reason: !baseRecord.provider_txn_id ? 'txn id missing' : 'amount parse fail' },
      { http: 400, body: { error: 'PAYMENT_MALFORMED', message: 'txn id ya amount missing/invalid — intent failed store hua (retry par duplicate 200 milega nahi, 400 hi aayega)' } });
  }
  if (!msisdn) {
    return insertIntentAndRespond({ ...baseRecord, status: 'failed', failure_reason: 'msisdn missing/invalid PK mobile' },
      { http: 400, body: { error: 'MSISDN_INVALID', message: 'Payer ka PK mobile number nahi mila/invalid — manual reconciliation karo' } });
  }

  // IDEMPOTENCY — same (provider, txn_id) dobara aaye → pehli wali batao, naya issuance NAHI
  const existing = baseRecord.provider_txn_id
    ? prepare('SELECT id, status, msisdn, amount_pkr FROM payment_intents WHERE provider = ? AND provider_txn_id = ?')
        .get(provider, baseRecord.provider_txn_id)
    : null;
  if (existing) {
    const prevIssuance = prepare('SELECT id, status FROM gs_issuances WHERE intent_id = ?').get(existing.id);
    return {
      http: 200,
      body: {
        result: 'duplicate',
        message: 'Ye txn pehle process ho chuki — koi naya issuance nahi bana (idempotent).',
        intent_id: existing.id,
        intent_status: existing.status,
        issuance_id: prevIssuance ? prevIssuance.id : null,
      },
    };
  }

  // Failed transaction → store karo, issuance NAHI banti
  if (!parsed.success) {
    return insertIntentAndRespond({ ...baseRecord, status: 'failed', failure_reason: `provider status: failed/declined` },
      { http: 200, body: { result: 'failed_txn_stored', message: 'Failed/declined transaction record hui — GS issuance nahi bani.' } });
  }

  // SUCCESS → intent + auto-approved issuance (1 GS = 1 PKR)
  const intentId = newId('pi');
  const gsAmount = Math.round(baseRecord.amount_pkr * GS_PKR_PEG * 100) / 100;
  prepare(`INSERT INTO payment_intents
       (id, provider, provider_txn_id, msisdn, amount_pkr, reference, status, signature_valid, raw_payload, failure_reason, created_at, processed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(intentId, provider, baseRecord.provider_txn_id, msisdn, baseRecord.amount_pkr,
    body && body.reference ? String(body.reference).slice(0, 128) : null,
    'verified', baseRecord.signature_valid, baseRecord.raw_payload, null, nowMs(), nowMs());

  const issuanceId = newId('gsi');
  prepare(`INSERT INTO gs_issuances (id, intent_id, msisdn, gs_amount, pkr_amount, status, approved_via, acknowledged_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`).run(issuanceId, intentId, msisdn, gsAmount, baseRecord.amount_pkr, 'approved', 'webhook', null, nowMs());

  audit.log({
    action: 'PAYMENT_WEBHOOK_OK',
    resourceType: 'payment_intent',
    resourceId: intentId,
    ipAddress: meta.ip || null,
    userAgent: meta.userAgent || null,
    details: { provider, txn: baseRecord.provider_txn_id, amount_pkr: baseRecord.amount_pkr, msisdn, signature_valid: !!signatureValid, debug: !signatureValid },
  });
  audit.log({
    action: 'GS_ISSUANCE_APPROVED',
    resourceType: 'gs_issuance',
    resourceId: issuanceId,
    ipAddress: meta.ip || null,
    userAgent: meta.userAgent || null,
    details: { intent_id: intentId, msisdn, gs_amount: gsAmount, peg: GS_PKR_PEG, via: 'webhook-auto' },
  });

  return {
    http: 200,
    body: {
      result: 'approved',
      message: 'Payment verified — GS issuance auto-approve ho gayi (RabtaChat polling par credit karega).',
      data: { intent_id: intentId, issuance_id: issuanceId, msisdn, amount_pkr: baseRecord.amount_pkr, gs_amount: gsAmount },
    },
  };
}

function insertIntentAndRespond(record, failResponse) {
  const id = newId('pi');
  try {
    prepare(`INSERT INTO payment_intents
         (id, provider, provider_txn_id, msisdn, amount_pkr, reference, status, signature_valid, raw_payload, failure_reason, created_at, processed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, record.provider, record.provider_txn_id, record.msisdn, record.amount_pkr,
      record.reference || null, record.status, record.signature_valid, record.raw_payload,
      record.failure_reason, nowMs(), nowMs());
    audit.log({
      action: 'PAYMENT_WEBHOOK_MALFORMED',
      resourceType: 'payment_intent',
      resourceId: id,
      details: { provider: record.provider, reason: record.failure_reason },
    });
  } catch (err) {
    // Store fail par bhi 400 hi jaye — magar server crash na ho
    // eslint-disable-next-line no-console
    console.warn('[payments] intent store fail:', err.message);
  }
  failResponse.body.intent_id = id;
  return failResponse;
}

// ─────────────────────────────────────────────
// CONTRACT: PURCHASE INTENTS + ISSUANCES (RabtaChat, X-API-Key)
// ─────────────────────────────────────────────
function createPurchaseIntent({ msisdn, amount_pkr, reference, method }) {
  const phone = normalizePkPhone(msisdn);
  if (!phone) return { error: { http: 400, body: { error: 'MSISDN_INVALID', message: 'msisdn valid PK mobile nahi (03XX/+92/92XX)' } } };
  const amt = Number(amount_pkr);
  if (!Number.isFinite(amt) || amt < 1) return { error: { http: 400, body: { error: 'AMOUNT_INVALID', message: 'amount_pkr >= 1 hona chahiye' } } };
  const prov = PROVIDERS.includes(method) ? method : 'jazzcash';
  const id = newId('pi');
  prepare(`INSERT INTO payment_intents
       (id, provider, provider_txn_id, msisdn, amount_pkr, reference, status, signature_valid, raw_payload, failure_reason, created_at, processed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, prov, null, phone, Math.round(amt * 100) / 100,
    reference ? String(reference).slice(0, 128) : null, 'pending', 0, JSON.stringify({ source: 'purchase-intent-api', reference: reference || null }), null, nowMs(), null);
  return { data: { intent_id: id, msisdn: phone, amount_pkr: Math.round(amt * 100) / 100, reference: reference || null, method: prov, status: 'pending' } };
}

function listIssuances({ msisdn, status }) {
  const phone = msisdn ? normalizePkPhone(msisdn) : null;
  if (msisdn && !phone) return { error: { http: 400, body: { error: 'MSISDN_INVALID', message: 'msisdn valid PK mobile nahi' } } };
  const where = []; const params = [];
  if (phone) { where.push('msisdn = ?'); params.push(phone); }
  if (status) { where.push('status = ?'); params.push(String(status)); }
  const sql = `SELECT id, intent_id, msisdn, gs_amount, pkr_amount, status, approved_via, acknowledged_at, created_at
               FROM gs_issuances ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY created_at DESC LIMIT 100`;
  const rows = prepare(sql).all(...params);
  return { data: rows };
}

function ackIssuances(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) {
    return { error: { http: 400, body: { error: 'IDS_INVALID', message: 'issuance_ids array (1-100 items) chahiye' } } };
  }
  let acked = 0; const notFound = []; const alreadyAcked = [];
  for (const idRaw of ids) {
    const id = String(idRaw);
    const row = prepare('SELECT id, status FROM gs_issuances WHERE id = ?').get(id);
    if (!row) { notFound.push(id); continue; }
    if (row.status === 'acked') { alreadyAcked.push(id); continue; }
    if (row.status !== 'approved') { notFound.push(id); continue; }
    prepare('UPDATE gs_issuances SET status = ?, acknowledged_at = ? WHERE id = ?').run('acked', nowMs(), id);
    audit.log({ action: 'GS_ISSUANCE_ACKED', resourceType: 'gs_issuance', resourceId: id, details: { via: 'contract-api' } });
    acked += 1;
  }
  return { data: { acked, already_acked: alreadyAcked, not_found: notFound } };
}

// ─────────────────────────────────────────────
// ADMIN: overview + cancel
// ─────────────────────────────────────────────
function adminOverview(limit = 50) {
  const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const intents = prepare(`SELECT id, provider, provider_txn_id, msisdn, amount_pkr, reference, status, signature_valid, failure_reason, created_at, processed_at
                           FROM payment_intents ORDER BY created_at DESC LIMIT ?`).all(l);
  const issuances = prepare(`SELECT id, intent_id, msisdn, gs_amount, pkr_amount, status, approved_via, acknowledged_at, created_at
                             FROM gs_issuances ORDER BY created_at DESC LIMIT ?`).all(l);
  const stats = prepare(`SELECT
      COUNT(*) AS total_intents,
      SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'verified' THEN amount_pkr ELSE 0 END) AS pkr_total
    FROM payment_intents`).get();
  const gsStats = prepare(`SELECT
      COUNT(*) AS total_issuances,
      SUM(CASE WHEN status = 'approved' THEN gs_amount ELSE 0 END) AS gs_pending_credit,
      SUM(CASE WHEN status = 'acked' THEN gs_amount ELSE 0 END) AS gs_credited
    FROM gs_issuances`).get();
  return { data: { intents, issuances, stats, gs_stats: gsStats } };
}

function cancelIssuance(id) {
  const row = prepare('SELECT id, status, msisdn, gs_amount FROM gs_issuances WHERE id = ?').get(String(id));
  if (!row) return { error: { http: 404, body: { error: 'NOT_FOUND', message: 'Issuance nahi mili' } } };
  if (row.status === 'acked') return { error: { http: 409, body: { error: 'ALREADY_ACKED', message: 'Ye issuance RabtaChat credit kar chuka — cancel nahi ho sakti, manual adjustment karo' } } };
  if (row.status === 'cancelled') return { error: { http: 409, body: { error: 'ALREADY_CANCELLED', message: 'Ye issuance pehle hi cancel ho chuki hai' } } };
  prepare('UPDATE gs_issuances SET status = ? WHERE id = ?').run('cancelled', String(id));
  audit.log({ action: 'GS_ISSUANCE_CANCELLED', resourceType: 'gs_issuance', resourceId: String(id), details: { msisdn: row.msisdn, gs_amount: row.gs_amount } });
  return { data: { id: String(id), status: 'cancelled' } };
}

module.exports = {
  GS_PKR_PEG,
  PROVIDERS,
  parseAmountToPkr,
  parseJazzcash,
  parseEasypaisa,
  verifyJazzcashSignature,
  verifyEasypaisaSignature,
  processWebhook,
  createPurchaseIntent,
  listIssuances,
  ackIssuances,
  adminOverview,
  cancelIssuance,
};
