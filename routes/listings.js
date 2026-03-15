const express = require('express');
const pool = require('../db');
const router = express.Router();

// GET /api/listings/recent — last 20 listings for the account (shared queue)
router.get('/recent', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.id, l.ebay_item_id, l.title, l.price, l.thumbnail_url, l.created_at,
              u.first_name AS created_by_first_name, u.last_name AS created_by_last_name
       FROM listings l
       JOIN users u ON u.id = l.user_id
       WHERE l.account_id = $1
       ORDER BY l.created_at DESC
       LIMIT 20`,
      [req.session.accountId]
    );
    res.json({ success: true, listings: result.rows });
  } catch (err) {
    console.error('Fetch recent listings error:', err);
    res.status(500).json({ success: false, error: 'Failed to load listings' });
  }
});

// GET /api/listings/count — total listing count + lifetime membership status
router.get('/count', async (req, res) => {
  try {
    const accountId = req.session.accountId;
    const countResult = await pool.query(
      'SELECT COUNT(*)::int AS total FROM listings WHERE account_id = $1',
      [accountId]
    );
    const userResult = await pool.query(
      'SELECT lifetime_member FROM users WHERE id = $1',
      [accountId]
    );
    const total = countResult.rows[0]?.total || 0;
    const lifetimeMember = userResult.rows[0]?.lifetime_member || false;
    res.json({ success: true, count: total, goal: 1000, lifetime_member: lifetimeMember });
  } catch (err) {
    console.error('Fetch listing count error:', err);
    res.status(500).json({ success: false, error: 'Failed to load listing count' });
  }
});

module.exports = router;
