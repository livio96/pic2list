const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const router = express.Router();

const SALT_ROUNDS = 12;
const VALID_ROLES = ['admin', 'publisher', 'operator'];

// GET /api/users — list all users in the account
router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, first_name, last_name, email, role, account_id, created_at
       FROM users
       WHERE account_id = $1
       ORDER BY created_at ASC`,
      [req.session.accountId]
    );
    res.json({ success: true, users: result.rows });
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// POST /api/users — create a sub-user
router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { first_name, last_name, email, password, role } = req.body;

  if (!first_name || !last_name || !email || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Must be admin, publisher, or operator' });
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await pool.query(
      `INSERT INTO users (first_name, last_name, email, password_hash, role, account_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, first_name, last_name, email, role, created_at`,
      [first_name.trim(), last_name.trim(), email.trim().toLowerCase(), hash, role, req.session.accountId]
    );

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// PUT /api/users/:id — update a sub-user's role
router.put('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const targetId = parseInt(req.params.id);
  const { role } = req.body;

  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  // Prevent admin from changing their own role
  if (targetId === req.session.userId) {
    return res.status(400).json({ error: 'Cannot change your own role' });
  }

  try {
    // Verify the target user belongs to the same account
    const check = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND account_id = $2',
      [targetId, req.session.accountId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await pool.query('UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2', [role, targetId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// DELETE /api/users/:id — remove a sub-user
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const targetId = parseInt(req.params.id);

  // Prevent admin from deleting themselves
  if (targetId === req.session.userId) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  try {
    // Verify the target belongs to the same account AND is not the account owner
    const check = await pool.query(
      'SELECT id, account_id FROM users WHERE id = $1 AND account_id = $2',
      [targetId, req.session.accountId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent deleting the account owner
    if (check.rows[0].id === check.rows[0].account_id) {
      return res.status(400).json({ error: 'Cannot delete the account owner' });
    }

    // Reassign their listings to account owner before deleting
    await pool.query(
      'UPDATE listings SET user_id = $1 WHERE user_id = $2',
      [req.session.accountId, targetId]
    );

    // Clear their active sessions
    try {
      await pool.query(
        `DELETE FROM session WHERE sess->>'userId' = $1`,
        [String(targetId)]
      );
    } catch (e) { /* session cleanup is best-effort */ }

    await pool.query('DELETE FROM users WHERE id = $1', [targetId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

module.exports = router;
