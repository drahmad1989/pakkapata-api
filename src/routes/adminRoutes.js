/**
 * GeoPata — Admin Routes (v0.2.1)
 * Mounted at: /api/admin
 * All routes require JWT + admin role.
 *
 *   === Admins ===
 *   GET    /admins                    — list all admins
 *   POST   /admins                    — create admin
 *   PUT    /admins/:id                — update admin (full_name, role, is_active)
 *   DELETE /admins/:id                — delete admin
 *   POST   /admins/:id/reset-password — reset admin password
 *
 *   === API Keys ===
 *   GET    /api-keys                  — list all API keys
 *   POST   /api-keys                  — create API key (returns full key ONCE)
 *   POST   /api-keys/rabtachat-setup  — 1-click RabtaChat key + .env block (v0.10.1)
 *   PATCH  /api-keys/:keyId           — activate/revoke API key
 *   DELETE /api-keys/:keyId           — delete API key
 *
 *   === Audit Log ===
 *   GET    /audit                     — query audit log with filters
 *
 *   === Export ===
 *   GET    /export.csv                — download addresses as CSV
 *   GET    /export.json               — download addresses as JSON
 */

const express = require('express');
const router = express.Router();

const validate = require('../middleware/validate');
const { authenticateJwt, requireRole } = require('../middleware/auth');
const {
  createAdminSchema, updateAdminSchema, deleteAdminSchema, resetPasswordSchema,
  createApiKeySchema, toggleApiKeySchema, apiKeyIdSchema,
  listAuditSchema,
  listSuggestionsSchema, updateSuggestionSchema, suggestionIdSchema,
} = require('../schemas');
const controller = require('../controllers/adminController');
const exportController = require('../controllers/exportController');
const suggestionController = require('../controllers/suggestionController');

// All admin routes require JWT + admin role
router.use(authenticateJwt, requireRole('admin'));

// ─────────────────────────────────────────────
// Admins
// ─────────────────────────────────────────────
router.get('/admins', controller.listAdmins);
router.post('/admins', validate(createAdminSchema), controller.createAdmin);
router.put('/admins/:id', validate(updateAdminSchema), controller.updateAdmin);
router.delete('/admins/:id', validate(deleteAdminSchema), controller.deleteAdmin);
router.post('/admins/:id/reset-password', validate(resetPasswordSchema), controller.resetPassword);

// ─────────────────────────────────────────────
// API Keys
// ─────────────────────────────────────────────
router.get('/api-keys', controller.listApiKeys);
router.post('/api-keys', validate(createApiKeySchema), controller.createApiKey);
// v0.10.1: RabtaChat one-click setup — purana key revoke + naya read+write key
// + ready-to-paste .env block. Admin panel ka "1-Click Setup" button isi ko hit karta hai.
// v0.10.2: setup ab RabtaChat ke .env mein KHUD likhta hai (backup + verify ke sath);
// GET /status diagnosis deta hai (verdict engine — koi secret nahi).
router.post('/api-keys/rabtachat-setup', controller.rabtachatSetup);
router.get('/api-keys/rabtachat-setup/status', controller.rabtachatStatus);
// v0.10.5: live RabtaChat health ping (link checklist step-4)
router.get('/api-keys/rabtachat-setup/ping', controller.rabtachatPing);
router.patch('/api-keys/:keyId', validate(toggleApiKeySchema), controller.toggleApiKey);
router.delete('/api-keys/:keyId', validate(apiKeyIdSchema), controller.deleteApiKey);

// ─────────────────────────────────────────────
// Audit Log
// ─────────────────────────────────────────────
router.get('/audit', validate(listAuditSchema), controller.listAudit);

// ─────────────────────────────────────────────
// Mashwara Box — suggestions review (v0.10.7)
// ─────────────────────────────────────────────
router.get('/suggestions', validate(listSuggestionsSchema), suggestionController.listSuggestions);
router.get('/suggestions/stats', suggestionController.suggestionStats);
// NOTE: /export MUST be registered before any :id route pattern conflicts
router.get('/suggestions/export', suggestionController.exportSuggestions);
router.patch('/suggestions/:id', validate(updateSuggestionSchema), suggestionController.updateSuggestion);
router.delete('/suggestions/:id', validate(suggestionIdSchema), suggestionController.deleteSuggestion);

// ─────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────
router.get('/export.csv', exportController.exportCsv);
router.get('/export.json', exportController.exportJson);

module.exports = router;
