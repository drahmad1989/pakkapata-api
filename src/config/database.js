/**
 * Database connection & schema initialization.
 *
 * Uses better-sqlite3 (synchronous, fast, file-based).
 * Auto-creates tables + indexes on startup if they don't exist.
 *
 * v0.2.0 additions:
 *  - admins        : JWT-authenticated admin users (admin / verifier / viewer roles)
 *  - api_keys      : Service-to-service keys for trusted clients (e.g., SikkaChat)
 *  - audit_log     : Immutable record of all privileged actions
 *
 * Schema design notes:
 *  - properties: physical place (1 row per building)
 *  - entrances:  specific gate/door (1 row per door; many per property)
 *  - occupants:  residents (1 row per person-door link)
 *
 * "Address belongs to the PLACE, not the PERSON."
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

// Resolve DB path relative to project root
const DB_PATH = path.resolve(
  process.cwd(),
  process.env.DB_PATH || './geopata.db'
);

// Ensure parent directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Open connection
const db = new Database(DB_PATH);

// Recommended pragmas
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

/**
 * Create all tables if they don't exist.
 */
function initSchema() {
  db.exec(`
    -- ============================================================
    -- Table 1: properties (the physical place/building)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS properties (
      uprn               TEXT    PRIMARY KEY,
      h3_index           TEXT    NOT NULL,
      plus_code          TEXT    NOT NULL,
      property_type      TEXT    NOT NULL DEFAULT 'Residential',
      verification_tier  INTEGER NOT NULL DEFAULT 0
                          CHECK (verification_tier BETWEEN 0 AND 4),
      created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- ============================================================
    -- Table 2: entrances (the specific gate/door)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS entrances (
      entrance_id       INTEGER PRIMARY KEY AUTOINCREMENT,
      uprn              TEXT    NOT NULL,
      short_code        TEXT    NOT NULL UNIQUE,
      gps_lat           REAL    NOT NULL,
      gps_long          REAL    NOT NULL,
      nfc_tag_id        TEXT,
      lifecycle_status  TEXT    NOT NULL DEFAULT 'Active'
                          CHECK (lifecycle_status IN
                            ('Active', 'Vacant', 'Deprecated', 'Merged')),
      created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (uprn) REFERENCES properties(uprn)
        ON DELETE RESTRICT ON UPDATE CASCADE
    );

    -- ============================================================
    -- Table 3: occupants (the residents - HIGHLY SENSITIVE)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS occupants (
      occupant_id      INTEGER PRIMARY KEY AUTOINCREMENT,
      entrance_id      INTEGER NOT NULL,
      cnic_encrypted   TEXT    NOT NULL,
      cnic_hmac        TEXT    NOT NULL,
      phone_number     TEXT    NOT NULL,
      is_active        BOOLEAN NOT NULL DEFAULT 1,
      move_in_date     DATE,
      created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (entrance_id) REFERENCES entrances(entrance_id)
        ON DELETE RESTRICT ON UPDATE CASCADE
    );

    -- ============================================================
    -- Table 4: admins (JWT-authenticated operators)
    -- Roles: admin (full), verifier (update+tier+NFC), viewer (read-only)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS admins (
      admin_id        INTEGER PRIMARY KEY AUTOINCREMENT,
      username        TEXT    NOT NULL UNIQUE,
      password_hash   TEXT    NOT NULL,
      full_name       TEXT,
      role            TEXT    NOT NULL DEFAULT 'viewer'
                        CHECK (role IN ('admin', 'verifier', 'viewer')),
      is_active       BOOLEAN NOT NULL DEFAULT 1,
      last_login_at   DATETIME,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- ============================================================
    -- Table 5: api_keys (service-to-service auth)
    -- Used by trusted clients like SikkaChat. Key hash stored, not the key.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS api_keys (
      key_id          TEXT    PRIMARY KEY,
      name            TEXT    NOT NULL,
      key_hash        TEXT    NOT NULL UNIQUE,
      scopes          TEXT    NOT NULL DEFAULT 'read',
      is_active       BOOLEAN NOT NULL DEFAULT 1,
      created_by      INTEGER,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at    DATETIME,
      expires_at      DATETIME,

      FOREIGN KEY (created_by) REFERENCES admins(admin_id)
        ON DELETE SET NULL
    );

    -- ============================================================
    -- Table 6: audit_log (immutable record of privileged actions)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS audit_log (
      log_id          INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id        INTEGER,
      api_key_id      TEXT,
      action          TEXT    NOT NULL,
      resource_type   TEXT,
      resource_id     TEXT,
      ip_address      TEXT,
      user_agent      TEXT,
      details         TEXT,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (admin_id) REFERENCES admins(admin_id)
        ON DELETE SET NULL
    );

    -- ============================================================
    -- Table 7: areas (administrative hierarchy - v0.3.0)
    -- Self-referencing parent_code for hierarchy:
    --   Country → Province → Division → District → Tehsil → Village
    -- ============================================================
    CREATE TABLE IF NOT EXISTS areas (
      area_id      INTEGER PRIMARY KEY AUTOINCREMENT,
      area_code    TEXT    NOT NULL UNIQUE,
      name         TEXT    NOT NULL,
      name_urdu    TEXT,
      type         TEXT    NOT NULL
                          CHECK (type IN ('country','province','territory','division','district','tehsil','village','union_council')),
      parent_code  TEXT,
      lat          REAL,
      lng          REAL,
      h3_index     TEXT,
      population   INTEGER,
      is_active    BOOLEAN NOT NULL DEFAULT 1,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (parent_code) REFERENCES areas(area_code)
        ON DELETE RESTRICT ON UPDATE CASCADE
    );

    -- ============================================================
    -- Table 8: address_areas (link table - v0.3.0)
    -- Links each entrance to its area chain (village, tehsil,
    -- district, etc.). One address → multiple area rows.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS address_areas (
      entrance_id  INTEGER NOT NULL,
      area_code    TEXT    NOT NULL,
      assigned_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      assigned_by  TEXT    DEFAULT 'auto',

      PRIMARY KEY (entrance_id, area_code),
      FOREIGN KEY (entrance_id) REFERENCES entrances(entrance_id) ON DELETE CASCADE,
      FOREIGN KEY (area_code)   REFERENCES areas(area_code) ON DELETE RESTRICT
    );

    -- ============================================================
    -- Table 9: village_boundaries (v0.4.2 - polygon-based blocks)
    -- Stores GeoJSON polygon for each village + 4 quadrant blocks
    -- ============================================================
    CREATE TABLE IF NOT EXISTS village_boundaries (
      boundary_id    INTEGER PRIMARY KEY AUTOINCREMENT,
      area_code      TEXT    NOT NULL UNIQUE,  -- village area_code (e.g., PK-PB-LHR-KAS-PTK-BBG)
      name           TEXT    NOT NULL,         -- village name
      polygon_json   TEXT    NOT NULL,         -- GeoJSON polygon: {"type":"Polygon","coordinates":[[[lat,lng],...]]}
      centroid_lat   REAL    NOT NULL,         -- polygon centroid latitude
      centroid_lng   REAL    NOT NULL,         -- polygon centroid longitude
      blocks_config  TEXT    NOT NULL DEFAULT '{"A":"NE","B":"SE","C":"SW","D":"NW"}',
      is_active      BOOLEAN NOT NULL DEFAULT 1,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (area_code) REFERENCES areas(area_code) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_village_boundaries_area ON village_boundaries(area_code);

    -- ============================================================
    -- Indexes
    -- ============================================================
    CREATE INDEX IF NOT EXISTS idx_properties_h3          ON properties(h3_index);
    CREATE INDEX IF NOT EXISTS idx_properties_tier        ON properties(verification_tier);
    CREATE INDEX IF NOT EXISTS idx_properties_type        ON properties(property_type);
    CREATE INDEX IF NOT EXISTS idx_properties_updated     ON properties(updated_at);

    CREATE INDEX IF NOT EXISTS idx_entrances_uprn         ON entrances(uprn);
    CREATE INDEX IF NOT EXISTS idx_entrances_lat          ON entrances(gps_lat);
    CREATE INDEX IF NOT EXISTS idx_entrances_long         ON entrances(gps_long);
    CREATE INDEX IF NOT EXISTS idx_entrances_lat_long     ON entrances(gps_lat, gps_long);
    CREATE INDEX IF NOT EXISTS idx_entrances_lifecycle    ON entrances(lifecycle_status);
    CREATE INDEX IF NOT EXISTS idx_entrances_nfc          ON entrances(nfc_tag_id);
    CREATE INDEX IF NOT EXISTS idx_entrances_updated      ON entrances(updated_at);

    CREATE INDEX IF NOT EXISTS idx_occupants_entrance     ON occupants(entrance_id);
    CREATE INDEX IF NOT EXISTS idx_occupants_cnic_hmac    ON occupants(cnic_hmac);
    CREATE INDEX IF NOT EXISTS idx_occupants_active       ON occupants(is_active);

    CREATE INDEX IF NOT EXISTS idx_admins_role            ON admins(role);
    CREATE INDEX IF NOT EXISTS idx_admins_active          ON admins(is_active);

    CREATE INDEX IF NOT EXISTS idx_api_keys_hash          ON api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_api_keys_active        ON api_keys(is_active);

    CREATE INDEX IF NOT EXISTS idx_audit_admin            ON audit_log(admin_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action           ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_resource         ON audit_log(resource_type, resource_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created          ON audit_log(created_at);

    CREATE INDEX IF NOT EXISTS idx_areas_type             ON areas(type);
    CREATE INDEX IF NOT EXISTS idx_areas_parent           ON areas(parent_code);
    CREATE INDEX IF NOT EXISTS idx_areas_h3               ON areas(h3_index);
    CREATE INDEX IF NOT EXISTS idx_areas_lat_lng          ON areas(lat, lng);
    CREATE INDEX IF NOT EXISTS idx_areas_active           ON areas(is_active);
    -- v0.8.0: fast nearest-boundary lookup for detect (Pakistan-wide seed)
    CREATE INDEX IF NOT EXISTS idx_vb_centroid            ON village_boundaries(centroid_lat, centroid_lng);

    CREATE INDEX IF NOT EXISTS idx_address_areas_entrance ON address_areas(entrance_id);
    CREATE INDEX IF NOT EXISTS idx_address_areas_area     ON address_areas(area_code);
  `);
}

/**
 * Add area_code column to properties table (v0.3.0 migration).
 * Idempotent — only adds if column doesn't exist.
 */
function migratePropertiesAddAreaCode() {
  try {
    const cols = db.prepare("PRAGMA table_info(properties)").all();
    const hasAreaCode = cols.some(c => c.name === 'area_code');
    if (!hasAreaCode) {
      db.exec("ALTER TABLE properties ADD COLUMN area_code TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS idx_properties_area ON properties(area_code)");
      // eslint-disable-next-line no-console
      console.log('   ✓ properties.area_code column added (v0.3.0 migration)');
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('   Migration error (properties.area_code):', err.message);
  }
}

/**
 * v0.4.0 migration: Add human-friendly address fields.
 * Non-breaking — existing addresses keep working, new fields are nullable.
 *
 * New columns:
 *   display_name   — user-chosen name ("Ali's Home")
 *   block_code     — block letter ("A", "B", "C")
 *   street_number  — street number ("1", "2", "3")
 *   house_number   — house identifier ("H01", "H02", "15")
 *   share_code     — short memorable code ("BONGA-A1-H01")
 */
function migratePropertiesAddAddressFields() {
  try {
    const cols = db.prepare("PRAGMA table_info(properties)").all();
    const colNames = cols.map(c => c.name);

    const newCols = [
      { name: 'display_name', type: 'TEXT' },
      { name: 'block_code', type: 'TEXT' },
      { name: 'street_number', type: 'TEXT' },
      { name: 'house_number', type: 'TEXT' },
      { name: 'share_code', type: 'TEXT' },
    ];

    let added = 0;
    for (const col of newCols) {
      if (!colNames.includes(col.name)) {
        db.exec(`ALTER TABLE properties ADD COLUMN ${col.name} ${col.type}`);
        added++;
      }
    }

    if (added > 0) {
      db.exec("CREATE INDEX IF NOT EXISTS idx_properties_share_code ON properties(share_code)");
      // eslint-disable-next-line no-console
      console.log(`   ✓ ${added} address fields added (v0.4.0 migration: display_name, block_code, street_number, house_number, share_code)`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('   Migration error (v0.4.0 address fields):', err.message);
  }
}

/**
 * v0.5.0 migration: staff phone + OTP login codes.
 *
 * Field verifiers log in with a phone OTP instead of a password:
 *   - admins.phone          — canonical +92XXXXXXXXXX (unique, nullable)
 *   - otp_login_codes       — hashed codes, epoch-ms timestamps, single-use
 *
 * Idempotent: safe on fresh DBs AND on DBs where some earlier/foreign
 * tool already added an admins.phone column.
 */
function migrateStaffOtp() {
  try {
    const cols = db.prepare('PRAGMA table_info(admins)').all();
    const hasPhone = cols.some(c => c.name === 'phone');
    if (!hasPhone) {
      db.exec('ALTER TABLE admins ADD COLUMN phone TEXT');
      // eslint-disable-next-line no-console
      console.log('   ✓ admins.phone column added (v0.5.0 migration: staff OTP login)');
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_phone
        ON admins(phone) WHERE phone IS NOT NULL;

      CREATE TABLE IF NOT EXISTS otp_login_codes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        phone       TEXT    NOT NULL,
        code_hash   TEXT    NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0,
        expires_at  INTEGER NOT NULL,
        consumed_at INTEGER,
        created_at  INTEGER NOT NULL,
        ip          TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_otp_login_phone
        ON otp_login_codes(phone, created_at);
    `);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('   Migration error (v0.5.0 staff OTP):', err.message);
  }
}

/**
 * Seed a default admin user if none exists.
 * Default credentials (CHANGE IMMEDIATELY in production):
 *   username: admin
 *   password: admin123
 */
function seedDefaultAdmin() {
  const existing = prepare('SELECT 1 FROM admins LIMIT 1').get();
  if (existing) return;

  const username = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
  const password = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';
  const passwordHash = bcrypt.hashSync(password, 10);

  prepare(`
    INSERT INTO admins (username, password_hash, full_name, role, is_active)
    VALUES (?, ?, ?, 'admin', 1)
  `).run(username, passwordHash, 'Default Administrator');

  // eslint-disable-next-line no-console
  console.log(`   ┌──────────────────────────────────────────────┐`);
  // eslint-disable-next-line no-console
  console.log(`   │  Default admin seeded: ${username.padEnd(28)}│`);
  // eslint-disable-next-line no-console
  console.log(`   │  Password: ${'*'.repeat(password.length).padEnd(34)}│`);
  // eslint-disable-next-line no-console
  console.log(`   │  ⚠️  CHANGE THIS IMMEDIATELY IN PRODUCTION   │`);
  // eslint-disable-next-line no-console
  console.log(`   └──────────────────────────────────────────────┘`);
}

/**
 * Lazy prepared-statement cache.
 * Prevents crashes on Node v24 where module-level prepared statements
 * can trigger assertion failures during garbage collection.
 *
 * Usage:
 *   const { prepare } = require('../config/database');
 *   const stmt = prepare('SELECT * FROM users WHERE id = ?');
 *   stmt.get(1);
 */
const _nativePrepare = db.prepare.bind(db);
const stmtCache = new Map();
function prepare(sql) {
  if (!stmtCache.has(sql)) {
    stmtCache.set(sql, _nativePrepare(sql));
  }
  return stmtCache.get(sql);
}

// Run schema init + migrations + seed at module load
initSchema();

/**
 * v0.6.0 migration: payment intents + GS issuances (v0.10.4).
 *
 * JazzCash/Easypaisa webhook → GS auto-approve pipeline ki data layer:
 *   - payment_intents  har webhook/txn ki idempotent record (provider+txn unique)
 *   - gs_issuances     approved GS credits (1 GS = 1 PKR peg), RabtaChat poll+ack
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS — fresh aur purani DBs dono safe.
 */
function migratePayments() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_intents (
      id               TEXT PRIMARY KEY,
      provider         TEXT NOT NULL,
      provider_txn_id  TEXT,
      msisdn           TEXT,
      amount_pkr       REAL,
      reference        TEXT,
      status           TEXT NOT NULL DEFAULT 'received',
      signature_valid  INTEGER NOT NULL DEFAULT 0,
      raw_payload      TEXT,
      failure_reason   TEXT,
      created_at       INTEGER NOT NULL,
      processed_at     INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_provider_txn
      ON payment_intents(provider, provider_txn_id)
      WHERE provider_txn_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_pi_msisdn ON payment_intents(msisdn, created_at);

    CREATE TABLE IF NOT EXISTS gs_issuances (
      id               TEXT PRIMARY KEY,
      intent_id        TEXT REFERENCES payment_intents(id),
      msisdn           TEXT NOT NULL,
      gs_amount        REAL NOT NULL,
      pkr_amount       REAL NOT NULL,
      status           TEXT NOT NULL DEFAULT 'approved',
      approved_via     TEXT NOT NULL DEFAULT 'webhook',
      acknowledged_at  INTEGER,
      created_at       INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_gsi_msisdn ON gs_issuances(msisdn, status);
  `);
  // eslint-disable-next-line no-console
  console.log('   ✓ payment_intents + gs_issuances tables ready (v0.6.0 migration: payments & GS)');
}

/**
 * v0.7.0 migration: Mashwara Box (v0.10.7).
 *
 * Public suggestion intake (no login) + village name-lock mechanism:
 *   - suggestions          public aawami mashwara (ghar/gali/entry/naam/sarhad/deegar)
 *   - areas.locked_at      name-plate finalization ke baad code/names IMMUTABLE
 *   - areas.locked_by      kaunse admin ne lock kiya (audit trail)
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS + PRAGMA column check — fresh aur
 * purani DBs dono safe.
 */
function migrateMashwaraBox() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS suggestions (
      id              TEXT PRIMARY KEY,
      village_code    TEXT NOT NULL,
      type            TEXT NOT NULL
                        CHECK (type IN ('ghar','gali','entry','naam','sarhad','deegar')),
      title           TEXT,
      body            TEXT NOT NULL,
      gps_lat         REAL,
      gps_lng         REAL,
      photo_path      TEXT,
      contact_phone   TEXT,
      status          TEXT NOT NULL DEFAULT 'new'
                        CHECK (status IN ('new','reviewed','accepted','rejected')),
      admin_note      TEXT,
      reviewed_by     INTEGER,
      reviewed_at     INTEGER,
      ip_address      TEXT,
      user_agent      TEXT,
      created_at      INTEGER NOT NULL,

      FOREIGN KEY (village_code) REFERENCES areas(area_code) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_suggestions_village ON suggestions(village_code, status);
    CREATE INDEX IF NOT EXISTS idx_suggestions_status  ON suggestions(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_suggestions_type    ON suggestions(type);
  `);
  // eslint-disable-next-line no-console
  console.log('   ✓ suggestions table ready (v0.7.0 migration: Mashwara Box)');

  try {
    const cols = db.prepare('PRAGMA table_info(areas)').all();
    const hasLockedAt = cols.some(c => c.name === 'locked_at');
    if (!hasLockedAt) {
      db.exec('ALTER TABLE areas ADD COLUMN locked_at INTEGER');
      db.exec('ALTER TABLE areas ADD COLUMN locked_by INTEGER');
      db.exec('CREATE INDEX IF NOT EXISTS idx_areas_locked ON areas(locked_at)');
      // eslint-disable-next-line no-console
      console.log('   ✓ areas.locked_at + locked_by columns added (v0.7.0 migration: area lock)');
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('   Migration error (v0.7.0 area lock):', err.message);
  }
}

migratePropertiesAddAreaCode();
migratePropertiesAddAddressFields();
migrateStaffOtp();
migratePayments();
migrateMashwaraBox();
seedDefaultAdmin();

module.exports = db;
module.exports.prepare = prepare;
module.exports.db = db;
