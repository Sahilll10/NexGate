/**
 * NexGate Management API — Authentication Routes
 * JWT-based authentication for the developer portal.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const router = express.Router();

// Admin user model (inline for simplicity — separate collection from teams)
const adminUserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  passwordHash: { type: String, required: true },
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
  role: { type: String, enum: ['admin', 'member', 'viewer'], default: 'member' },
  isActive: { type: Boolean, default: true },
  lastLoginAt: { type: Date },
}, { timestamps: true });

const AdminUser = mongoose.models.AdminUser || mongoose.model('AdminUser', adminUserSchema);

function signToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',
  });
}

function signRefreshToken(userId) {
  return jwt.sign({ sub: userId, type: 'refresh' }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  });
}

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'EMAIL_AND_PASSWORD_REQUIRED' });
    }

    const user = await AdminUser.findOne({ email: email.toLowerCase(), isActive: true });
    if (!user) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    }

    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    }

    await AdminUser.findByIdAndUpdate(user._id, { lastLoginAt: new Date() });

    const token = signToken(user._id);
    const refreshToken = signRefreshToken(user._id);

    res.json({
      token,
      refreshToken,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        teamId: user.teamId,
      },
    });
  } catch (err) {
    console.error('[Auth/login]', err);
    res.status(500).json({ error: 'LOGIN_FAILED' });
  }
});

// POST /auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'REFRESH_TOKEN_REQUIRED' });

    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
    if (decoded.type !== 'refresh') return res.status(401).json({ error: 'INVALID_REFRESH_TOKEN' });

    const user = await AdminUser.findById(decoded.sub).select('_id email role teamId isActive');
    if (!user || !user.isActive) return res.status(401).json({ error: 'USER_NOT_FOUND' });

    const token = signToken(user._id);
    res.json({ token });
  } catch (err) {
    res.status(401).json({ error: 'INVALID_REFRESH_TOKEN' });
  }
});

// POST /auth/register (admin only — or first user setup)
router.post('/register', async (req, res) => {
  try {
    const { email, password, teamId, role } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'EMAIL_AND_PASSWORD_REQUIRED' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'PASSWORD_TOO_SHORT', message: 'Password must be at least 8 characters' });
    }

    const existing = await AdminUser.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: 'EMAIL_ALREADY_EXISTS' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await AdminUser.create({
      email: email.toLowerCase(),
      passwordHash,
      teamId,
      role: role || 'member',
    });

    res.status(201).json({
      user: { id: user._id, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error('[Auth/register]', err);
    res.status(500).json({ error: 'REGISTRATION_FAILED' });
  }
});

// GET /auth/me
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'TOKEN_REQUIRED' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await AdminUser.findById(decoded.sub)
      .select('-passwordHash')
      .populate('teamId', 'name slug');

    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

    res.json({ user });
  } catch (err) {
    res.status(401).json({ error: 'INVALID_TOKEN' });
  }
});

module.exports = { router, AdminUser };
