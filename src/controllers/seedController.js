/**
 * GeoPata — Seed Controller (v0.9.0)
 *
 * Dashboard-facing endpoints for the Pakistan map seeder.
 * All routes are admin-only (mounted with authenticateJwt + requireRole('admin')).
 *
 *   POST /api/admin/seed-pakistan          — start background seed job
 *   GET  /api/admin/seed-pakistan/status   — live job progress
 *   POST /api/admin/seed-pakistan/cancel   — cancel running job
 *   GET  /api/admin/seed-pakistan/stats    — current DB counts + data file status
 */

const audit = require('../services/auditService');
const seedService = require('../services/pakistanSeedService');

/**
 * POST /api/admin/seed-pakistan
 * Body: {
 *   dry_run?: boolean,
 *   province?: '02'|'03'|'04'|'05'|'06'|'07'|'08',
 *   limit?: number,
 *   boundary_min_pop?: number
 * }
 * Returns 202 with the job snapshot immediately; progress via /status.
 */
function startSeed(req, res) {
  const job = seedService.startSeedJob(
    {
      dry_run: req.body.dry_run,
      province: req.body.province,
      limit: req.body.limit,
      boundary_min_pop: req.body.boundary_min_pop,
    },
    req.auth.adminId
  );

  audit.log({
    adminId: req.auth.adminId,
    action: job.dry_run ? 'SEED_PAKISTAN_PREVIEW' : 'SEED_PAKISTAN_START',
    resourceType: 'area',
    resourceId: job.job_id,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
    details: { options: job.options, dry_run: job.dry_run },
  });

  return res.status(202).json({
    message: job.dry_run
      ? 'Dry run queued — progress: GET /api/admin/seed-pakistan/status'
      : 'Seed job queued — progress: GET /api/admin/seed-pakistan/status',
    data: job,
  });
}

/**
 * GET /api/admin/seed-pakistan/status
 */
function getStatus(_req, res) {
  return res.json({ data: seedService.getJobStatus() });
}

/**
 * POST /api/admin/seed-pakistan/cancel
 */
function cancelSeed(req, res) {
  const job = seedService.requestCancel();
  audit.log({
    adminId: req.auth.adminId,
    action: 'SEED_PAKISTAN_CANCEL',
    resourceType: 'area',
    resourceId: job.job_id,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
  });
  return res.json({ message: 'Cancellation requested', data: job });
}

/**
 * GET /api/admin/seed-pakistan/stats
 */
function getStats(_req, res) {
  return res.json({ data: seedService.getSeedStats() });
}

module.exports = { startSeed, getStatus, cancelSeed, getStats };
