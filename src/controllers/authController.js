/**
 * GeoPata — Auth Controller
 *
 * Endpoints for admin login, token refresh, profile, and password change.
 * All routes mounted at /api/auth
 */

const db = require('../config/database');
const { prepare } = db;
const { HttpError } = require('../middleware/errorHandler');
const audit = require('../services/auditService');
const { hashPassword, comparePassword } = require('../services/authService');
const {
  signAccessToken,
  signRefreshToken,
  verifyToken,
} = require('../services/jwtService');
const {
  issueOtp,
  verifyOtp,
  deliverOtp,
  normalizePkPhone,
  maskPhone,
} = require('../services/otpService');
const { getClientIp } = require('../middleware/auth');

// OTP_DEBUG=1 → response mein dev_code bhi aata hai (sirf testing ke liye).
// Production mein ye env kabhi set na karein.
const OTP_DEBUG = process.env.OTP_DEBUG === '1';

// ─────────────────────────────────────────────
// POST /api/auth/login
// Body: { username, password }
// ─────────────────────────────────────────────
function login(req, res) {
  const { username, password } = req.body;

  const admin = prepare(`
    SELECT admin_id, username, password_hash, full_name, role, is_active, last_login_at
    FROM admins WHERE username = ?
  `).get(username);
  if (!admin || !admin.is_active) {
    throw new HttpError(401, 'Invalid username or password', 'INVALID_CREDENTIALS');
  }

  if (!comparePassword(password, admin.password_hash)) {
    throw new HttpError(401, 'Invalid username or password', 'INVALID_CREDENTIALS');
  }

  // Update last login
  prepare('UPDATE admins SET last_login_at = CURRENT_TIMESTAMP WHERE admin_id = ?')
    .run(admin.admin_id);

  const payload = { adminId: admin.admin_id, username: admin.username, role: admin.role };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);

  audit.log({
    adminId: admin.admin_id,
    action: 'LOGIN',
    resourceType: 'admin',
    resourceId: admin.admin_id,
    ipAddress: req.auth?.ipAddress,
    userAgent: req.auth?.userAgent,
    details: { username: admin.username, role: admin.role },
  });

  return res.json({
    message: 'Login successful',
    data: {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: 900,
      admin: {
        admin_id: admin.admin_id,
        username: admin.username,
        full_name: admin.full_name,
        role: admin.role,
      },
    },
  });
}

// ─────────────────────────────────────────────
// POST /api/auth/otp/request  (v0.10.0)
// Body: { phone }  — field staff OTP login, step 1
// ─────────────────────────────────────────────
function otpRequest(req, res) {
  const phone = normalizePkPhone(req.body.phone);
  if (!phone) {
    throw new HttpError(400, 'Phone format ghalat hai. Example: 03001234567', 'PHONE_INVALID');
  }

  const { code, expires_in } = issueOtp(phone, getClientIp(req));
  const masked = maskPhone(phone);
  deliverOtp(phone, code, masked); // SMS gateway aane tak console pe

  audit.log({
    action: 'OTP_REQUEST',
    resourceType: 'admin',
    resourceId: null,
    ipAddress: getClientIp(req),
    userAgent: req.headers['user-agent'] || null,
    details: { phone_masked: masked },
  });

  const data = {
    phone_masked: masked,
    expires_in,
    delivery: 'console', // 'sms' jab gateway jud jaye
  };
  if (OTP_DEBUG) data.dev_code = code;

  return res.json({
    message: 'OTP generate ho gaya — backend console (bat window) mein code likha aayega. 5 min valid.',
    data,
  });
}

// ─────────────────────────────────────────────
// POST /api/auth/otp/verify  (v0.10.0)
// Body: { phone, code }  — step 2; same token shape as /login
// ─────────────────────────────────────────────
function otpVerify(req, res) {
  const phone = normalizePkPhone(req.body.phone);
  if (!phone) {
    throw new HttpError(400, 'Phone format ghalat hai. Example: 03001234567', 'PHONE_INVALID');
  }

  // Code burn hota hai chahe account na mile — replay/reuse impossible
  verifyOtp(phone, req.body.code);

  const staff = prepare(`
    SELECT admin_id, username, full_name, role, is_active
    FROM admins WHERE phone = ?
  `).get(phone);
  if (!staff || !staff.is_active) {
    throw new HttpError(
      401,
      'Is phone number pe koi active staff account nahi. Admin se rabta karein.',
      'OTP_NO_ACCOUNT'
    );
  }

  prepare('UPDATE admins SET last_login_at = CURRENT_TIMESTAMP WHERE admin_id = ?')
    .run(staff.admin_id);

  const payload = { adminId: staff.admin_id, username: staff.username, role: staff.role };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);

  audit.log({
    adminId: staff.admin_id,
    action: 'LOGIN_OTP',
    resourceType: 'admin',
    resourceId: staff.admin_id,
    ipAddress: getClientIp(req),
    userAgent: req.headers['user-agent'] || null,
    details: { phone_masked: maskPhone(phone), role: staff.role },
  });

  return res.json({
    message: 'Login successful',
    data: {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: 900,
      admin: {
        admin_id: staff.admin_id,
        username: staff.username,
        full_name: staff.full_name,
        role: staff.role,
      },
    },
  });
}

// ─────────────────────────────────────────────
// POST /api/auth/refresh
// Body: { refresh_token }
// ─────────────────────────────────────────────
function refresh(req, res) {
  const { refresh_token } = req.body;
  if (!refresh_token) {
    throw new HttpError(400, 'refresh_token is required', 'VALIDATION_ERROR');
  }

  let decoded;
  try {
    decoded = verifyToken(refresh_token, 'refresh');
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new HttpError(401, 'Refresh token expired. Please login again.', 'TOKEN_EXPIRED');
    }
    throw new HttpError(401, 'Invalid refresh token', 'TOKEN_INVALID');
  }

  const admin = prepare(`
    SELECT admin_id, username, full_name, role, is_active, last_login_at, created_at
    FROM admins WHERE admin_id = ?
  `).get(decoded.adminId);
  if (!admin || !admin.is_active) {
    throw new HttpError(401, 'Account no longer active', 'ACCOUNT_INACTIVE');
  }

  const payload = { adminId: admin.admin_id, username: decoded.username, role: admin.role };
  const accessToken = signAccessToken(payload);

  return res.json({
    message: 'Token refreshed',
    data: {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 900,
    },
  });
}

// ─────────────────────────────────────────────
// POST /api/auth/logout
// ─────────────────────────────────────────────
function logout(req, res) {
  audit.log({
    adminId: req.auth?.adminId,
    action: 'LOGOUT',
    resourceType: 'admin',
    resourceId: req.auth?.adminId,
    ipAddress: req.auth?.ipAddress,
    userAgent: req.auth?.userAgent,
  });
  return res.json({ message: 'Logged out. Please discard your tokens.' });
}

// ─────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────
function me(req, res) {
  const admin = prepare(`
    SELECT admin_id, username, full_name, role, is_active, last_login_at, created_at
    FROM admins WHERE admin_id = ?
  `).get(req.auth.adminId);
  if (!admin) {
    throw new HttpError(404, 'Admin not found', 'ADMIN_NOT_FOUND');
  }
  return res.json({ data: admin });
}

// ─────────────────────────────────────────────
// PUT /api/auth/password
// Body: { current_password, new_password }
// ─────────────────────────────────────────────
function changePassword(req, res) {
  const { current_password, new_password } = req.body;

  const admin = prepare('SELECT password_hash FROM admins WHERE admin_id = ?')
    .get(req.auth.adminId);
  if (!admin) {
    throw new HttpError(404, 'Admin not found', 'ADMIN_NOT_FOUND');
  }

  if (!comparePassword(current_password, admin.password_hash)) {
    throw new HttpError(401, 'Current password is incorrect', 'INVALID_CREDENTIALS');
  }

  if (new_password.length < 8) {
    throw new HttpError(400, 'New password must be at least 8 characters', 'VALIDATION_ERROR');
  }

  const newHash = hashPassword(new_password);
  prepare('UPDATE admins SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE admin_id = ?')
    .run(newHash, req.auth.adminId);

  audit.log({
    adminId: req.auth.adminId,
    action: 'CHANGE_PASSWORD',
    resourceType: 'admin',
    resourceId: req.auth.adminId,
    ipAddress: req.auth.ipAddress,
    userAgent: req.auth.userAgent,
  });

  return res.json({ message: 'Password updated successfully' });
}

module.exports = {
  login,
  otpRequest,
  otpVerify,
  refresh,
  logout,
  me,
  changePassword,
};
