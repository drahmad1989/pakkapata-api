/**
 * GeoPata — Zod validation schemas (v0.2.0)
 *
 * Used by src/middleware/validate.js to coerce + validate incoming requests.
 *
 * Design decisions:
 *  - Server auto-generates UPRN, short_code, h3_index, plus_code.
 *    Clients only send lat/long (+ optional property_type, verification_tier).
 *  - CNIC is sent as plain string (with or without dashes); server encrypts it.
 *  - Phone numbers must be E.164 (e.g. +923001234567).
 */

const { z } = require('zod');

// ─────────────────────────────────────────────
// Shared primitives
// ─────────────────────────────────────────────

const latSchema = z
  .number({ message: 'Latitude must be a number' })
  .min(-90, 'Latitude must be >= -90')
  .max(90, 'Latitude must be <= 90');

const lngSchema = z
  .number({ message: 'Longitude must be a number' })
  .min(-180, 'Longitude must be >= -180')
  .max(180, 'Longitude must be <= 180');

const cnicSchema = z
  .string()
  .regex(/^\d{5}-?\d{7}-?\d$/, 'CNIC must be 13 digits, e.g. 35202-1234567-8');

const phoneSchema = z
  .string()
  .regex(/^\+92\d{10}$/, 'Phone must be E.164 format, e.g. +923001234567');

const propertyTypeSchema = z.enum([
  'Residential', 'Commercial', 'Mixed', 'Industrial',
  'Government', 'Agricultural', 'Other',
]);

const lifecycleSchema = z.enum(['Active', 'Vacant', 'Deprecated', 'Merged']);
const roleSchema = z.enum(['admin', 'verifier', 'viewer']);
const apiKeyScopeSchema = z.array(z.enum(['read', 'write', 'admin'])).min(1);

// ─────────────────────────────────────────────
// Address schemas
// ─────────────────────────────────────────────

const createAddressSchema = z.object({
  body: z.object({
    gps_lat: latSchema,
    gps_long: lngSchema,
    property_type: propertyTypeSchema.default('Residential'),
    verification_tier: z.number().int().min(0).max(4).optional(),
    uprn: z.string().regex(/^[A-Z]{2}-[A-Z]{2}-\d{4,}$/, 'UPRN format: PK-PB-000001').optional(),
    short_code: z.string().regex(/^[A-Z]{3}-\d{4,}$/, 'Short code format: BGL-0001').optional(),
    // v0.4.0 human-friendly fields (all optional)
    display_name: z.string().min(1).max(100).optional(),
    block_code: z.string().min(1).max(10).optional(),
    street_number: z.string().min(1).max(10).optional(),
    house_number: z.string().min(1).max(10).optional(),
  }),
});

const addressByCodeSchema = z.object({
  params: z.object({
    code: z.string().regex(/^[A-Z]{3}-\d{4,}$/, 'Short code must look like BGL-0001'),
  }),
});

const updateAddressSchema = z.object({
  params: z.object({
    code: z.string().regex(/^[A-Z]{3}-\d{4,}$/, 'Short code must look like BGL-0001'),
  }),
  body: z.object({
    property_type: propertyTypeSchema.optional(),
    verification_tier: z.number().int().min(0).max(4).optional(),
  }).refine(d => d.property_type || d.verification_tier != null, {
    message: 'At least one of property_type or verification_tier must be provided',
  }),
});

const upgradeTierSchema = z.object({
  params: z.object({
    code: z.string().regex(/^[A-Z]{3}-\d{4,}$/, 'Short code must look like BGL-0001'),
  }),
  body: z.object({
    to_tier: z.number().int().min(1).max(4),
    note: z.string().max(500).optional(),
  }),
});

const listAddressesSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    tier: z.coerce.number().int().min(0).max(4).optional(),
    type: propertyTypeSchema.optional(),
    status: lifecycleSchema.optional(),
    q: z.string().max(50).optional(),
  }),
});

const radiusSearchSchema = z.object({
  query: z.object({
    lat: z.coerce.number().min(-90).max(90),
    long: z.coerce.number().min(-180).max(180),
    radius: z.coerce.number().int().min(1).max(100000),
  }),
});

// ─────────────────────────────────────────────
// Entrance management schemas
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// Public lookup schemas (v0.7.0)
// Accepts BOTH code formats:
//   short_code: BGL-0001      (2 segments)
//   share_code: BONG-Q07-025  (3 segments, Qibla zone style)
// ─────────────────────────────────────────────

const publicAddressCodeSchema = z.object({
  params: z.object({
    code: z.string()
      .regex(/^[A-Z]{3,6}(-[A-Z0-9]{1,6}){1,3}$/, 'Code format: BGL-0001 or BONG-Q07-025')
      .max(40),
  }),
});

// ─────────────────────────────────────────────
// Bulk address import schemas (v0.7.0) — placed after areaCodeSchema (TDZ)
// Defined at bottom of file.
// ─────────────────────────────────────────────

const entranceIdSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
});

const changeLifecycleSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z.object({
    lifecycle_status: lifecycleSchema,
  }),
});

const bindNfcSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z.object({
    nfc_tag_id: z.string().min(1).max(100),
  }),
});

const nfcTagIdSchema = z.object({
  params: z.object({
    nfcTagId: z.string().min(1).max(100),
  }),
});

// ─────────────────────────────────────────────
// Occupant schemas
// ─────────────────────────────────────────────

const createOccupantSchema = z.object({
  body: z.object({
    entrance_id: z.number().int().positive('entrance_id must be a positive integer'),
    cnic: cnicSchema,
    phone_number: phoneSchema,
    move_in_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'move_in_date must be YYYY-MM-DD').optional(),
  }),
});

// ─────────────────────────────────────────────
// Auth schemas
// ─────────────────────────────────────────────

const loginSchema = z.object({
  body: z.object({
    username: z.string().min(1).max(50),
    password: z.string().min(1).max(200),
  }),
});

// ─────────────────────────────────────────────
// OTP login schemas (v0.10.0)
// ─────────────────────────────────────────────

// Accepts 03XXXXXXXXX / +92XXXXXXXXXX / 92XXXXXXXXXX / 3XXXXXXXXX
// (spaces/dashes/dots/parens andar hote hain to strip ho jate hain — "0345-123-4567" bhi theek)
const pkMobileSchema = z
  .string()
  .transform((s) => s.replace(/[\s\-().]/g, ''))
  .pipe(z.string().regex(/^(?:\+?92|0)?3\d{9}$/, 'Phone Pakistan mobile hona chahiye: 03XXXXXXXXX ya +92XXXXXXXXXX'));

const otpRequestSchema = z.object({
  body: z.object({
    phone: pkMobileSchema,
  }),
});

const otpVerifySchema = z.object({
  body: z.object({
    phone: pkMobileSchema,
    code: z.string().trim().regex(/^\d{6}$/, 'OTP 6 digits ka hota hai'),
  }),
});

const refreshSchema = z.object({
  body: z.object({
    refresh_token: z.string().min(1),
  }),
});

const changePasswordSchema = z.object({
  body: z.object({
    current_password: z.string().min(1),
    new_password: z.string().min(8, 'New password must be at least 8 characters').max(200),
  }),
});

// ─────────────────────────────────────────────
// Admin management schemas
// ─────────────────────────────────────────────

// staffPhoneSchema: PK mobile ya '' ya null (''/null = phone hatao).
// Normalization (+92 canonical) controller mein hoti hai.
const staffPhoneSchema = z.union([pkMobileSchema, z.literal(''), z.null()]).optional();

const createAdminSchema = z.object({
  body: z.object({
    username: z.string().regex(/^[a-z0-9_]{3,30}$/, 'Username: 3-30 chars, lowercase, digits, underscore'),
    password: z.string().min(8, 'Password must be at least 8 characters').max(200).optional(),
    phone: staffPhoneSchema,
    full_name: z.string().max(100).optional(),
    role: roleSchema.default('viewer'),
  }).refine(d => d.password || d.phone, {
    message: 'Password ya phone (OTP login) — kam az kam ek zaroori hai',
  }),
});

const updateAdminSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z.object({
    full_name: z.string().max(100).optional(),
    role: roleSchema.optional(),
    is_active: z.coerce.number().int().min(0).max(1).optional(),
    phone: staffPhoneSchema,
  }).refine(d => d.full_name != null || d.role || d.is_active != null || d.phone !== undefined, {
    message: 'At least one of full_name, role, is_active, or phone must be provided',
  }),
});

const resetPasswordSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z.object({
    new_password: z.string().min(8, 'Password must be at least 8 characters').max(200),
  }),
});

// DELETE /admins/:id — sirf params, body nahi (purane code ne update schema
// reuse kiya tha jiska refine empty body pe hamesha 400 deta tha)
const deleteAdminSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
});

// ─────────────────────────────────────────────
// API key schemas
// ─────────────────────────────────────────────

const createApiKeySchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100),
    scopes: apiKeyScopeSchema.default(['read']),
    env: z.enum(['live', 'test']).optional(),
    expires_at: z.string().datetime().optional(),
  }),
});

const toggleApiKeySchema = z.object({
  params: z.object({
    keyId: z.string().regex(/^sk_(live|test)_[a-f0-9]+$/, 'Invalid API key ID format'),
  }),
  body: z.object({
    is_active: z.coerce.number().int().min(0).max(1),
  }),
});

const apiKeyIdSchema = z.object({
  params: z.object({
    keyId: z.string().regex(/^sk_(live|test)_[a-f0-9]+$/, 'Invalid API key ID format'),
  }),
});

// ─────────────────────────────────────────────
// Audit log schema
// ─────────────────────────────────────────────

const listAuditSchema = z.object({
  query: z.object({
    admin_id: z.coerce.number().int().positive().optional(),
    action: z.string().max(50).optional(),
    resource_type: z.string().max(30).optional(),
    resource_id: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
});

// ─────────────────────────────────────────────
// Area schemas (v0.3.0)
// ─────────────────────────────────────────────

const areaTypeSchema = z.enum(['country', 'province', 'territory', 'division', 'district', 'tehsil', 'village', 'union_council']);

// Area codes are hierarchical: PK, PK-PB, PK-PB-LHR, PK-PB-LHR-KAS, PK-PB-LHR-KAS-PTK, PK-PB-LHR-KAS-PTK-BBG
// Each segment is 1-8 uppercase letters/digits (allows suffixes like -T for tehsil, -BBG for village)
const areaCodeSchema = z.string()
  .regex(/^PK(-[A-Z0-9]{1,8})*$/, 'Area code format: PK or PK-PB or PK-PB-LHR-KAS-PTK-BBG')
  .max(80);

const createAreaSchema = z.object({
  body: z.object({
    area_code: areaCodeSchema,
    name: z.string().min(1).max(100),
    name_urdu: z.string().max(100).optional(),
    type: areaTypeSchema,
    parent_code: areaCodeSchema.nullable().optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    population: z.number().int().positive().optional(),
  }),
});

const updateAreaSchema = z.object({
  params: z.object({
    code: areaCodeSchema,
  }),
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    name_urdu: z.string().max(100).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    population: z.number().int().positive().optional(),
    is_active: z.coerce.number().int().min(0).max(1).optional(),
  }).refine(d => Object.keys(d).length > 0, {
    message: 'At least one field must be provided',
  }),
});

const areaByCodeSchema = z.object({
  params: z.object({
    code: areaCodeSchema,
  }),
});

const areaTypeParamSchema = z.object({
  params: z.object({
    type: areaTypeSchema,
  }),
});

const listAreasSchema = z.object({
  query: z.object({
    type: areaTypeSchema.optional(),
    parent: z.string().max(60).optional(),
    q: z.string().max(100).optional(),
    active: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
});

const reverseGeocodeSchema = z.object({
  query: z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
  }),
});

const seedAreasSchema = z.object({
  body: z.object({
    areas: z.array(z.object({
      area_code: areaCodeSchema,
      name: z.string().min(1).max(100),
      name_urdu: z.string().max(100).optional(),
      type: areaTypeSchema,
      parent_code: areaCodeSchema.nullable().optional(),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      population: z.number().int().positive().optional(),
    })).min(1).max(10000),
  }),
});

const assignAreaSchema = z.object({
  params: z.object({
    code: z.string().regex(/^[A-Z]{3}-\d{4,}$/, 'Short code must look like BGL-0001'),
  }),
  body: z.object({
    area_codes: z.array(areaCodeSchema).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    assigned_by: z.enum(['auto', 'admin', 'manual']).optional(),
  }).refine(d => d.area_codes || (d.lat != null && d.lng != null), {
    message: 'Either area_codes array or (lat + lng) must be provided',
  }),
});

// ─────────────────────────────────────────────
// Village Boundary schemas (v0.4.2)
// ─────────────────────────────────────────────

const geoJsonPointSchema = z.tuple([z.number(), z.number()]); // [lat, lng]

const geoJsonPolygonSchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(geoJsonPointSchema).min(4)),
});

const blocksConfigSchema = z.object({
  A: z.enum(['NE', 'SE', 'SW', 'NW']),
  B: z.enum(['NE', 'SE', 'SW', 'NW']),
  C: z.enum(['NE', 'SE', 'SW', 'NW']),
  D: z.enum(['NE', 'SE', 'SW', 'NW']),
}).refine(d => {
  const vals = Object.values(d);
  return new Set(vals).size === 4; // all 4 quadrants unique
}, { message: 'Each block must map to a unique quadrant' });

const createBoundarySchema = z.object({
  body: z.object({
    area_code: areaCodeSchema,
    name: z.string().min(1).max(100),
    polygon: geoJsonPolygonSchema,
    blocksConfig: blocksConfigSchema.optional(),
  }),
});

const boundaryByAreaCodeSchema = z.object({
  params: z.object({
    areaCode: areaCodeSchema,
  }),
});

const detectBlockSchema = z.object({
  query: z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
  }),
});

// Bulk import: SHAPE-level validation only (array of objects, ≤5000).
// Per-row semantic validation (GPS ranges, village resolution) happens in
// the controller with bulkImportRowSchema.safeParse — invalid rows are
// skipped and reported individually instead of rejecting the whole batch.
const bulkImportRowSchema = z.object({
  village_code: z.string().min(1).max(80),
  gps_lat: z.coerce.number(),
  gps_long: z.coerce.number(),
  display_name: z.string().min(1).max(100).optional(),
  house_number: z.string().min(1).max(10).optional(),
  property_type: propertyTypeSchema.optional(),
});

const bulkImportRowStrictSchema = bulkImportRowSchema.extend({
  village_code: areaCodeSchema,
  gps_lat: latSchema,
  gps_long: lngSchema,
});

const bulkImportSchema = z.object({
  body: z.object({
    rows: z.array(z.record(z.any())).min(1).max(5000),
  }),
});

// ─────────────────────────────────────────────
// Mashwara Box (v0.10.7) — public suggestions + area lock
// ─────────────────────────────────────────────

const suggestionTypeSchema = z.enum([
  'ghar',    // ghar/makan ki pehchan (landmark, rang, size)
  'gali',    // gali/street ki maloomat
  'entry',   // entry point (raasta, mor, pull)
  'naam',    // gaon/gali ka naam correction ya suggestion
  'sarhad',  // sarhad/boundary ki maloomat
  'deegar',  // deegar (koi aur cheez)
]);

const suggestionStatusSchema = z.enum(['new', 'reviewed', 'accepted', 'rejected']);

// Public village search — q min 2 chars taake 146k villages par full-scan
// spam na ho; LIKE prefix pattern SQL mein escape hota hai (controller).
const villageSearchSchema = z.object({
  query: z.object({
    q: z.string().min(2, 'Search query must be at least 2 characters').max(60),
    limit: z.coerce.number().int().min(1).max(20).optional().default(10),
  }),
});

// Public suggestion create — multipart (photo optional). GPS/phone optional.
// body: free text detail (min 5 — "salam" jaisi spam filter ho), max 2000.
const createSuggestionSchema = z.object({
  body: z.object({
    village_code: z.string().min(6).max(80),
    type: suggestionTypeSchema,
    body: z.string().min(5, 'Detail likhna zaroori hai (min 5 chars)').max(2000),
    title: z.string().max(120).optional(),
    gps_lat: z.coerce.number().min(-90).max(90).optional(),
    gps_lng: z.coerce.number().min(-180).max(180).optional(),
    contact_phone: z.string().max(20).optional(),
  }),
});

const listSuggestionsSchema = z.object({
  query: z.object({
    status: suggestionStatusSchema.optional(),
    type: suggestionTypeSchema.optional(),
    village_code: z.string().min(1).max(80).optional(),
    q: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    offset: z.coerce.number().int().min(0).optional().default(0),
  }),
});

const updateSuggestionSchema = z.object({
  params: z.object({ id: z.string().min(3).max(64) }),
  body: z.object({
    status: suggestionStatusSchema.optional(),
    admin_note: z.string().max(1000).optional(),
  }),
});

const suggestionIdSchema = z.object({
  params: z.object({ id: z.string().min(3).max(64) }),
});

// Area lock/unlock — koi body nahi (admin identity JWT se aati hai)
const areaLockSchema = z.object({
  params: z.object({ code: z.string().min(1).max(80) }),
});

module.exports = {
  // Shared
  latSchema, lngSchema, cnicSchema, phoneSchema,
  propertyTypeSchema, lifecycleSchema, roleSchema, apiKeyScopeSchema,

  // Address
  createAddressSchema, addressByCodeSchema, updateAddressSchema,
  upgradeTierSchema, listAddressesSchema, radiusSearchSchema,

  // Public lookup (v0.7.0)
  publicAddressCodeSchema,

  // Bulk import (v0.7.0)
  bulkImportSchema, bulkImportRowSchema, bulkImportRowStrictSchema,

  // Entrance
  entranceIdSchema, changeLifecycleSchema, bindNfcSchema, nfcTagIdSchema,

  // Occupant
  createOccupantSchema,

  // Auth
  loginSchema, refreshSchema, changePasswordSchema,

  // OTP login (v0.10.0)
  otpRequestSchema, otpVerifySchema, pkMobileSchema, staffPhoneSchema,

  // Admin
  createAdminSchema, updateAdminSchema, deleteAdminSchema, resetPasswordSchema,

  // API Key
  createApiKeySchema, toggleApiKeySchema, apiKeyIdSchema,

  // Audit
  listAuditSchema,

  // Areas (v0.3.0)
  areaTypeSchema, areaCodeSchema,
  createAreaSchema, updateAreaSchema, areaByCodeSchema, areaTypeParamSchema,
  listAreasSchema, reverseGeocodeSchema, seedAreasSchema, assignAreaSchema,

  // Village Boundaries (v0.4.2)
  geoJsonPolygonSchema, blocksConfigSchema,
  createBoundarySchema, boundaryByAreaCodeSchema, detectBlockSchema,

  // Mashwara Box (v0.10.7)
  suggestionTypeSchema, suggestionStatusSchema,
  villageSearchSchema, createSuggestionSchema,
  listSuggestionsSchema, updateSuggestionSchema, suggestionIdSchema,
  areaLockSchema,
};
