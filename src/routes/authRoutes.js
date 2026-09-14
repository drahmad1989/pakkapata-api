/**
 * GeoPata — Auth Routes
 * Mounted at: /api/auth
 *
 *   POST   /login            → login (public)
 *   POST   /otp/request      → phone OTP request (v0.10.0, public)
 *   POST   /otp/verify       → phone OTP verify → tokens (v0.10.0, public)
 *   POST   /refresh          → refresh access token (public, needs refresh_token in body)
 *   POST   /logout           → logout (JWT required, just logs the event)
 *   GET    /me               → current user profile (JWT required)
 *   PUT    /password         → change own password (JWT required)
 */

const express = require('express');
const router = express.Router();

const validate = require('../middleware/validate');
const { loginSchema, refreshSchema, changePasswordSchema, otpRequestSchema, otpVerifySchema } = require('../schemas');
const { authenticateJwt } = require('../middleware/auth');
const controller = require('../controllers/authController');

router.post('/login', validate(loginSchema), controller.login);
router.post('/otp/request', validate(otpRequestSchema), controller.otpRequest);
router.post('/otp/verify', validate(otpVerifySchema), controller.otpVerify);
router.post('/refresh', validate(refreshSchema), controller.refresh);
router.post('/logout', authenticateJwt, controller.logout);
router.get('/me', authenticateJwt, controller.me);
router.put('/password', authenticateJwt, validate(changePasswordSchema), controller.changePassword);

module.exports = router;
