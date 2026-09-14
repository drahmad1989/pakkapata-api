/**
 * PakkaPata — Integration Service (v0.10.3)
 *
 * RabtaChat ↔ PakkaPata integration ko self-configuring + self-diagnosing banata hai:
 *
 *   1) detectRabtaChatDir()   — RabtaChat folder dhoondo (env override → known paths →
 *                               sibling → drives). v0.10.3: G:\projects\sikkachat-v6 added.
 *   2) writeRabtaChatEnv()    — RabtaChat ke .env mein PAKKAPATA_API_KEY khud likho
 *                               (purani lines strip, backup, read-back verify)
 *   3) getRabtaChatStatus()   — verdict engine: admin panel ko batao integration
 *                               EXACTLY kahan atka hua hai (connected / restart
 *                               chahiye / stale key / folder nahi mila ...)
 *
 * Security rules:
 *   - Full key KABHI file se wapas expose nahi hota (sirf masked preview)
 *   - .env ka raw content KABHI response mein nahi jata
 *   - Har fs operation try/catch — user ki drive missing ho to bhi server crash nahi
 *
 * Yahan DB read hoti hai (api_keys) lekin write NAHI — writes sirf
 * adminController (setup flow) karta hai, single responsibility.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { prepare } = require('../config/database');

const RABTACHAT_KEY_NAME = 'RabtaChat Production';

// Backend root = src/services/../..  → pakkapata-backend/
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

// Candidate list — pehla jo "RabtaChat jaisa" lage wahi jeet-ta hai.
// RABTACHAT_DIR explicit ho to usay TRUST karte hain (validation halki).
function rabtaChatDirCandidates() {
  const list = [];
  if (process.env.RABTACHAT_DIR && String(process.env.RABTACHAT_DIR).trim() !== '') {
    list.push({ dir: String(process.env.RABTACHAT_DIR).trim(), source: 'env', trusted: true });
  }
  // v0.10.3: user-confirmed REAL install paths — sab se pehle in ko check karo
  // (user ka RabtaChat G:\projects\sikkachat-v6 mein hai — D:\RabtaChat NAHI hai)
  list.push({ dir: 'G:\\projects\\sikkachat-v6', source: 'known-path', trusted: false });
  list.push({ dir: 'G:\\projects\\RabtaChat', source: 'known-path', trusted: false });
  // Backend D:\GeoPata mein hai to sibling D:\RabtaChat = ../RabtaChat
  // (Windows case-insensitive hai — lowercase variant ki zaroorat nahi,
  //  aur hamari repo-constraint ke mutabiq rabtachat/ folder ko kabhi touch nahi karna)
  list.push({ dir: path.resolve(BACKEND_ROOT, '..', 'RabtaChat'), source: 'sibling', trusted: false });
  // Common Windows drives (sandbox/Linux pe existsSync false — harmless)
  list.push({ dir: 'D:\\RabtaChat', source: 'drive', trusted: false });
  list.push({ dir: 'C:\\RabtaChat', source: 'drive', trusted: false });
  return list;
}

// Dir "RabtaChat jaisi" hai? package.json name/description mein 'rabta',
// ya .env mojood, ya src/app structure.
function looksLikeRabtaChat(dir) {
  try {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const hay = `${pkg.name || ''} ${pkg.description || ''}`.toLowerCase();
        // v0.10.3: 'sikka' bhi — user ka folder sikkachat-v6 hai (RabtaChat ka hi roop)
        if (hay.includes('rabta') || hay.includes('sikka')) return true;
      } catch { /* unparseable package.json — continue */ }
    }
    const envOk = fs.existsSync(path.join(dir, '.env'));
    const srcOk = fs.existsSync(path.join(dir, 'src'));
    if (envOk && srcOk) return true;
    // package.json bhi .env bhi nahi — khali/nayi folder; neutral
    return false;
  } catch {
    return false;
  }
}

// Pehla valid candidate return karo, ya null.
// Explicit RABTACHAT_DIR sirf isDir check pass kare to bhi qabool (trusted),
// magar dir mojood hi na ho to null.
function detectRabtaChatDir() {
  for (const cand of rabtaChatDirCandidates()) {
    try {
      if (!fs.existsSync(cand.dir)) continue;
      const st = fs.statSync(cand.dir);
      if (!st.isDirectory()) continue;
      if (cand.trusted) return { dir: cand.dir, envPath: path.join(cand.dir, '.env'), source: cand.source, confirmed: true };
      const confirmed = looksLikeRabtaChat(cand.dir);
      // Unconfirmed dirs ko bhi report karo (status UI warning dikhaye ga),
      // magar write ke liye controller confirmed dir hi use karega.
      return { dir: cand.dir, envPath: path.join(cand.dir, '.env'), source: cand.source, confirmed };
    } catch { /* permission/IO error — next candidate */ }
  }
  return null;
}

// .env ko robust parse karo (BOM, CRLF, export prefix, quotes, inline comments)
function parseEnvText(text) {
  const out = {};
  if (!text) return out;
  const clean = text.replace(/^\uFEFF/, ''); // BOM
  for (const rawLine of clean.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Inline comment (space + # ke baad sab kuch) — sirf quoted values na hon to
    if (!val.startsWith('"') && !val.startsWith("'")) {
      const hash = val.indexOf(' #');
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    if ((val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
        (val.startsWith("'") && val.endsWith("'") && val.length >= 2)) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

function readRabtaChatEnv(envPath) {
  if (!fs.existsSync(envPath)) return { exists: false, vars: {} };
  try {
    const text = fs.readFileSync(envPath, 'utf8');
    return { exists: true, vars: parseEnvText(text) };
  } catch (err) {
    return { exists: true, vars: {}, error: err.message };
  }
}

// .env WRITE: strip purani PAKKAPATA_ lines → append naya block → read-back verify.
// Backup: .env.pakkapata-backup (har setup se pehle overwrite — last-known-good).
function writeRabtaChatEnv(dir, apiKey, apiUrl) {
  const envPath = path.join(dir, '.env');
  const block = [
    `# PakkaPata integration — RabtaChat settlement (auto-written by PakkaPata on ${new Date().toISOString()})`,
    `PAKKAPATA_API_URL=${apiUrl}`,
    `PAKKAPATA_API_KEY=${apiKey}`,
  ].join('\n');

  let content = '';
  if (fs.existsSync(envPath)) {
    // Backup pehle
    try {
      fs.copyFileSync(envPath, path.join(dir, '.env.pakkapata-backup'));
    } catch (err) {
      // Backup fail — write roko? Nahi: agar file padhi ja sakti hai to aage barho,
      // magar reason record karo. Agar padhi hi na ja saki to throw.
      try { fs.readFileSync(envPath, 'utf8'); } catch { throw new Error(`backup fail: ${err.message}`); }
    }
    content = fs.readFileSync(envPath, 'utf8');
  }

  // Purani PAKKAPATA_ lines + hamari marker comments hatao (baqi sab intact)
  let cleaned = content
    .replace(/^\uFEFF/, '')
    .replace(/^[ \t]*(?:export[ \t]+)?PAKKAPATA_API_URL[ \t]*=.*$/gim, '')
    .replace(/^[ \t]*(?:export[ \t]+)?PAKKAPATA_API_KEY[ \t]*=.*$/gim, '')
    .replace(/^#[ \t]*PakkaPata integration.*$/gim, '');
  // 3+ blank lines collapse
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');

  const next = cleaned === '' ? block : `${cleaned}\n\n${block}\n`;
  fs.writeFileSync(envPath, next, 'utf8');

  // Read-back verify — jo likha wohi para hai?
  const recheck = readRabtaChatEnv(envPath);
  if (recheck.vars.PAKKAPATA_API_KEY !== apiKey) {
    throw new Error('env read-back verify fail — file likhi magar value match nahi hui');
  }
  return { written: true, env_path: envPath };
}

// key preview — pehle 12 + last 4, beech masked (sk_live_ab12...ef90)
function maskKey(fullKey) {
  if (!fullKey || fullKey.length < 20) return 'sk_live_****';
  return `${fullKey.slice(0, 12)}****${fullKey.slice(-4)}`;
}

// ─────────────────────────────────────────────
// v0.10.5: RABTACHAT HEALTH PING — link diagnosis ka missing link.
//
// Pehle sirf verdict engine tha (folder/.env/key-match/last-call) — magar
// "RabtaChat CHAL bhi raha hai ya nahi" ye server-side se koi nahi dekh
// raha tha. Ab PakkaPata backend KHUD RabtaChat ke /api/health ko call
// karta hai (3.5s timeout) aur bata deta hai:
//   - reachable hai / nahi (band hai → 3-start-rabtachat.bat chalao)
//   - service/version kya boli (agar service=pakkapata mila to PORT mixup!)
//   - kitni latency mein jawab mila
// Koi key/secret is call mein nahi jata — sirf public health endpoint.
// ─────────────────────────────────────────────
const RABTACHAT_HEALTH_URL_DEFAULT = 'http://localhost:3000/api/health';

async function pingRabtaChat() {
  const url = (process.env.RABTACHAT_HEALTH_URL && String(process.env.RABTACHAT_HEALTH_URL).trim())
    || RABTACHAT_HEALTH_URL_DEFAULT;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const latency_ms = Date.now() - started;
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON health — still reachable */ }
    const service = body && typeof body === 'object' && body.service ? String(body.service) : null;
    const version = body && typeof body === 'object' && body.version ? String(body.version) : null;

    let hint_ur;
    if (res.ok && service === 'pakkapata') {
      hint_ur = 'Port 3000 par PAKKAPATA khud chal raha hai (RabtaChat nahi!) — backend ka PORT=3001 check karo aur RabtaChat ko 3000 par chalao.';
    } else if (res.ok) {
      hint_ur = `RabtaChat chal raha hai (service: ${service || 'unknown'}${version ? `, v${version}` : ''}) — ab RabtaChat restart + Ping PakkaPata ke baad aakhri call green ho jayegi.`;
    } else {
      hint_ur = `RabtaChat ne jawab diya magar HTTP ${res.status} — RabtaChat ka console/logs dekho.`;
    }

    return {
      ok: Boolean(res.ok),
      reachable: true,
      checked_url: url,
      http_status: res.status,
      service,
      version,
      latency_ms,
      hint_ur,
    };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err && err.message)));
    return {
      ok: false,
      reachable: false,
      checked_url: url,
      http_status: null,
      service: null,
      version: null,
      latency_ms: Date.now() - started,
      hint_ur: aborted
        ? 'RabtaChat ne 3.5 sec mein jawab nahi diya (hang?) — RabtaChat ka window dekho, ya 3-start-rabtachat.bat dobara chalao.'
        : 'RabtaChat se connection nahi bana — RabtaChat BAND lagta hai. 3-start-rabtachat.bat chalao (port 3000), phir yahan Ping dobara dabao.',
    };
  } finally {
    clearTimeout(timer);
  }
}

function sqliteTsToEpochMs(ts) {
  if (!ts) return null;
  try {
    // CURRENT_TIMESTAMP = 'YYYY-MM-DD HH:MM:SS' in UTC
    const ms = Date.parse(String(ts).replace(' ', 'T') + 'Z');
    return Number.isFinite(ms) ? ms : null;
  } catch { return null; }
}

function agoSec(ts) {
  const ms = sqliteTsToEpochMs(ts);
  if (ms === null) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 1000));
}

function humanAgo(sec) {
  if (sec === null || sec === undefined) return 'kabhi nahi';
  if (sec < 60) return `${sec} sec pehle`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min pehle`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} ghante pehle`;
  return `${Math.floor(sec / 86400)} din pehle`;
}

// ─────────────────────────────────────────────
// VERDICT ENGINE — admin panel status card ka dimagh
// ─────────────────────────────────────────────
// Severe mapping: ok (green) / idle (green-ish) / warn (amber) / error (red) / neutral
function getRabtaChatStatus() {
  // 1) Key inventory
  const rows = prepare(
    `SELECT key_id, key_hash, is_active, scopes, created_at, last_used_at
     FROM api_keys WHERE name = ? ORDER BY created_at DESC`
  ).all(RABTACHAT_KEY_NAME);

  const active = rows.find((r) => r.is_active === 1) || null;
  const revokedCount = rows.filter((r) => r.is_active !== 1).length;
  const knownHashes = new Map(rows.map((r) => [r.key_hash, r.is_active === 1]));

  const base = {
    key: active
      ? {
          key_id: active.key_id,
          scopes: active.scopes,
          created_at: active.created_at,
          last_used_at: active.last_used_at,
          last_used_ago_sec: agoSec(active.last_used_at),
          last_used_human: humanAgo(agoSec(active.last_used_at)),
          revoked_old_count: revokedCount,
        }
      : null,
    integration: { dir_found: false, dir: null, env_path: null, env_key_set: false, env_key_match: 'none', env_url: null, env_url_ok: null, dir_confirmed: false },
    restart_hint: false,
  };

  // 2) Folder detection PEHLE — taake no-active-key case mein bhi .env ki
  //    halat dekh saken (stale revoked key vs bilkul khali)
  const detected = detectRabtaChatDir();
  let envKey = null;
  let envUrl = null;
  let match = 'none'; // 'active' | 'revoked' | 'unknown' | 'none'

  if (detected) {
    base.integration.dir_found = true;
    base.integration.dir = detected.dir;
    base.integration.env_path = detected.envPath;
    base.integration.dir_confirmed = detected.confirmed;
    const env = readRabtaChatEnv(detected.envPath);
    envKey = env.vars.PAKKAPATA_API_KEY || null;
    envUrl = env.vars.PAKKAPATA_API_URL || null;
    base.integration.env_key_set = Boolean(envKey);
    base.integration.env_url = envUrl;
    base.integration.env_url_ok = envUrl ? envUrl.trim() === (process.env.RABTACHAT_PAKKAPATA_URL || 'http://localhost:3001') : null;

    // 3) .env key ka hash match — active ya revoked?
    if (envKey) {
      const envHash = crypto.createHash('sha256').update(envKey).digest('hex');
      if (active && envHash === active.key_hash) {
        match = 'active';
      } else if (knownHashes.has(envHash)) {
        match = 'revoked';
      } else {
        match = 'unknown';
      }
    }
    base.integration.env_key_match = match;
  }

  // 4) Verdict: koi active key hi nahi
  if (!active) {
    // .env mein revoked key padi hai? → zyada precise diagnosis do
    if (detected && detected.confirmed && envKey && match === 'revoked') {
      return {
        ...base,
        verdict: 'env_stale_key',
        severity: 'error',
        verdict_ur: 'RabtaChat ki saari keys revoke ho chuki hain aur .env mein bhi wohi purani (reject ho chuki) key padi hai — 1-Click Setup chalao, phir RabtaChat restart karo.',
      };
    }
    return {
      ...base,
      verdict: 'not_configured',
      severity: 'neutral',
      verdict_ur: rows.length
        ? 'RabtaChat key revoked ho gayi hai — 1-Click Setup chala kar nayi banao.'
        : 'RabtaChat abhi setup nahi hua — API Keys page par 1-Click Setup chalao.',
    };
  }

  // 5) Verdict tree
  if (!detected) {
    return {
      ...base,
      verdict: 'no_dir',
      severity: 'warn',
      verdict_ur: 'RabtaChat folder nahi mila (G:\\projects\\sikkachat-v6 / D:\\RabtaChat / C:\\RabtaChat / sibling). .env block manually paste karo, ya PakkaPata ke .env mein RABTACHAT_DIR=<aapka RabtaChat path> set kar ke backend restart karo.',
    };
  }
  if (!detected.confirmed) {
    return {
      ...base,
      verdict: 'dir_uncertain',
      severity: 'warn',
      verdict_ur: `${detected.dir} mila magar ye RabtaChat jaisa nahi lagta. RABTACHAT_DIR se sahi path do ya manually paste karo.`,
    };
  }
  if (!envKey) {
    return {
      ...base,
      verdict: 'env_missing_key',
      severity: 'error',
      verdict_ur: `RabtaChat .env (${detected.envPath}) mein PAKKAPATA_API_KEY nahi — 1-Click Setup dobara chalao (backend khud likh dega).`,
    };
  }

  const lastAgo = agoSec(active.last_used_at);
  if (match === 'active') {
    if (lastAgo !== null && lastAgo < 15 * 60) {
      return {
        ...base,
        verdict: 'connected',
        severity: 'ok',
        verdict_ur: `RabtaChat connected hai — aakhri call ${humanAgo(lastAgo)}.`,
      };
    }
    if (lastAgo === null) {
      return {
        ...base,
        verdict: 'ready_restart',
        severity: 'warn',
        verdict_ur: 'Key .env mein sahi set hai magar RabtaChat ne abhi tak ek bhi call nahi ki — RabtaChat RESTART karo.',
        restart_hint: true,
      };
    }
    return {
      ...base,
      verdict: 'ready_idle',
      severity: 'idle',
      verdict_ur: `Key set hai, aakhri call ${humanAgo(lastAgo)}. RabtaChat chal raha hai? Naya traffic aane par status khud green ho jayega.`,
    };
  }
  if (match === 'revoked') {
    return {
      ...base,
      verdict: 'env_stale_key',
      severity: 'error',
      verdict_ur: '.env mein PURANA (revoked) key hai — isi liye RabtaChat ko "API key reject" mil raha hai. 1-Click Setup dobara chalao, phir RabtaChat restart karo.',
    };
  }
  // match === 'unknown'
  return {
    ...base,
    verdict: 'env_unknown_key',
    severity: 'error',
    verdict_ur: '.env mein jo key hai woh PakkaPata ki kisi key se match nahi karti (typo ya kisi aur server ki key). 1-Click Setup dobara chalao.',
  };
}

module.exports = {
  RABTACHAT_KEY_NAME,
  detectRabtaChatDir,
  readRabtaChatEnv,
  parseEnvText,
  writeRabtaChatEnv,
  getRabtaChatStatus,
  pingRabtaChat,
  maskKey,
  humanAgo,
};
