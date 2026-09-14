/**
 * GeoPata — Admin Controller
 *
 * CRUD operations for admins + API keys, plus audit log viewer.
 * All routes mounted at /api/admin and require JWT + admin role.
 */

const db = require('../config/database');
const { prepare } = db;
const { HttpError } = require('../middleware/errorHandler');
const audit = require('../services/auditService');
const { hashPassword, generateApiKey } = require('../services/authService');
const { normalizePkPhone } = require('../services/otpService');
const integrationService = require('../services/integrationService');
const crypto = require('crypto');

// ─────────────────────────────────────────────
// SQL templates (lazy-prepared via prepare())
// ─────────────────────────────────────────────
const SQL_LIST_ADMINS = `
  SELECT admin_id, username, full_name, phone, role, is_active, last_login_at, created_at
  FROM admins ORDER BY created_at ASC
`;
const SQL_GET_ADMIN_BY_ID = `
  SELECT admin_id, username, full_name, phone, role, is_active, last_login_at, created_at
  FROM admins WHERE admin_id = ?
`;
const SQL_GET_ADMIN_BY_USERNAME = 'SELECT 1 FROM admins WHERE username = ?';
const SQL_GET_ADMIN_BY_PHONE_EXCL = 'SELECT admin_id FROM admins WHERE phone = ? AND admin_id != ?';
const SQL_INSERT_ADMIN = `
  INSERT INTO admins (username, password_hash, full_name, role, is_active, phone)
  VALUES (?, ?, ?, ?, 1, ?)
`;
const SQL_UPDATE_ADMIN = `
  UPDATE admins SET full_name = COALESCE(?, full_name),
                   role      = COALESCE(?, role),
                   is_active = COALESCE(?, is_active),
                   updated_at = CURRENT_TIMESTAMP
  WHERE admin_id = ?
`;
const SQL_DELETE_ADMIN = 'DELETE FROM admins WHERE admin_id = ?';
const SQL_RESET_PASSWORD = 'UPDATE admins SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE admin_id = ?';

const SQL_LIST_API_KEYS = `
  SELECT key_id, name, scopes, is_active, created_by, created_at, last_used_at, expires_at
  FROM api_keys ORDER BY created_at DESC
`;
const SQL_GET_API_KEY = `
  SELECT key_id, name, scopes, is_active, created_by, created_at, last_used_at, expires_at
  FROM api_keys WHERE key_id = ?
`;
const SQL_INSERT_API_KEY = `
  INSERT INTO api_keys (key_id, name, key_hash, scopes, is_active, created_by, expires_at)
  VALUES (?, ?, ?, ?, 1, ?, ?)
`;
const SQL_TOGGLE_API_KEY = 'UPDATE api_keys SET is_active = ? WHERE key_id = ?';
const SQL_DELETE_API_KEY = 'DELETE FROM api_keys WHERE key_id = ?';

// ─────────────────────────────────────────────
// ADMINS
// ─────────────────────────────────────────────

// GET /api/admin/admins
function listAdmins(_req, res) {
  const rows = prepare(SQL_LIST_ADMINS).all();
  return res.json({ count: rows.length, data: rows });
}

// POST /api/admin/admins
// Body: { username, password?, phone?, full_name?, role }
// Password+phone dono optional — kam az kam ek zaroori (schema enforce karta hai).
// Sirf phone wala staff = OTP-only login (unka password hash random unusable hota hai).
function createAdmin(req, res) {
  const { username, password, full_name, role } = req.body;

  if (prepare(SQL_GET_ADMIN_BY_USERNAME).get(username)) {
    throw new HttpError(409, `Username '${username}' already exists`, 'DUPLICATE_USERNAME');
  }

  // Phone: normalize → +92 canonical (v0.10.0)
  let phone = null;
  if (req.body.phone) {
    phone = normalizePkPhone(req.body.phone);
    if (!phone) {
      throw new HttpError(400, 'Phone format ghalat. Example: 03001234567', 'PHONE_INVALID');
    }
    if (prepare(SQL_GET_ADMIN_BY_PHONE_EXCL).get(phone, 0)) {
      throw new HttpError(409, 'Ye phone number pehle se kisi aur staff ke paas hai', 'PHONE_IN_USE');
    }
  }

  // OTP-only staff: unusable random password hash — password login kabhi match nahi hoga
  const passwordHash = password
    ? hashPassword(password)
    : hashPassword(crypto.randomBytes(32).toString('hex'));

  const result = prepare(SQL_INSERT_ADMIN).run(username, passwordHash, full_name || null, role || 'viewer', phone);
  const newAdmin = prepare(SQL_GET_ADMIN_BY_ID).get(result.lastInsertRowid);

  audit.log({
    adminId: req.auth.adminId,
    action: 'CREATE_ADMIN',
    resourceType: 'admin',
    resourceId: newAdmin.admin_id,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { username, role, full_name, phone_masked: phone ? phone.slice(0, 6) + '***' : null, otp_only: !password },
  });

  return res.status(201).json({
    message: password ? 'Admin created' : 'Staff created — OTP-only login (phone se code mangega)',
    data: newAdmin,
  });
}

// PUT /api/admin/admins/:id
// Body: { full_name?, role?, is_active?, phone? }
// phone: ''/null = phone hatao (OTP login band); 03XX… = normalize karke set
function updateAdmin(req, res) {
  const { id } = req.params;
  const { full_name, role, is_active } = req.body;

  const existing = prepare(SQL_GET_ADMIN_BY_ID).get(id);
  if (!existing) {
    throw new HttpError(404, `Admin ${id} not found`, 'ADMIN_NOT_FOUND');
  }

  // Prevent self-demotion / self-deactivation (common foot-gun)
  if (req.auth.adminId === Number(id)) {
    if (role && role !== 'admin') {
      throw new HttpError(400, 'You cannot demote yourself', 'SELF_DEMOTION_FORBIDDEN');
    }
    if (is_active === 0) {
      throw new HttpError(400, 'You cannot deactivate yourself', 'SELF_DEACTIVATION_FORBIDDEN');
    }
  }

  prepare(SQL_UPDATE_ADMIN).run(full_name || null, role || null, is_active ?? null, id);

  // v0.10.0: phone alag se handle hota hai ('' ya null → clear)
  let phoneChanged = null;
  if (req.body.phone !== undefined) {
    const raw = req.body.phone;
    if (raw === '' || raw === null) {
      prepare('UPDATE admins SET phone = NULL, updated_at = CURRENT_TIMESTAMP WHERE admin_id = ?').run(id);
      phoneChanged = null;
    } else {
      const norm = normalizePkPhone(raw);
      if (!norm) {
        throw new HttpError(400, 'Phone format ghalat. Example: 03001234567', 'PHONE_INVALID');
      }
      if (prepare(SQL_GET_ADMIN_BY_PHONE_EXCL).get(norm, Number(id))) {
        throw new HttpError(409, 'Ye phone number pehle se kisi aur staff ke paas hai', 'PHONE_IN_USE');
      }
      prepare('UPDATE admins SET phone = ?, updated_at = CURRENT_TIMESTAMP WHERE admin_id = ?').run(norm, id);
      phoneChanged = norm;
    }
  }

  const updated = prepare(SQL_GET_ADMIN_BY_ID).get(id);

  audit.log({
    adminId: req.auth.adminId,
    action: 'UPDATE_ADMIN',
    resourceType: 'admin',
    resourceId: id,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { before: existing, after: updated, phone_set: phoneChanged === null ? (existing.phone ? 'cleared' : null) : 'set' },
  });

  return res.json({ message: 'Admin updated', data: updated });
}

// DELETE /api/admin/admins/:id
function deleteAdmin(req, res) {
  const { id } = req.params;

  if (req.auth.adminId === Number(id)) {
    throw new HttpError(400, 'You cannot delete yourself', 'SELF_DELETE_FORBIDDEN');
  }

  const existing = prepare(SQL_GET_ADMIN_BY_ID).get(id);
  if (!existing) {
    throw new HttpError(404, `Admin ${id} not found`, 'ADMIN_NOT_FOUND');
  }

  prepare(SQL_DELETE_ADMIN).run(id);

  audit.log({
    adminId: req.auth.adminId,
    action: 'DELETE_ADMIN',
    resourceType: 'admin',
    resourceId: id,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { deleted: existing },
  });

  return res.json({ message: `Admin ${existing.username} deleted` });
}

// POST /api/admin/admins/:id/reset-password
// Body: { new_password }
function resetPassword(req, res) {
  const { id } = req.params;
  const { new_password } = req.body;

  const existing = prepare(SQL_GET_ADMIN_BY_ID).get(id);
  if (!existing) {
    throw new HttpError(404, `Admin ${id} not found`, 'ADMIN_NOT_FOUND');
  }

  const newHash = hashPassword(new_password);
  prepare(SQL_RESET_PASSWORD).run(newHash, id);

  audit.log({
    adminId: req.auth.adminId,
    action: 'RESET_ADMIN_PASSWORD',
    resourceType: 'admin',
    resourceId: id,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { target: existing.username },
  });

  return res.json({ message: `Password reset for ${existing.username}` });
}

// ─────────────────────────────────────────────
// API KEYS
// ─────────────────────────────────────────────

// GET /api/admin/api-keys
function listApiKeys(_req, res) {
  const rows = prepare(SQL_LIST_API_KEYS).all();
  return res.json({ count: rows.length, data: rows });
}

// POST /api/admin/api-keys
// Body: { name, scopes, env?, expires_at? }
// Returns the FULL KEY once — client must save it; it is never stored.
function createApiKey(req, res) {
  const { name, scopes, env, expires_at } = req.body;
  const scopeStr = (scopes || ['read']).join(',');

  const { keyId, fullKey, keyHash } = generateApiKey(env || 'live');

  prepare(SQL_INSERT_API_KEY).run(
    keyId,
    name,
    keyHash,
    scopeStr,
    req.auth.adminId,
    expires_at || null
  );

  audit.log({
    adminId: req.auth.adminId,
    action: 'CREATE_API_KEY',
    resourceType: 'api_key',
    resourceId: keyId,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { name, scopes: scopeStr, env: env || 'live' },
  });

  return res.status(201).json({
    message: 'API key created. Save the full key now — it will NOT be shown again.',
    data: {
      key_id: keyId,
      name,
      scopes: scopeStr,
      full_key: fullKey,        // ⚠️ shown ONCE only
      expires_at: expires_at || null,
      created_at: new Date().toISOString(),
    },
  });
}

// PATCH /api/admin/api-keys/:keyId
// Body: { is_active }
function toggleApiKey(req, res) {
  const { keyId } = req.params;
  const { is_active } = req.body;

  const existing = prepare(SQL_GET_API_KEY).get(keyId);
  if (!existing) {
    throw new HttpError(404, `API key ${keyId} not found`, 'API_KEY_NOT_FOUND');
  }

  prepare(SQL_TOGGLE_API_KEY).run(is_active ? 1 : 0, keyId);
  const updated = prepare(SQL_GET_API_KEY).get(keyId);

  audit.log({
    adminId: req.auth.adminId,
    action: is_active ? 'ACTIVATE_API_KEY' : 'REVOKE_API_KEY',
    resourceType: 'api_key',
    resourceId: keyId,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { name: existing.name },
  });

  return res.json({
    message: `API key ${is_active ? 'activated' : 'revoked'}`,
    data: updated,
  });
}

// DELETE /api/admin/api-keys/:keyId
function deleteApiKey(req, res) {
  const { keyId } = req.params;
  const existing = prepare(SQL_GET_API_KEY).get(keyId);
  if (!existing) {
    throw new HttpError(404, `API key ${keyId} not found`, 'API_KEY_NOT_FOUND');
  }

  prepare(SQL_DELETE_API_KEY).run(keyId);

  audit.log({
    adminId: req.auth.adminId,
    action: 'DELETE_API_KEY',
    resourceType: 'api_key',
    resourceId: keyId,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { deleted: existing },
  });

  return res.json({ message: `API key ${existing.name} deleted` });
}

// ─────────────────────────────────────────────
// v0.10.1: RABTACHAT ONE-CLICK SETUP
// ─────────────────────────────────────────────
// RabtaChat ka settlement integration sirf is liye inactive rehta hai ke
// uske .env mein PAKKAPATA_API_KEY nahi hai. Ye endpoint admin panel ka
// "1-Click Setup" button isi ko automate karta hai:
//   1) Purane 'RabtaChat Production' keys revoke (rotate-on-click)
//   2) Naya read+write live key banao
//   3) Ready-to-paste .env block return karo (PAKKAPATA_API_URL + PAKKAPATA_API_KEY)
// Dashboard is block ko copy-button + downloadable .bat ke sath dikhata hai.
const RABTACHAT_KEY_NAME = 'RabtaChat Production';
const RABTACHAT_ENV_URL = process.env.RABTACHAT_PAKKAPATA_URL || 'http://localhost:3001';

// POST /api/admin/api-keys/rabtachat-setup  (JWT admin)
function rabtachatSetup(req, res) {
  // 1) Purane active keys isi naam se → revoke (key rotation, koi orphan nahi)
  const oldActive = prepare(
    'SELECT key_id, name FROM api_keys WHERE name = ? AND is_active = 1'
  ).all(RABTACHAT_KEY_NAME);
  for (const row of oldActive) {
    prepare(SQL_TOGGLE_API_KEY).run(0, row.key_id);
    audit.log({
      adminId: req.auth.adminId,
      action: 'REVOKE_API_KEY',
      resourceType: 'api_key',
      resourceId: row.key_id,
      ipAddress: req.auth.ipAddress,
      userAgent: req.auth.userAgent,
      details: { name: row.name, reason: 'rabtachat-setup auto-rotate' },
    });
  }

  // 2) Naya key — read+write (settlement ko address create + lookup dono chahiye)
  const { keyId, fullKey, keyHash } = generateApiKey('live');
  prepare(SQL_INSERT_API_KEY).run(
    keyId,
    RABTACHAT_KEY_NAME,
    keyHash,
    'read,write',
    req.auth.adminId,
    null
  );

  audit.log({
    adminId: req.auth.adminId,
    action: 'CREATE_API_KEY',
    resourceType: 'api_key',
    resourceId: keyId,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { name: RABTACHAT_KEY_NAME, scopes: 'read,write', env: 'live', flow: 'one-click-setup' },
  });

  // 3) Ready-to-paste .env block — RabtaChat route.ts inhi 2 var names ko parhta hai
  const envBlock = [
    '# PakkaPata integration — RabtaChat .env mein paste karo',
    `PAKKAPATA_API_URL=${RABTACHAT_ENV_URL}`,
    `PAKKAPATA_API_KEY=${fullKey}`,
  ].join('\n');

  // 4) v0.10.2: TRUE one-click — backend khud RabtaChat ke .env mein likhne ki koshish kare.
  //    Fail ho (folder nahi mila / permission) to env_block + .bat fallback waise hi mojood rahega.
  let envWrite = { written: false, env_path: null, env_write_error: null };
  try {
    const detected = integrationService.detectRabtaChatDir();
    if (!detected) {
      envWrite.env_write_error = 'RabtaChat folder nahi mila (RABTACHAT_DIR / G:\\projects\\sikkachat-v6 / D:\\RabtaChat / C:\\RabtaChat / sibling)';
    } else if (!detected.confirmed) {
      envWrite.env_write_error = `${detected.dir} RabtaChat jaisa confirm nahi hua — manual paste ya RABTACHAT_DIR set karo`;
    } else {
      envWrite = integrationService.writeRabtaChatEnv(detected.dir, fullKey, RABTACHAT_ENV_URL);
      envWrite.env_write_error = null;
    }
  } catch (err) {
    envWrite = { written: false, env_path: null, env_write_error: err.message };
  }

  return res.status(201).json({
    message: envWrite.written
      ? `Key ban gayi aur ${envWrite.env_path} mein likh di gayi (backup: .env.pakkapata-backup). Ab bas RabtaChat RESTART karo.`
      : oldActive.length
        ? `Naya key ban gaya (${oldActive.length} purana auto-revoke). RabtaChat .env mein set karo, phir RabtaChat restart karo.`
        : 'Key ban gayi. RabtaChat .env mein set karo, phir RabtaChat restart karo.',
    data: {
      key_id: keyId,
      name: RABTACHAT_KEY_NAME,
      scopes: 'read,write',
      full_key: fullKey,   // ⚠️ sirf ABHI dikhega
      env_block: envBlock,
      revoked_old: oldActive.length,
      // v0.10.2: auto-write result
      env_written: envWrite.written,
      env_path: envWrite.env_path || null,
      env_write_error: envWrite.env_write_error || null,
    },
  });
}

// GET /api/admin/api-keys/rabtachat-setup/status  (JWT admin, v0.10.2)
// Diagnosis-only: koi secret nahi (masked preview bhi nahi), koi write nahi.
function rabtachatStatus(req, res) {
  const status = integrationService.getRabtaChatStatus();
  // v0.10.5: checklist step-1 ke liye backend version bhi bhejo
  try { status.backend_version = require('../../package.json').version; } catch { /* ignore */ }
  return res.json(status);
}

// GET /api/admin/api-keys/rabtachat-setup/ping  (JWT admin, v0.10.5)
// PakkaPata backend khud RabtaChat ke /api/health ko ping karta hai —
// "RabtaChat chal raha hai ya nahi" ka LIVE jawab checklist step-4 ke liye.
async function rabtachatPing(req, res) {
  const result = await integrationService.pingRabtaChat();
  return res.json(result);
}

// ─────────────────────────────────────────────
// AUDIT LOG
// ─────────────────────────────────────────────

// GET /api/admin/audit?admin_id=&action=&resource_type=&resource_id=&limit=&offset=
function listAudit(req, res) {
  const { rows, total } = audit.query({
    adminId: req.query.admin_id ? Number(req.query.admin_id) : undefined,
    action: req.query.action,
    resourceType: req.query.resource_type,
    resourceId: req.query.resource_id,
    limit: req.query.limit ? Number(req.query.limit) : 50,
    offset: req.query.offset ? Number(req.query.offset) : 0,
  });
  return res.json({ count: rows.length, total, data: rows });
}

module.exports = {
  // Admins
  listAdmins,
  createAdmin,
  updateAdmin,
  deleteAdmin,
  resetPassword,
  // API Keys
  listApiKeys,
  createApiKey,
  rabtachatSetup,
  rabtachatStatus,
  rabtachatPing,
  toggleApiKey,
  deleteApiKey,
  // Audit
  listAudit,
};
