const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// POST /api/drafts — batch create drafts after product identification
router.post('/', requireAuth, async (req, res) => {
  const { drafts } = req.body; // array of { productName, brand, confidence, images: [{ base64, filename, mimeType }] }
  if (!drafts || !Array.isArray(drafts) || drafts.length === 0) {
    return res.status(400).json({ error: 'No drafts provided' });
  }

  const accountId = req.session.accountId;
  const userId = req.session.userId;
  console.log(`[drafts] POST: creating ${drafts.length} drafts for account=${accountId} user=${userId}`);

  if (!accountId) {
    console.error('[drafts] POST: accountId is missing from session!');
    return res.status(400).json({ error: 'Account not found in session. Please log out and log back in.' });
  }

  try {
    const createdIds = [];

    for (const draft of drafts) {
      const result = await pool.query(
        `INSERT INTO drafts (account_id, created_by, product_name, brand, confidence, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         RETURNING id`,
        [accountId, userId, draft.productName, draft.brand || null, draft.confidence || 0]
      );
      const draftId = result.rows[0].id;
      createdIds.push(draftId);

      // Insert images
      if (draft.images && draft.images.length > 0) {
        for (let i = 0; i < draft.images.length; i++) {
          const img = draft.images[i];
          await pool.query(
            `INSERT INTO draft_images (draft_id, image_index, base64_data, filename, mime_type)
             VALUES ($1, $2, $3, $4, $5)`,
            [draftId, i, img.base64, img.filename || 'image.jpg', img.mimeType || 'image/jpeg']
          );
        }
      }
    }

    res.json({ success: true, ids: createdIds });
  } catch (err) {
    console.error('Create drafts error:', err);
    res.status(500).json({ error: 'Failed to create drafts' });
  }
});

// GET /api/drafts — load all active drafts for account (metadata only, no image blobs)
router.get('/', requireAuth, async (req, res) => {
  const accountId = req.session.accountId;
  console.log(`[drafts] GET: loading drafts for account=${accountId} user=${req.session.userId}`);

  try {
    const draftsResult = await pool.query(
      `SELECT d.*, u.first_name AS created_by_first_name
       FROM drafts d
       JOIN users u ON u.id = d.created_by
       WHERE d.account_id = $1 AND d.status NOT IN ('rejected', 'listed')
       ORDER BY d.created_at ASC`,
      [accountId]
    );

    const drafts = draftsResult.rows;
    console.log(`[drafts] GET: found ${drafts.length} active drafts for account=${accountId}`);

    // Load image metadata only (no base64_data) for fast initial load
    if (drafts.length > 0) {
      const draftIds = drafts.map(d => d.id);
      const imagesResult = await pool.query(
        `SELECT id, draft_id, image_index, filename, mime_type
         FROM draft_images
         WHERE draft_id = ANY($1)
         ORDER BY draft_id, image_index`,
        [draftIds]
      );

      const imagesByDraft = {};
      for (const img of imagesResult.rows) {
        if (!imagesByDraft[img.draft_id]) imagesByDraft[img.draft_id] = [];
        imagesByDraft[img.draft_id].push({
          id: img.id,
          index: img.image_index,
          filename: img.filename,
          mimeType: img.mime_type,
        });
      }

      for (const draft of drafts) {
        draft.images = imagesByDraft[draft.id] || [];
      }
    }

    res.json({ success: true, drafts });
  } catch (err) {
    console.error('Get drafts error:', err);
    res.status(500).json({ error: 'Failed to load drafts' });
  }
});

// GET /api/drafts/images/:imageId — serve a single image as binary (for <img src>)
router.get('/images/:imageId', requireAuth, async (req, res) => {
  const imageId = parseInt(req.params.imageId);
  const accountId = req.session.accountId;

  try {
    const result = await pool.query(
      `SELECT di.base64_data, di.mime_type
       FROM draft_images di
       JOIN drafts d ON d.id = di.draft_id
       WHERE di.id = $1 AND d.account_id = $2`,
      [imageId, accountId]
    );
    if (result.rows.length === 0) return res.status(404).send('Not found');

    const { base64_data, mime_type } = result.rows[0];
    const buffer = Buffer.from(base64_data, 'base64');
    res.set('Content-Type', mime_type || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  } catch (err) {
    console.error('Serve image error:', err);
    res.status(500).send('Failed to load image');
  }
});

// GET /api/drafts/images/:imageId/base64 — return base64 string (for API calls)
router.get('/images/:imageId/base64', requireAuth, async (req, res) => {
  const imageId = parseInt(req.params.imageId);
  const accountId = req.session.accountId;

  try {
    const result = await pool.query(
      `SELECT di.base64_data, di.mime_type, di.filename
       FROM draft_images di
       JOIN drafts d ON d.id = di.draft_id
       WHERE di.id = $1 AND d.account_id = $2`,
      [imageId, accountId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const row = result.rows[0];
    res.json({ base64: row.base64_data, mimeType: row.mime_type, filename: row.filename });
  } catch (err) {
    console.error('Get image base64 error:', err);
    res.status(500).json({ error: 'Failed to load image' });
  }
});

// PUT /api/drafts/:id — update a draft
router.put('/:id', requireAuth, async (req, res) => {
  const draftId = parseInt(req.params.id);
  const accountId = req.session.accountId;

  try {
    // Verify draft belongs to same account
    const check = await pool.query(
      'SELECT id FROM drafts WHERE id = $1 AND account_id = $2',
      [draftId, accountId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    const allowedFields = [
      ['status', 'status'],
      ['generated_title', 'generated_title'],
      ['generated_html', 'generated_html'],
      ['category_id', 'category_id'],
      ['category_name', 'category_name'],
      ['suggested_brand', 'suggested_brand'],
      ['suggested_type', 'suggested_type'],
      ['suggested_mpn', 'suggested_mpn'],
      ['item_aspects', 'item_aspects'],
      ['sku', 'sku'],
      ['price', 'price'],
      ['condition_id', 'condition_id'],
      ['quantity', 'quantity'],
      ['shipping_policy_id', 'shipping_policy_id'],
      ['return_policy_id', 'return_policy_id'],
      ['best_offer_enabled', 'best_offer_enabled'],
      ['auto_accept_price', 'auto_accept_price'],
      ['min_best_offer_price', 'min_best_offer_price'],
      ['auto_pay', 'auto_pay'],
      ['claude_verified', 'claude_verified'],
      ['ebay_item_id', 'ebay_item_id'],
      ['price_range', 'price_range'],
      ['product_name', 'product_name'],
      ['brand', 'brand'],
    ];

    const updates = [];
    const values = [];
    let idx = 1;

    for (const [bodyKey, col] of allowedFields) {
      if (req.body[bodyKey] !== undefined) {
        updates.push(`"${col}" = $${idx}`);
        let val = req.body[bodyKey];
        // Handle JSONB fields
        if ((col === 'item_aspects' || col === 'price_range') && val && typeof val === 'object') {
          val = JSON.stringify(val);
        }
        // Handle null-ish numeric fields
        if ((col === 'price' || col === 'auto_accept_price' || col === 'min_best_offer_price') && (val === '' || val === null)) {
          val = null;
        }
        values.push(val);
        idx++;
      }
    }

    if (updates.length === 0) {
      return res.json({ success: true, message: 'No changes' });
    }

    updates.push('updated_at = NOW()');
    values.push(draftId);

    await pool.query(
      `UPDATE drafts SET ${updates.join(', ')} WHERE id = $${idx}`,
      values
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Update draft error:', err);
    res.status(500).json({ error: 'Failed to update draft' });
  }
});

// DELETE /api/drafts/:id — reject/remove a draft
router.delete('/:id', requireAuth, async (req, res) => {
  const draftId = parseInt(req.params.id);
  const accountId = req.session.accountId;

  try {
    const check = await pool.query(
      'SELECT id FROM drafts WHERE id = $1 AND account_id = $2',
      [draftId, accountId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    // CASCADE deletes images too
    await pool.query('DELETE FROM drafts WHERE id = $1', [draftId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete draft error:', err);
    res.status(500).json({ error: 'Failed to delete draft' });
  }
});

module.exports = router;
