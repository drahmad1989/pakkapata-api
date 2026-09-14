/**
 * GeoPata — Mashwara Box Controllers (v0.10.7)
 *
 * Public suggestion intake (NO LOGIN — village-level trust model) + admin review.
 *
 *   Public (rate-limited, no auth):
 *     GET  /api/public/suggest/villages?q=   — village search (autocomplete)
 *     POST /api/public/suggest               — submit mashwara (multipart, photo optional)
 *
 *   Admin (JWT admin):
 *     GET    /api/admin/suggestions          — list with filters (status/type/village/q)
 *     PATCH  /api/admin/suggestions/:id      — status + admin_note
 *     DELETE /api/admin/suggestions/:id      — remove spam
 *     GET    /api/admin/suggestions/export   — CSV (per-village offline review)
 *
 * DESIGN (agreed with user):
 *   - Suggestion kabhi bhi directly area/naming data NAHI badalta — yeh sirf
 *     review queue hai. Accepted suggestions Stage-2 (name plates) mein use honge.
 *   - Area lock: locked_at on areas — name-plate finalization ke baad names/codes
 *     immutable (updateArea/deleteArea enforcement yahin nahi, areaController mein).
 *   - Photo optional, 5MB cap, safe random filename, static-served unguessable path.
 *   - Spam defense: IP rate limit (server.js), duplicate-content guard (same
 *     village+type+body within 10 min), body min length 5.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const db = require('../config/database');
const { prepare } = db;
const { HttpError } = require('../middleware/errorHandler');
const audit = require('../services/auditService');
const { normalizePkPhone } = require('../services/otpService');

// ─────────────────────────────────────────────
// Photo upload config (pattern: verifyPhotoController)
// ─────────────────────────────────────────────

const UPLOAD_ROOT = path.resolve(process.cwd(), 'public/uploads/suggestions');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB — public users, chhoti photos

const ALLOWED_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_ROOT)) {
    fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
  }
}

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    try {
      ensureUploadDir();
      cb(null, UPLOAD_ROOT);
    } catch (err) {
      cb(new Error('Failed to create upload directory'), null);
    }
  },
  filename(_req, file, cb) {
    // Unguessable random filename — koi user data filename mein nahi
    const ext = ALLOWED_MIME[file.mimetype] || 'bin';
    cb(null, `sug_${crypto.randomBytes(12).toString('hex')}.${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter(_req, file, cb) {
    if (ALLOWED_MIME[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new HttpError(400, `Unsupported image type: ${file.mimetype}. Allowed: JPEG, PNG, WebP, HEIC.`, 'INVALID_FILE_TYPE'));
    }
  },
});

function multerErrorHandler(err, _req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new HttpError(400, 'Photo bohat bari hai. Maximum size 5MB hai. / Photo too large (max 5MB).', 'FILE_TOO_LARGE'));
    }
    return next(new HttpError(400, `Upload failed: ${err.message}`, 'UPLOAD_ERROR'));
  }
  next(err);
}

// ─────────────────────────────────────────────
// SQL
// ─────────────────────────────────────────────

const SQL_VILLAGE_BY_CODE = `
  SELECT area_code, name, name_urdu, type, is_active, locked_at
  FROM areas WHERE area_code = ?
`;

const SQL_SUGGESTION_BY_ID = `
  SELECT s.*, a.name AS village_name, a.name_urdu AS village_name_urdu
  FROM suggestions s
  JOIN areas a ON a.area_code = s.village_code
  WHERE s.id = ?
`;

const SQL_INSERT_SUGGESTION = `
  INSERT INTO suggestions
    (id, village_code, type, title, body, gps_lat, gps_lng, photo_path,
     contact_phone, status, ip_address, user_agent, created_at)
  VALUES (?,?,?,?,?,?,?,?,?, 'new', ?, ?, ?)
`;

const SQL_RECENT_DUPLICATE = `
  SELECT id FROM suggestions
  WHERE village_code = ? AND type = ? AND body = ? AND ip_address = ?
    AND created_at >= ?
  LIMIT 1
`;

function newSuggestionId() {
  return `sug_${crypto.randomBytes(8).toString('hex')}`;
}

/** Escape LIKE wildcards — user input % _ \ ko literal banao */
function escapeLike(raw) {
  return raw.replace(/[\\%_]/g, (m) => `\\${m}`);
}

// ─────────────────────────────────────────────
// PUBLIC — village search (autocomplete)
// ─────────────────────────────────────────────

/**
 * GET /api/public/suggest/villages?q=patoki
 * Privacy-safe: sirf code + names + parent chain ka hissa return hota hai.
 * 146k villages — LIKE prefix, indexed fields, LIMIT cap (zod max 20).
 */
function villageSearch(req, res) {
  const { q, limit } = req.query;
  const term = q.trim();
  if (term.length < 2) {
    throw new HttpError(400, 'Search kam az kam 2 characters ka hona chahiye', 'QUERY_TOO_SHORT');
  }

  const pattern = `${escapeLike(term)}%`;
  const anywhere = `%${escapeLike(term)}%`;

  // Prefix match pehle (name/urdu), phir anywhere-match — ordering CASE se.
  // ESCAPE '\' isliye zaroori ke escaped wildcards literal rahein.
  const rows = prepare(`
    SELECT area_code, name, name_urdu, parent_code
    FROM areas
    WHERE type = 'village' AND is_active = 1
      AND (
        name     LIKE ? ESCAPE '\\'
        OR name_urdu LIKE ? ESCAPE '\\'
        OR name     LIKE ? ESCAPE '\\'
        OR name_urdu LIKE ? ESCAPE '\\'
      )
    ORDER BY
      CASE
        WHEN name     LIKE ? ESCAPE '\\' THEN 0
        WHEN name_urdu LIKE ? ESCAPE '\\' THEN 1
        ELSE 2
      END,
      name
    LIMIT ?
  `).all(pattern, pattern, anywhere, anywhere, pattern, pattern, limit);

  // Parent chain resolve — type-aware walk (tehsil ho ya district, label sahi).
  // Legacy villages seedha district ke neeche bhi hain (pre-tehsil era), isliye
  // parent ko andha "tehsil" nahi maan sakte — type dekh kar label karo.
  const parentCodes = [...new Set(rows.map((r) => r.parent_code).filter(Boolean))];
  const parentRows = {};
  for (const pc of parentCodes) {
    const p = prepare(`SELECT area_code, name, type, parent_code FROM areas WHERE area_code = ?`).get(pc);
    if (p) parentRows[p.area_code] = p;
  }

  const results = rows.map((r) => {
    let tehsil = null;
    let district = null;
    let cur = r.parent_code;
    let hops = 0;
    while (cur && hops < 5) {
      const a = parentRows[cur] || prepare(`SELECT area_code, name, type, parent_code FROM areas WHERE area_code = ?`).get(cur);
      if (!a) break;
      parentRows[a.area_code] = a;
      if (!tehsil && a.type === 'tehsil') tehsil = a.name;
      if (!district && a.type === 'district') district = a.name;
      if (tehsil && district) break;
      cur = a.parent_code;
      hops++;
    }
    return {
      village_code: r.area_code,
      name: r.name,
      name_urdu: r.name_urdu || null,
      tehsil,
      district,
    };
  });

  return res.json({ count: results.length, data: results });
}

// ─────────────────────────────────────────────
// PUBLIC — create suggestion (multipart)
// ─────────────────────────────────────────────

/**
 * POST /api/public/suggest  (multipart/form-data)
 * Fields: village_code*, type*, body*, title?, gps_lat?, gps_lng?, contact_phone?
 * File:   photo? (jpg/png/webp/heic, max 5MB)
 */
function createSuggestion(req, res) {
  const b = req.body;

  // Village must exist + active (locked chalne nahi deta — mashwara to aati
  // rahegi, lekin locked village par 'naam' type reject karenge Stage-3 mein;
  // filhal allow karo — admin review mein phasega)
  const village = prepare(SQL_VILLAGE_BY_CODE).get(b.village_code);
  if (!village || village.type !== 'village' || !village.is_active) {
    throw new HttpError(400, `Village ${b.village_code} registry mein active nahi hai`, 'VILLAGE_NOT_FOUND');
  }

  // Phone optional — diya to canonical +92 hona chahiye
  let phone = null;
  if (b.contact_phone && b.contact_phone.trim()) {
    phone = normalizePkPhone(b.contact_phone.trim());
    if (!phone) {
      throw new HttpError(400, 'Phone format: 03XX-XXXXXXX ya +92XXXXXXXXXX', 'PHONE_INVALID');
    }
  }

  const ip = req.auth?.ipAddress || req.ip || null;
  const ua = req.headers['user-agent'] || null;
  const now = Date.now();

  // Duplicate-content spam guard — same IP, same content, 10 min window
  const dup = prepare(SQL_RECENT_DUPLICATE).get(
    b.village_code, b.type, b.body, ip, now - 10 * 60 * 1000
  );
  if (dup) {
    throw new HttpError(429, 'Yehi mashwara abhi submit ho chuki hai. Thori dair baad koshish karein.', 'DUPLICATE_SUGGESTION');
  }

  const id = newSuggestionId();
  const photoPath = req.file
    ? `/uploads/suggestions/${req.file.filename}`
    : null;

  prepare(SQL_INSERT_SUGGESTION).run(
    id,
    b.village_code,
    b.type,
    b.title ? b.title.trim().slice(0, 120) : null,
    b.body.trim(),
    b.gps_lat ?? null,
    b.gps_lng ?? null,
    photoPath,
    phone,
    ip,
    ua ? String(ua).slice(0, 250) : null,
    now
  );

  audit.log({
    adminId: null, // public submit — koi admin nahi
    action: 'SUGGESTION_CREATE',
    resourceType: 'suggestion',
    resourceId: id,
    ipAddress: ip,
    userAgent: ua ? String(ua).slice(0, 250) : null,
    details: { village_code: b.village_code, type: b.type, has_photo: !!req.file, gps: !!(b.gps_lat && b.gps_lng), phone: !!phone },
  });

  return res.status(201).json({
    message: 'Mashwara mil gayi — shukriya! Team review karegi.',
    data: {
      id,
      village_code: b.village_code,
      village_name: village.name,
      type: b.type,
      status: 'new',
      photo_path: photoPath,
      created_at: now,
    },
  });
}

// ─────────────────────────────────────────────
// ADMIN — list / update / delete / export
// ─────────────────────────────────────────────

/**
 * GET /api/admin/suggestions?status=&type=&village_code=&q=&limit=&offset=
 */
function listSuggestions(req, res) {
  const { status, type, village_code, q, limit, offset } = req.query;

  const where = [];
  const params = [];
  if (status) { where.push('s.status = ?'); params.push(status); }
  if (type) { where.push('s.type = ?'); params.push(type); }
  if (village_code) { where.push('s.village_code = ?'); params.push(village_code); }
  if (q) {
    const pattern = `%${escapeLike(q.trim())}%`;
    where.push(`(s.body LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\' OR s.id LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\')`);
    params.push(pattern, pattern, pattern, pattern);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const base = `
    FROM suggestions s
    JOIN areas a ON a.area_code = s.village_code
    ${whereClause}
  `;

  const total = prepare(`SELECT COUNT(*) AS c ${base}`).get(...params).c;
  const rows = prepare(`
    SELECT s.id, s.village_code, a.name AS village_name, a.name_urdu AS village_name_urdu,
           s.type, s.title, s.body, s.gps_lat, s.gps_lng, s.photo_path,
           s.contact_phone, s.status, s.admin_note, s.reviewed_by, s.reviewed_at,
           s.created_at
    ${base}
    ORDER BY s.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return res.json({ count: rows.length, total, data: rows });
}

/**
 * PATCH /api/admin/suggestions/:id  { status?, admin_note? }
 */
function updateSuggestion(req, res) {
  const { id } = req.params;
  const { status, admin_note } = req.body;

  const existing = prepare(SQL_SUGGESTION_BY_ID).get(id);
  if (!existing) {
    throw new HttpError(404, `Suggestion ${id} not found`, 'SUGGESTION_NOT_FOUND');
  }

  const newStatus = status || existing.status;
  const newNote = admin_note !== undefined ? admin_note : existing.admin_note;
  const now = Date.now();
  const reviewing = (status && status !== existing.status) || (admin_note !== undefined);

  prepare(`
    UPDATE suggestions
    SET status = ?, admin_note = ?,
        reviewed_by = ?, reviewed_at = ?
    WHERE id = ?
  `).run(
    newStatus,
    newNote,
    reviewing ? req.auth.adminId : existing.reviewed_by,
    reviewing ? now : existing.reviewed_at,
    id
  );

  const updated = prepare(SQL_SUGGESTION_BY_ID).get(id);

  audit.log({
    adminId: req.auth.adminId,
    action: 'SUGGESTION_UPDATE',
    resourceType: 'suggestion',
    resourceId: id,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { before: { status: existing.status, admin_note: existing.admin_note }, after: { status: newStatus, admin_note: newNote } },
  });

  return res.json({ message: 'Suggestion updated', data: updated });
}

/**
 * DELETE /api/admin/suggestions/:id — spam removal (hard delete)
 */
function deleteSuggestion(req, res) {
  const { id } = req.params;

  const existing = prepare(SQL_SUGGESTION_BY_ID).get(id);
  if (!existing) {
    throw new HttpError(404, `Suggestion ${id} not found`, 'SUGGESTION_NOT_FOUND');
  }

  // Photo bhi delete karo (disk cleanup)
  if (existing.photo_path) {
    const abs = path.resolve(process.cwd(), 'public', existing.photo_path.replace(/^\//, ''));
    if (abs.startsWith(path.resolve(process.cwd(), 'public/uploads/suggestions')) && fs.existsSync(abs)) {
      try { fs.unlinkSync(abs); } catch { /* non-fatal */ }
    }
  }

  prepare(`DELETE FROM suggestions WHERE id = ?`).run(id);

  audit.log({
    adminId: req.auth.adminId,
    action: 'SUGGESTION_DELETE',
    resourceType: 'suggestion',
    resourceId: id,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { village_code: existing.village_code, type: existing.type, status: existing.status },
  });

  return res.json({ message: `Suggestion ${id} deleted` });
}

/**
 * GET /api/admin/suggestions/export?village_code=&status=&type=&q=
 * CSV — per-village offline review (locals ke sath baith kar check karne ke liye).
 * UTF-8 BOM taake Excel mein Urdu sahi dikhe.
 */
function exportSuggestions(req, res) {
  const { status, type, village_code, q } = req.query;

  const where = [];
  const params = [];
  if (status && ['new', 'reviewed', 'accepted', 'rejected'].includes(String(status))) {
    where.push('s.status = ?'); params.push(String(status));
  }
  if (type && ['ghar', 'gali', 'entry', 'naam', 'sarhad', 'deegar'].includes(String(type))) {
    where.push('s.type = ?'); params.push(String(type));
  }
  if (village_code) { where.push('s.village_code = ?'); params.push(String(village_code)); }
  if (q) {
    const pattern = `%${escapeLike(String(q).trim())}%`;
    where.push(`(s.body LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\')`);
    params.push(pattern, pattern, pattern);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = prepare(`
    SELECT s.id, s.village_code, a.name AS village_name, a.name_urdu AS village_name_urdu,
           s.type, s.title, s.body, s.gps_lat, s.gps_lng, s.photo_path,
           s.contact_phone, s.status, s.admin_note, s.created_at
    FROM suggestions s
    JOIN areas a ON a.area_code = s.village_code
    ${whereClause}
    ORDER BY s.village_code, s.created_at DESC
    LIMIT 5000
  `).all(...params);

  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = 'id,village_code,village_name,village_name_urdu,type,status,title,body,gps_lat,gps_lng,photo_url,contact_phone,admin_note,created_at';
  const lines = [header];
  for (const r of rows) {
    // NOTE: ek hi baar esc() — .map(esc) baad mein double-escape karta tha
    lines.push([
      r.id,
      r.village_code,
      esc(r.village_name),
      esc(r.village_name_urdu),
      r.type,
      r.status,
      esc(r.title),
      esc(r.body),
      r.gps_lat ?? '',
      r.gps_lng ?? '',
      r.photo_path || '',
      r.contact_phone || '',
      esc(r.admin_note),
      new Date(r.created_at).toISOString(),
    ].join(','));
  }

  audit.log({
    adminId: req.auth.adminId,
    action: 'SUGGESTION_EXPORT',
    resourceType: 'suggestion',
    resourceId: village_code || 'all',
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { count: rows.length, filters: { status, type, village_code, q } },
  });

  const suffix = village_code ? String(village_code).replace(/[^A-Za-z0-9-]/g, '') : 'all';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="mashwara-${suffix}-${new Date().toISOString().slice(0, 10)}.csv"`);
  return res.send('\uFEFF' + lines.join('\r\n'));
}

// ─────────────────────────────────────────────
// ADMIN — stats card (dashboard count)
// ─────────────────────────────────────────────

/**
 * GET /api/admin/suggestions/stats — status counts (admin dashboard card)
 */
function suggestionStats(req, res) {
  const rows = prepare(`
    SELECT status, COUNT(*) AS c FROM suggestions GROUP BY status
  `).all();
  const stats = { new: 0, reviewed: 0, accepted: 0, rejected: 0, total: 0 };
  for (const r of rows) {
    stats[r.status] = r.c;
    stats.total += r.c;
  }
  return res.json({ data: stats });
}

module.exports = {
  upload,
  multerErrorHandler,
  villageSearch,
  createSuggestion,
  listSuggestions,
  updateSuggestion,
  deleteSuggestion,
  exportSuggestions,
  suggestionStats,
};
