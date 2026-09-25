const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'please-change-this-to-a-long-random-secret-string';
const TOKEN_EXPIRES_IN = '12h';

function signToken(employee) {
  return jwt.sign(
    {
      id: employee.id,
      employee_code: employee.employee_code,
      name: employee.name,
      last_name: employee.last_name || null,
      first_name: employee.first_name || null,
      role: employee.role,
      division: employee.division || null,
    },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRES_IN }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: '認証が必要です。再度ログインしてください。' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'セッションが無効です。再度ログインしてください。' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: '管理者権限が必要です。' });
  }
  next();
}

module.exports = { signToken, requireAuth, requireAdmin, JWT_SECRET };
