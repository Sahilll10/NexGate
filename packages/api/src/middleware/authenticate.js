/**
 * NexGate Management API — JWT Auth Middleware
 */

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'AUTHENTICATION_REQUIRED',
      message: 'Bearer token required in Authorization header',
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.sub;
    req.userRole = decoded.role;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'TOKEN_EXPIRED', message: 'Token has expired. Please refresh.' });
    }
    return res.status(401).json({ error: 'INVALID_TOKEN', message: 'Token is invalid or malformed' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.userRole || !roles.includes(req.userRole)) {
      return res.status(403).json({
        error: 'INSUFFICIENT_PERMISSIONS',
        message: `This action requires one of: ${roles.join(', ')}`,
      });
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
