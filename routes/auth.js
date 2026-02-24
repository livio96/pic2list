const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db');
const router = express.Router();

const SALT_ROUNDS = 12;

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  const { first_name, last_name, company_name, username, password } = req.body;
  if (!first_name || !last_name || !username || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username.trim()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await pool.query(
      `INSERT INTO users (first_name, last_name, company_name, username, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, 'admin') RETURNING id, first_name, last_name, username, role`,
      [first_name.trim(), last_name.trim(), company_name?.trim() || null, username.trim(), hash]
    );
    const userId = result.rows[0].id;
    // Set account_id = own id (account owner)
    await pool.query('UPDATE users SET account_id = $1 WHERE id = $1', [userId]);

    req.session.userId = userId;
    req.session.role = 'admin';
    req.session.accountId = userId;
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Missing credentials' });
  }
  try {
    const result = await pool.query(
      'SELECT id, first_name, last_name, username, password_hash, role, account_id FROM users WHERE username = $1',
      [username.trim()]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.accountId = user.account_id;
    res.json({ success: true, user: { id: user.id, first_name: user.first_name, last_name: user.last_name, username: user.username, role: user.role } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// GET /api/auth/me
router.get('/me', async (req, res) => {
  if (req.session && req.session.userId) {
    try {
      const result = await pool.query(
        'SELECT first_name, role, account_id FROM users WHERE id = $1',
        [req.session.userId]
      );
      const user = result.rows[0];
      return res.json({
        authenticated: true,
        userId: req.session.userId,
        firstName: user?.first_name || '',
        role: user?.role || req.session.role || 'admin',
        accountId: user?.account_id || req.session.accountId,
      });
    } catch (err) {
      return res.json({ authenticated: true, userId: req.session.userId, firstName: '', role: req.session.role || 'admin' });
    }
  }
  res.json({ authenticated: false });
});

module.exports = router;
