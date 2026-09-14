/**
 * GeoPata — Error handling middleware
 *
 * Provides:
 *   - HttpError       : throw this from controllers for explicit HTTP status
 *   - notFound        : 404 handler for unknown routes
 *   - errorHandler    : last-resort error formatter
 *
 * errorHandler translates:
 *   - HttpError            → its own status + code
 *   - SQLite UNIQUE violation → 409 Conflict
 *   - SQLite FK violation     → 400 Bad Request
 *   - ZodError                → 400 with details (shouldn't happen if validate middleware runs)
 *   - everything else         → 500 (logs full stack; hides message in prod)
 */

/**
 * Throw from controllers when you know the HTTP status you want.
 */
class HttpError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} message Human-readable message
   * @param {string} [code='HTTP_ERROR'] Machine code for frontend
   */
  constructor(status, message, code = 'HTTP_ERROR') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }

  static badRequest(msg, code = 'BAD_REQUEST') {
    return new HttpError(400, msg, code);
  }
  static notFound(msg = 'Not found', code = 'NOT_FOUND') {
    return new HttpError(404, msg, code);
  }
  static conflict(msg, code = 'CONFLICT') {
    return new HttpError(409, msg, code);
  }
}

/**
 * 404 handler — registered AFTER all routes.
 */
function notFound(req, res, _next) {
  res.status(404).json({
    error: 'NOT_FOUND',
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
}

/**
 * Global error handler — registered last.
 * Express requires (err, req, res, next) signature even if next is unused.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  // Log full error for server-side debugging
  // eslint-disable-next-line no-console
  console.error(`[error] ${err.code || err.name || 'INTERNAL'}: ${err.message}`);

  // Explicit HttpError from controllers
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: err.code,
      message: err.message,
    });
  }

  // SQLite errors — map to appropriate status
  if (err.code && err.code.startsWith('SQLITE_')) {
    let status = 500;
    let responseCode = err.code;

    // better-sqlite3 may surface these as code or in the message
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE/i.test(err.message)) {
      status = 409;
      responseCode = 'DUPLICATE_RESOURCE';
    } else if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || /FOREIGN KEY/i.test(err.message)) {
      status = 400;
      responseCode = 'INVALID_REFERENCE';
    } else if (err.code === 'SQLITE_CONSTRAINT_CHECK') {
      status = 400;
      responseCode = 'CONSTRAINT_VIOLATION';
    }

    return res.status(status).json({
      error: responseCode,
      message: err.message,
    });
  }

  // ZodError (rare — usually caught by validate middleware)
  if (err.name === 'ZodError') {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Request failed validation',
      details: err.flatten(),
    });
  }

  // Default: 500 — don't leak internal message in production
  const isProd = process.env.NODE_ENV === 'production';
  return res.status(err.status || 500).json({
    error: err.code || 'INTERNAL_ERROR',
    message: isProd ? 'An unexpected error occurred' : err.message,
  });
}

module.exports = {
  HttpError,
  notFound,
  errorHandler,
};
