const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

function authMiddleware(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userEmail = decoded.email;
    next();
  } catch {
    res.clearCookie('token');
    return res.status(401).json({ error: 'Session expired' });
  }
}

function signToken(userId, email, remember = true) {
  return jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: remember ? '30d' : '1d' });
}

module.exports = { authMiddleware, signToken, JWT_SECRET };
