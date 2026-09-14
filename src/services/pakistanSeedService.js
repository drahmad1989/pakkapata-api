/**
 * GeoPata — Pakistan Seed Service (v0.9.0)
 *
 * Core engine that seeds the ENTIRE Pakistan map (provinces, districts,
 * ~149k villages/places, approximate boundaries) from the GeoNames TSV
 * data files in src/data/. Extracted from scripts/seed-pakistan.js so BOTH
 * the CLI and the dashboard UI share one implementation.
 *
 * Job model (server process):
 *   - ONE global seed job at a time (single-process server).
 *   - startSeedJob() validates options, returns a snapshot immediately,
 *     and runs the seed in the background (async, yields between phases
 *     and between district transactions so HTTP stays responsive).
 *   - getJobStatus() returns live progress (polled by the dashboard).
 *   - requestCancel() cooperatively cancels between district batches.
 *
 * IDEMPOTENT: same code exists → skip; same name within 1.5 km → skip.
 * Existing manual boundaries and existing codes are NEVER touched.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const db = require('../config/database');
const { generateLocalityCode } = require('./idGenerator');
const { HttpError } = require('../middleware/errorHandler');

const ROOT = path.join(__dirname, '..', '..'); // pakkapata-backend/ (this file lives in src/services/)
const DATA_DIR = path.join(ROOT, 'src', 'data');

// ─── Constants (from seed-pakistan.js v1.0.0) ────────────────────────────────
const PROVINCES = {
  '02': { code: 'PK-BA', name: 'Balochistan', name_urdu: 'بلوچستان', type: 'province', lat: 28.4907, lng: 65.0160, population: 14894032 },
  '03': { code: 'PK-KP', name: 'Khyber Pakhtunkhwa', name_urdu: 'خیبر پختونخوا', type: 'province', lat: 34.3211, lng: 72.3459, population: 40856067 },
  '04': { code: 'PK-PB', name: 'Punjab', name_urdu: 'پنجاب', type: 'province', lat: 31.1704, lng: 72.7097, population: 127688922 },
  '05': { code: 'PK-SD', name: 'Sindh', name_urdu: 'سندھ', type: 'province', lat: 25.3962, lng: 68.3578, population: 55696147 },
  '06': { code: 'PK-AJ', name: 'Azad Jammu and Kashmir', name_urdu: 'آزاد جموں و کشمیر', type: 'territory', lat: 33.9259, lng: 73.7810, population: 4045366 },
  '07': { code: 'PK-GB', name: 'Gilgit-Baltistan', name_urdu: 'گلگت بلتستان', type: 'territory', lat: 35.5087, lng: 74.0300, population: 1492374 },
  '08': { code: 'PK-IS', name: 'Islamabad Capital Territory', name_urdu: 'اسلام آباد', type: 'territory', lat: 33.7206, lng: 73.0606, population: 2363363 },
};

// Punjab's 41 districts (2023) — existing codes MUST be preserved.
const PUNJAB_DISTRICTS = {
  'lahore': 'PK-PB-LHR', 'kasur': 'PK-PB-KAS', 'nankana sahib': 'PK-PB-NNK', 'sheikhupura': 'PK-PB-SHK',
  'bahawalpur': 'PK-PB-BWP', 'bahawalnagar': 'PK-PB-BHG', 'rahim yar khan': 'PK-PB-RYK',
  'dera ghazi khan': 'PK-PB-DGK', 'layyah': 'PK-PB-LAY', 'muzaffargarh': 'PK-PB-MZG',
  'rajanpur': 'PK-PB-RJP', 'taunsa': 'PK-PB-TNS', 'kot addu': 'PK-PB-KTU',
  'faisalabad': 'PK-PB-FSD', 'chiniot': 'PK-PB-CNI', 'jhang': 'PK-PB-JHG', 'toba tek singh': 'PK-PB-TTS',
  'gujranwala': 'PK-PB-GUJ', 'hafizabad': 'PK-PB-HFD', 'narowal': 'PK-PB-NWL', 'sialkot': 'PK-PB-SKT',
  'wazirabad': 'PK-PB-WZB', 'gujrat': 'PK-PB-GRT', 'mandi bahauddin': 'PK-PB-MBD',
  'multan': 'PK-PB-MUL', 'khanewal': 'PK-PB-KWL', 'lodhran': 'PK-PB-LDN', 'vehari': 'PK-PB-VHR',
  'attock': 'PK-PB-ATK', 'chakwal': 'PK-PB-CKL', 'jhelum': 'PK-PB-JHL', 'murree': 'PK-PB-MRE',
  'rawalpindi': 'PK-PB-RWP', 'talagang': 'PK-PB-TLG', 'okara': 'PK-PB-OKR', 'pakpattan': 'PK-PB-PKP',
  'sahiwal': 'PK-PB-SWL', 'bhakkar': 'PK-PB-BHK', 'khushab': 'PK-PB-KHB', 'mianwali': 'PK-PB-MWL',
  'sargodha': 'PK-PB-SGD',
};

const DISTRICT_ALIASES = {
  'shekhupura': 'sheikhupura',
  'rahimyar khan': 'rahim yar khan',
};

const CAPITAL_FCODES = new Set(['PPLC', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLG']);
const CAP_NAME_DIST = 1500; // meters — same name within this distance = already seeded

function boundaryRadius(pop) {
  if (pop >= 100000) return 4000;
  if (pop >= 25000) return 3000;
  if (pop >= 5000) return 2000;
  return 1200;
}

// ─── Small helpers ───────────────────────────────────────────────────────────
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\bdistrict\b/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function circlePolygon(lat, lng, radiusMeters, segments = 24) {
  const coords = [];
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * 2 * Math.PI;
    const dLat = (radiusMeters * Math.cos(theta)) / 111320;
    const dLng = (radiusMeters * Math.sin(theta)) / (111320 * Math.max(Math.cos((lat * Math.PI) / 180), 1e-6));
    coords.push([parseFloat((lat + dLat).toFixed(6)), parseFloat((lng + dLng).toFixed(6))]);
  }
  coords.push(coords[0]);
  return { type: 'Polygon', coordinates: [coords] };
}

const yieldToEventLoop = () => new Promise((r) => setImmediate(r));

function countTsvRows(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return null;
  const content = fs.readFileSync(p, 'utf8');
  let n = 0;
  for (const line of content.split('\n')) if (line.trim()) n++;
  return n;
}

// ─── Job state (module-level, single-process) ────────────────────────────────
let jobSeq = 0;
const job = {
  job_id: null,
  status: 'idle', // idle | queued | running | done | failed | cancelled
  dry_run: false,
  options: {},
  admin_id: null,
  started_at: null,
  finished_at: null,
  duration_ms: null,
  phase: null, // loading | provinces | districts | villages | boundaries | done
  message: '',
  total: 0,
  processed: 0,
  current_district: null,
  districts_done: 0,
  districts_total: 0,
  inserted: { provinces: 0, districts: 0, villages: 0, boundaries: 0 },
  skipped_villages: 0,
  error: null,
};
let cancelRequested = false;

class SeedCancelled extends Error {
  constructor() { super('Seed cancelled by admin'); this.name = 'SeedCancelled'; }
}

function jobSnapshot() {
  return { ...job, inserted: { ...job.inserted } };
}

function patch(p) {
  Object.assign(job, p);
}

// ─── Validation ──────────────────────────────────────────────────────────────
function validateOptions(opts = {}) {
  const out = {};
  out.dry_run = !!opts.dry_run;
  if (opts.province != null && opts.province !== '') {
    if (!PROVINCES[opts.province]) {
      throw new HttpError(400, `Invalid province code "${opts.province}". Valid: ${Object.keys(PROVINCES).join(', ')}`, 'VALIDATION_ERROR');
    }
    out.province = opts.province;
  } else {
    out.province = null;
  }
  const limit = parseInt(opts.limit, 10);
  out.limit = Number.isFinite(limit) && limit > 0 ? limit : 0;
  const bmin = parseInt(opts.boundary_min_pop, 10);
  out.boundary_min_pop = Number.isFinite(bmin) && bmin >= 0 ? bmin : 1000;
  return out;
}

function ensureDataFiles() {
  const places = path.join(DATA_DIR, 'pakistan-places.tsv');
  const districts = path.join(DATA_DIR, 'pakistan-districts.tsv');
  const missing = [places, districts].filter((p) => !fs.existsSync(p));
  if (missing.length) {
    throw new HttpError(400,
      `Data file(s) missing: ${missing.map((m) => path.basename(m)).join(', ')}. ` +
      'Ye files pakkapata-pakistan-seed-v0.8.0.zip mein hain — pehle wo apply karo.',
      'SEED_DATA_MISSING');
  }
}

// ─── Core seed run (async, yields to event loop between batches) ─────────────
async function runSeed(opts, adminId) {
  const t0 = Date.now();
  patch({ status: 'running', started_at: new Date().toISOString(), phase: 'loading', message: 'Loading data files + existing DB state…', duration_ms: null });
  cancelRequested = false;

  const DRY_RUN = opts.dry_run;
  const ONLY_PROVINCE = opts.province;
  const LIMIT = opts.limit;
  const BOUNDARY_MIN_POP = opts.boundary_min_pop;

  const stats = { provinces: 0, districts: 0, villages: 0, boundaries: 0, skippedVillages: 0 };

  // Load existing DB state (idempotency registries)
  const existingCodes = new Set(db.prepare('SELECT area_code FROM areas').all().map((r) => r.area_code));
  const villagesByName = new Map();
  for (const v of db.prepare("SELECT area_code, name, lat, lng FROM areas WHERE type IN ('village','union_council') AND lat IS NOT NULL").all()) {
    const k = normName(v.name);
    if (!k) continue;
    if (!villagesByName.has(k)) villagesByName.set(k, []);
    villagesByName.get(k).push({ lat: v.lat, lng: v.lng, code: v.area_code });
  }
  const existingDistrictsByName = new Map();
  for (const d of db.prepare("SELECT area_code, name, parent_code FROM areas WHERE type='district'").all()) {
    existingDistrictsByName.set(normName(d.name), { code: d.area_code, provCode: d.parent_code });
  }

  const insertArea = db.prepare(`
    INSERT INTO areas (area_code, name, name_urdu, type, parent_code, lat, lng, h3_index, population)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function readTsv(file) {
    const p = path.join(DATA_DIR, file);
    return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => l.split('\t'));
  }

  // ── Step 1: Country + Provinces ──
  patch({ phase: 'provinces', message: 'Ensuring country + provinces/territories…' });
  await yieldToEventLoop();
  function ensureCountry() {
    if (existingCodes.has('PK')) return;
    if (!DRY_RUN) {
      const h3 = require('h3-js');
      insertArea.run('PK', 'Pakistan', 'پاکستان', 'country', null, 30.3753, 69.3451, h3.latLngToCell(30.3753, 69.3451, 2), 241499437);
    }
    existingCodes.add('PK');
    stats.provinces++;
  }
  ensureCountry();

  const provincesToSeed = ONLY_PROVINCE && PROVINCES[ONLY_PROVINCE]
    ? { [ONLY_PROVINCE]: PROVINCES[ONLY_PROVINCE] }
    : PROVINCES;
  for (const p of Object.values(provincesToSeed)) {
    if (existingCodes.has(p.code)) continue;
    if (!DRY_RUN) {
      const h3 = require('h3-js');
      insertArea.run(p.code, p.name, p.name_urdu, p.type, 'PK', p.lat, p.lng,
        h3.latLngToCell(p.lat, p.lng, 4), p.population);
    }
    existingCodes.add(p.code);
    stats.provinces++;
  }
  patch({ inserted: { ...stats } });

  // ── Step 2: Districts ──
  patch({ phase: 'districts', message: 'Registering districts (GeoNames ADM2 + ICT fallback)…' });
  await yieldToEventLoop();
  const districtRows = readTsv('pakistan-districts.tsv');
  const districtByGid = new Map();
  const districtByKey = new Map();

  function allocateDistrictCode(provCode, base3) {
    const cands = [base3];
    for (let n = 2; n <= 9; n++) cands.push(base3 + n);
    for (let n = 1; n <= 99; n++) cands.push(base3 + String(n).padStart(2, '0'));
    for (const c of cands) {
      const full = `${provCode}-${c}`;
      if (!existingCodes.has(full)) return full;
    }
    return null;
  }

  function registerDistrict(gid, name, admin1, lat, lng, pop) {
    const prov = PROVINCES[admin1];
    if (!prov) return null;
    let norm = normName(name);
    if (DISTRICT_ALIASES[norm]) norm = DISTRICT_ALIASES[norm];
    const key = `${prov.code}|${norm}`;

    if (districtByKey.has(key)) return districtByKey.get(key);

    const dbHit = existingDistrictsByName.get(norm);
    if (dbHit && dbHit.provCode === prov.code) {
      const rec = { code: dbHit.code, lat: parseFloat(lat), lng: parseFloat(lng), name, gid };
      districtByKey.set(key, rec);
      districtByGid.set(gid, rec);
      return rec;
    }

    let code = null;
    if (prov.code === 'PK-PB' && PUNJAB_DISTRICTS[norm]) code = PUNJAB_DISTRICTS[norm];
    if (!code) {
      const base3 = (generateLocalityCode(name) || 'XXX').slice(0, 3);
      code = allocateDistrictCode(prov.code, base3);
    }
    if (!code) return null;

    if (!existingCodes.has(code)) {
      if (!DRY_RUN) {
        const h3 = require('h3-js');
        insertArea.run(code, name, null, 'district', prov.code, parseFloat(lat), parseFloat(lng),
          h3.latLngToCell(parseFloat(lat), parseFloat(lng), 6), parseInt(pop, 10) || null);
      }
      existingCodes.add(code);
      stats.districts++;
    }
    const rec = { code, lat: parseFloat(lat), lng: parseFloat(lng), name, gid };
    districtByKey.set(key, rec);
    districtByGid.set(gid, rec);
    return rec;
  }

  for (const r of districtRows) {
    if (ONLY_PROVINCE && r[2] !== ONLY_PROVINCE) continue;
    registerDistrict(r[0], r[1], r[2], r[3], r[4], r[5]);
  }

  const islProv = provincesToSeed['08'];
  if (islProv) {
    let rec = null;
    for (const d of districtByKey.values()) if (d.code.startsWith('PK-IS-')) rec = d;
    if (!rec) {
      rec = registerDistrict('ICT-FALLBACK', 'Islamabad', '08', islProv.lat, islProv.lng, String(islProv.population));
    }
    if (rec) districtByGid.set('ICT-FALLBACK', rec);
  }
  patch({ inserted: { ...stats } });

  // ── Step 3: Villages / populated places ──
  patch({ phase: 'villages', message: 'Grouping places by district…' });
  await yieldToEventLoop();
  const placeRows = readTsv('pakistan-places.tsv');

  const placesByDistrict = new Map();
  const orphanBuffers = new Map();

  let grouped = 0;
  function pushPlace(rec, r) {
    const place = { gid: r[0], name: r[1], lat: parseFloat(r[2]), lng: parseFloat(r[3]), fcode: r[4], pop: parseInt(r[7], 10) || 0 };
    const list = placesByDistrict.get(rec.code);
    if (list) list.push(place);
    else placesByDistrict.set(rec.code, [place]);
    grouped++;
  }

  for (const r of placeRows) {
    if (LIMIT && grouped >= LIMIT) break;
    const admin1 = r[5], admin2 = r[6];
    if (ONLY_PROVINCE && admin1 !== ONLY_PROVINCE) continue;
    let rec = admin2 ? districtByGid.get(admin2) : null;
    if (rec) pushPlace(rec, r);
    else {
      if (!orphanBuffers.has(admin1)) orphanBuffers.set(admin1, []);
      orphanBuffers.get(admin1).push(r);
      grouped++;
    }
  }

  for (const [provCode, rows] of orphanBuffers) {
    const provDistricts = [...districtByKey.values()].filter((d) => d.code.startsWith(provCode + '-'));
    for (const r of rows) {
      if (LIMIT && grouped >= LIMIT) break;
      const lat = parseFloat(r[2]), lng = parseFloat(r[3]);
      let best = null, bestD = Infinity;
      for (const d of provDistricts) {
        const dist = haversineMeters(lat, lng, d.lat, d.lng);
        if (dist < bestD) { bestD = dist; best = d; }
      }
      if (best && bestD < 60000) pushPlace(best, r);
    }
  }

  patch({ total: grouped, processed: 0, districts_total: placesByDistrict.size, districts_done: 0, message: 'Seeding villages & populated places…' });
  await yieldToEventLoop();

  function allocateVillageSuffix(districtCode, base3) {
    const cands = [base3];
    for (let n = 2; n <= 9; n++) cands.push(base3 + n);
    for (let n = 1; n <= 99; n++) cands.push(base3 + String(n).padStart(2, '0'));
    for (let n = 1; n <= 999; n++) cands.push(base3 + String(n).padStart(3, '0'));
    const b2 = base3.slice(0, 2);
    for (let n = 1; n <= 9999; n++) cands.push(b2 + String(n).padStart(4, '0'));
    for (const c of cands) {
      const full = `${districtCode}-${c}`;
      if (!existingCodes.has(full)) return full;
    }
    return null;
  }

  let processed = 0;
  const h3 = require('h3-js');

  const seedVillagesTx = db.transaction((rows, districtCode) => {
    for (const p of rows) {
      processed++;
      const norm = normName(p.name);
      if (!norm) { stats.skippedVillages++; continue; }

      const seen = villagesByName.get(norm);
      if (seen) {
        let dup = false;
        for (const s of seen) {
          if (haversineMeters(p.lat, p.lng, s.lat, s.lng) < CAP_NAME_DIST) { dup = true; break; }
        }
        if (dup) { stats.skippedVillages++; continue; }
      }

      const base3 = (generateLocalityCode(p.name) || 'XXX').slice(0, 3);
      const code = allocateVillageSuffix(districtCode, base3);
      if (!code) { stats.skippedVillages++; continue; }

      if (!DRY_RUN) {
        insertArea.run(code, p.name, null, 'village', districtCode, p.lat, p.lng,
          h3.latLngToCell(p.lat, p.lng, 10), p.pop || null);
      }
      existingCodes.add(code);
      if (!villagesByName.has(norm)) villagesByName.set(norm, []);
      villagesByName.get(norm).push({ lat: p.lat, lng: p.lng, code });
      stats.villages++;
    }
  });

  let districtProgress = 0;
  for (const [districtCode, rows] of placesByDistrict) {
    if (cancelRequested) throw new SeedCancelled();
    districtProgress++;
    rows.sort((a, b) => (b.pop - a.pop) || a.name.localeCompare(b.name) || String(a.gid).localeCompare(String(b.gid)));
    seedVillagesTx(rows, districtCode);
    patch({
      processed,
      districts_done: districtProgress,
      current_district: districtCode,
      inserted: { ...stats },
      skipped_villages: stats.skippedVillages,
    });
    // Yield every 25 districts so HTTP/progress polling stays responsive
    if (districtProgress % 25 === 0) await yieldToEventLoop();
  }
  patch({ phase: 'boundaries', message: DRY_RUN ? 'Counting boundary targets…' : 'Inserting approximate boundaries (Qibla-zone ready)…' });
  await yieldToEventLoop();

  // ── Step 4: Approximate boundaries ──
  const stmtBoundaryExists = db.prepare('SELECT 1 FROM village_boundaries WHERE area_code = ?');
  const insertBoundary = db.prepare(`
    INSERT OR IGNORE INTO village_boundaries (area_code, name, polygon_json, centroid_lat, centroid_lng, blocks_config)
    VALUES (?, ?, ?, ?, ?, '{"A":"NE","B":"SE","C":"SW","D":"NW"}')
  `);

  function collectBoundaryItems() {
    const items = [];
    for (const rows of placesByDistrict.values()) {
      for (const p of rows) {
        const isCapital = CAPITAL_FCODES.has(p.fcode);
        if (!isCapital && p.pop < BOUNDARY_MIN_POP) continue;
        const list = villagesByName.get(normName(p.name)) || [];
        let hit = null;
        for (const s of list) {
          if (haversineMeters(p.lat, p.lng, s.lat, s.lng) < CAP_NAME_DIST) { hit = s; break; }
        }
        if (hit) items.push({ code: hit.code, name: p.name, lat: p.lat, lng: p.lng, pop: p.pop });
      }
    }
    return items;
  }

  if (DRY_RUN) {
    stats.boundaries = collectBoundaryItems().length;
  } else {
    const boundaryTx = db.transaction((items) => {
      for (const b of items) {
        if (stmtBoundaryExists.get(b.code)) continue;
        const poly = circlePolygon(b.lat, b.lng, boundaryRadius(b.pop));
        insertBoundary.run(b.code, b.name, JSON.stringify(poly), b.lat, b.lng);
        stats.boundaries++;
      }
    });
    boundaryTx(collectBoundaryItems());
  }

  // ── Step 5: Spatial index ──
  if (!DRY_RUN) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_vb_centroid ON village_boundaries(centroid_lat, centroid_lng);`);
  }

  // ── Audit trail ──
  if (!DRY_RUN && stats.villages > 0) {
    try {
      db.prepare(`
        INSERT INTO audit_log (admin_id, action, entity_type, entity_id, metadata)
        VALUES (?, 'SEED_PAKISTAN_MAP', 'area', 'bulk', ?)
      `).run(adminId || null, JSON.stringify({
        source: 'GeoNames CC-BY-4.0', via: 'dashboard',
        villages: stats.villages, districts: stats.districts,
        boundaries: stats.boundaries, boundary_min_pop: BOUNDARY_MIN_POP,
      }));
    } catch { /* audit table shape may differ — non-fatal */ }
  }

  const duration_ms = Date.now() - t0;
  return { stats, duration_ms, total: grouped };
}

// ─── Job runner (background) ─────────────────────────────────────────────────
function startSeedJob(rawOptions, adminId) {
  if (job.status === 'queued' || job.status === 'running') {
    throw new HttpError(409, 'A seed job is already running. Status: GET /api/admin/seed-pakistan/status', 'SEED_ALREADY_RUNNING');
  }
  const opts = validateOptions(rawOptions);
  ensureDataFiles();

  jobSeq += 1;
  patch({
    job_id: `seed-${jobSeq}`,
    status: 'queued',
    dry_run: opts.dry_run,
    options: { province: opts.province, limit: opts.limit, boundary_min_pop: opts.boundary_min_pop },
    admin_id: adminId || null,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    phase: 'loading',
    message: 'Queued…',
    total: 0,
    processed: 0,
    current_district: null,
    districts_done: 0,
    districts_total: 0,
    inserted: { provinces: 0, districts: 0, villages: 0, boundaries: 0 },
    skipped_villages: 0,
    error: null,
  });
  cancelRequested = false;

  // Run in background so the HTTP response goes out immediately
  setTimeout(async () => {
    try {
      const result = await runSeed(opts, adminId);
      patch({
        status: 'done',
        phase: 'done',
        finished_at: new Date().toISOString(),
        duration_ms: result.duration_ms,
        total: result.total,
        message: opts.dry_run
          ? `Dry run complete — would insert ${result.stats.villages} villages, ${result.stats.boundaries} boundaries`
          : `Seed complete — ${result.stats.villages} villages, ${result.stats.boundaries} boundaries inserted`,
        inserted: { ...result.stats },
      });
    } catch (err) {
      if (err instanceof SeedCancelled || err.name === 'SeedCancelled') {
        patch({
          status: 'cancelled',
          phase: 'done',
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - new Date(job.started_at || Date.now()).getTime(),
          message: 'Seed cancelled — koi nuqsan nahi: jo inserts ho chuke wo DB mein mehfooz hain (idempotent re-run safe hai).',
        });
      } else {
        patch({
          status: 'failed',
          phase: 'done',
          finished_at: new Date().toISOString(),
          error: err.message,
          message: `Seed failed: ${err.message}`,
        });
      }
    }
  }, 30);

  return jobSnapshot();
}

function getJobStatus() {
  return jobSnapshot();
}

function requestCancel() {
  if (job.status !== 'running' && job.status !== 'queued') {
    throw new HttpError(409, 'No seed job is currently running', 'NO_RUNNING_JOB');
  }
  cancelRequested = true;
  patch({ message: 'Cancellation requested — current district batch ke baad rukega…' });
  return jobSnapshot();
}

function getSeedStats() {
  const counts = db.prepare('SELECT type, COUNT(*) c FROM areas GROUP BY type ORDER BY type').all();
  const byType = {};
  let total = 0;
  for (const c of counts) { byType[c.type] = c.c; total += c.c; }
  const boundaries = db.prepare('SELECT COUNT(*) c FROM village_boundaries').get().c;
  let cachedPlaces = countTsvRows('pakistan-places.tsv');
  const cachedDistricts = countTsvRows('pakistan-districts.tsv');
  return {
    db: { total_areas: total, by_type: byType, boundaries },
    data_files: {
      places: { exists: cachedPlaces !== null, rows: cachedPlaces },
      districts: { exists: cachedDistricts !== null, rows: cachedDistricts },
    },
    db_path: process.env.DB_PATH || './geopata.db',
    job: jobSnapshot(),
  };
}

module.exports = {
  startSeedJob,
  getJobStatus,
  requestCancel,
  getSeedStats,
  PROVINCES,
};
