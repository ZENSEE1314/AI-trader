const jwt = require('jsonwebtoken');

if (!process.env.JWT_SECRET) {
  console.warn('[AUTH] WARNING: JWT_SECRET not set — using insecure default. Set JWT_SECRET env var in production!');
}
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

function authMiddleware(req, res, next) {
  const token = req.cookies?.token;
  
  // Debug logging
  console.log(`[AUTH] Path: ${req.path}, Has token: ${!!token}, JWT_SECRET set: ${!!process.env.JWT_SECRET}`);
  
  if (!token) {
    console.log('[AUTH] No token found, returning 401');
    return res.status(401).json({ error: 'Not logged in' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userEmail = decoded.email;
    console.log(`[AUTH] User authenticated: ${decoded.email} (ID: ${decoded.userId})`);
    next();
  } catch (err) {
    console.log(`[AUTH] Token verification failed: ${err.message}`);
    res.clearCookie('token');
    return res.status(401).json({ error: 'Session expired' });
  }
}

function signToken(userId, email, remember = true) {
  return jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: remember ? '30d' : '1d' });
}

module.exports = { authMiddleware, signToken, JWT_SECRET };
