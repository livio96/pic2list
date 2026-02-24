const pool = require('../db');
const { decrypt } = require('../crypto-utils');

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.redirect('/login.html');
}

function requireRole(...roles) {
  return (req, res, next) => {
    const userRole = req.session && req.session.role;
    if (!userRole || !roles.includes(userRole)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

async function loadUserConfig(req, res, next) {
  if (!req.session || !req.session.userId) return next();
  try {
    const result = await pool.query(
      `SELECT u.role, u.account_id,
              owner.ebay_token, owner.ebay_client_id, owner.ebay_client_secret
       FROM users u
       JOIN users owner ON owner.id = u.account_id
       WHERE u.id = $1`,
      [req.session.userId]
    );
    if (result.rows.length === 0) {
      req.session.destroy();
      return res.status(401).json({ error: 'User not found' });
    }
    const row = result.rows[0];
    req.userConfig = {
      ebayToken:        decrypt(row.ebay_token) || '',
      ebayClientId:     decrypt(row.ebay_client_id) || '',
      ebayClientSecret: decrypt(row.ebay_client_secret) || '',
    };
    // Refresh session role/accountId from DB in case admin changed it
    if (row.role !== req.session.role) {
      req.session.role = row.role;
    }
    if (row.account_id !== req.session.accountId) {
      req.session.accountId = row.account_id;
    }
    next();
  } catch (err) {
    console.error('loadUserConfig error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { requireAuth, requireRole, loadUserConfig };
