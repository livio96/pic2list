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

module.exports = router;
