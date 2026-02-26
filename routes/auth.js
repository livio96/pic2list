const express = require('express');
const bcrypt = require('bcrypt');
const { Resend } = require('resend');
const pool = require('../db');
const router = express.Router();

const SALT_ROUNDS = 12;

// Fire-and-forget notification to admin
function notifyAdmin(userEmail, event) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  resend.emails.send({
    from: 'LazyListings <noreply@lazylistings.com>',
    to: 'liviob@live.com',
    subject: `LazyListings — ${event}`,
    html: `<p><strong>${userEmail}</strong> just ${event === 'New Signup' ? 'signed up' : 'logged in'}.</p>`,
  }).catch(err => console.error('Admin notify error:', err));
}

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  const { first_name, last_name, company_name, email, password } = req.body;
  if (!first_name || !last_name || !email || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email.trim())) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await pool.query(
      `INSERT INTO users (first_name, last_name, company_name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, 'admin') RETURNING id, first_name, last_name, email, role`,
      [first_name.trim(), last_name.trim(), company_name?.trim() || null, email.trim().toLowerCase(), hash]
    );
    const userId = result.rows[0].id;
    // Set account_id = own id (account owner)
    await pool.query('UPDATE users SET account_id = $1 WHERE id = $1', [userId]);

    req.session.userId = userId;
    req.session.role = 'admin';
    req.session.accountId = userId;
    notifyAdmin(email.trim().toLowerCase(), 'New Signup');
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing credentials' });
  }
  try {
    const result = await pool.query(
      'SELECT id, first_name, last_name, email, password_hash, role, account_id FROM users WHERE email = $1',
      [email.trim().toLowerCase()]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.accountId = user.account_id;
    notifyAdmin(user.email, 'Login');
    res.json({ success: true, user: { id: user.id, first_name: user.first_name, last_name: user.last_name, email: user.email, role: user.role } });
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

// POST /api/auth/request-reset
router.post('/request-reset', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  try {
    const userResult = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email.trim().toLowerCase()]
    );

    // Always return success even if user not found (prevent email enumeration)
    if (userResult.rows.length === 0) {
      return res.json({ success: true });
    }

    const userId = userResult.rows[0].id;

    // Invalidate any existing unused codes for this user
    await pool.query(
      'UPDATE password_reset_codes SET used = true WHERE user_id = $1 AND used = false',
      [userId]
    );

    // Generate 6-digit code
    const code = String(Math.floor(100000 + Math.random() * 900000));

    // Store with 15-minute expiry (use DB clock to avoid timezone mismatch)
    await pool.query(
      `INSERT INTO password_reset_codes (user_id, code, expires_at) VALUES ($1, $2, NOW() + INTERVAL '15 minutes')`,
      [userId, code]
    );

    // Send email via Resend
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'LazyListings <noreply@lazylistings.com>',
      to: email.trim().toLowerCase(),
      subject: 'Your password reset code',
      html: `
        <div style="font-family: 'Inter', -apple-system, sans-serif; max-width: 420px; margin: 0 auto; padding: 40px;">
          <h1 style="color: #4f6ef7; font-size: 24px; margin-bottom: 8px;">LazyListings</h1>
          <p style="color: #1a1a2e; font-size: 16px; margin-bottom: 24px;">Here is your 6 digit code:</p>
          <div style="background: #f4f6f9; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
            <span style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #1a1a2e;">${code}</span>
          </div>
          <p style="color: #8b8fa3; font-size: 13px;">This code expires in 15 minutes. If you did not request this, please ignore this email.</p>
        </div>
      `,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Request reset error:', err);
    res.status(500).json({ error: 'Failed to send reset code' });
  }
});

// POST /api/auth/verify-code
router.post('/verify-code', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return res.status(400).json({ error: 'Email and code are required' });
  }
  try {
    const result = await pool.query(
      `SELECT prc.id, prc.user_id
       FROM password_reset_codes prc
       JOIN users u ON u.id = prc.user_id
       WHERE u.email = $1 AND prc.code = $2 AND prc.used = false AND prc.expires_at > NOW()
       ORDER BY prc.created_at DESC
       LIMIT 1`,
      [email.trim().toLowerCase(), code.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Verify code error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    const result = await pool.query(
      `SELECT prc.id, prc.user_id
       FROM password_reset_codes prc
       JOIN users u ON u.id = prc.user_id
       WHERE u.email = $1 AND prc.code = $2 AND prc.used = false AND prc.expires_at > NOW()
       ORDER BY prc.created_at DESC
       LIMIT 1`,
      [email.trim().toLowerCase(), code.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired code. Please request a new one.' });
    }

    const userId = result.rows[0].user_id;
    const codeId = result.rows[0].id;

    // Hash new password
    const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);

    // Update password
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [hash, userId]
    );

    // Mark all codes as used for this user
    await pool.query(
      'UPDATE password_reset_codes SET used = true WHERE user_id = $1 AND used = false',
      [userId]
    );

    // Destroy all existing sessions for this user (force re-login)
    try {
      await pool.query(
        `DELETE FROM session WHERE sess->>'userId' = $1`,
        [String(userId)]
      );
    } catch (e) { /* session cleanup is best-effort */ }

    res.json({ success: true });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

module.exports = router;
