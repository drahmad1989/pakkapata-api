/**
 * GeoPata — Zod validation middleware
 *
 * Usage:
 *   router.post('/', validate(createAddressSchema), controller.create);
 *
 * - Validates req.body / req.query / req.params against a Zod schema.
 * - Coerces types (e.g. ?lat=31.5 string → 31.5 number).
 * - Replaces req objects with parsed values so downstream code sees clean data.
 * - On failure, returns 400 with a flattened error description.
 */

/**
 * @param {import('zod').ZodObject<any>} schema
 */
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({
      body: req.body,
      query: req.query,
      params: req.params,
    });

    if (!result.success) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Request failed validation',
        details: result.error.flatten(),
      });
    }

    // Replace req fields with parsed/coerced versions
    if (result.data.body) req.body = result.data.body;
    if (result.data.query) req.query = result.data.query;
    if (result.data.params) req.params = result.data.params;

    next();
  };
}

module.exports = validate;
