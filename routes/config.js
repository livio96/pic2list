const express = require('express');
const pool = require('../db');
const { encrypt, decrypt } = require('../crypto-utils');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// GET /api/config — returns masked key previews (role-aware)
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const accountId = req.session.accountId;
    const role = req.session.role;

    // Load user's own profile
    const profileResult = await pool.query(
      'SELECT first_name, last_name, company_name, email FROM users WHERE id = $1',
      [userId]
    );
    if (profileResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const profile = profileResult.rows[0];

    // Load account owner's config (eBay keys + template)
    const ownerResult = await pool.query(
      'SELECT ebay_token, ebay_client_id, ebay_client_secret, example_template FROM users WHERE id = $1',
      [accountId]
    );
    const owner = ownerResult.rows[0] || {};

    const mask = (enc) => {
      if (!enc) return { set: false, preview: '' };
      const plain = decrypt(enc);
      if (!plain) return { set: false, preview: '' };
      return { set: true, preview: plain.substring(0, 6) + '...' + plain.slice(-4) };
    };

    const response = {
      first_name:       profile.first_name || '',
      last_name:        profile.last_name || '',
      company_name:     profile.company_name || '',
      email:            profile.email || '',
      example_template: owner.example_template || '',
      role:             role,
    };

    // Only admins see eBay key info
    if (role === 'admin') {
      response.ebay_token =         mask(owner.ebay_token);
      response.ebay_client_id =     mask(owner.ebay_client_id);
      response.ebay_client_secret = mask(owner.ebay_client_secret);
    }

    res.json(response);
  } catch (err) {
    console.error('Get config error:', err);
    res.status(500).json({ error: 'Failed to load config' });
  }
});

// PUT /api/config — save config (role-aware)
router.put('/', requireAuth, async (req, res) => {
  const role = req.session.role;
  const userId = req.session.userId;
  const accountId = req.session.accountId;
  const { first_name, last_name, company_name, email,
          ebay_token, ebay_client_id, ebay_client_secret, example_template } = req.body;

  try {
    // 1. Profile fields — any user can update their own profile
    const profileUpdates = [];
    const profileValues = [];
    let idx = 1;
    for (const [col, val] of [
      ['first_name', first_name],
      ['last_name', last_name],
      ['company_name', company_name],
      ['email', email],
    ]) {
      if (val !== undefined) {
        profileUpdates.push(`${col} = $${idx}`);
        profileValues.push(val || null);
        idx++;
      }
    }
    if (profileUpdates.length > 0) {
      profileUpdates.push('updated_at = NOW()');
      profileValues.push(userId);
      await pool.query(
        `UPDATE users SET ${profileUpdates.join(', ')} WHERE id = $${idx}`,
        profileValues
      );
    }

    // 2. eBay keys — admin only, written to account owner's record
    if (ebay_token || ebay_client_id || ebay_client_secret) {
      if (role !== 'admin') {
        return res.status(403).json({ error: 'Only admins can update eBay API keys' });
      }
      const keyUpdates = [];
      const keyValues = [];
      let ki = 1;
      for (const [col, val] of [
        ['ebay_token', ebay_token],
        ['ebay_client_id', ebay_client_id],
        ['ebay_client_secret', ebay_client_secret],
      ]) {
        if (val !== undefined) {
          keyUpdates.push(`${col} = $${ki}`);
          keyValues.push(val ? encrypt(val) : null);
          ki++;
        }
      }
      if (keyUpdates.length > 0) {
        keyUpdates.push('updated_at = NOW()');
        keyValues.push(accountId);
        await pool.query(
          `UPDATE users SET ${keyUpdates.join(', ')} WHERE id = $${ki}`,
          keyValues
        );
      }
    }

    // 3. Template — admin and publisher only, written to account owner's record
    if (example_template !== undefined) {
      if (role === 'operator') {
        return res.status(403).json({ error: 'Operators cannot update the listing template' });
      }
      await pool.query(
        'UPDATE users SET example_template = $1, updated_at = NOW() WHERE id = $2',
        [example_template || null, accountId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Save config error:', err);
    res.status(500).json({ error: 'Failed to save config' });
  }
});

module.exports = router;
