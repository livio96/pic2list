const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { encrypt } = require('../crypto-utils');
const { requireAuth, requireRole } = require('../middleware/auth');
const router = express.Router();

const EBAY_OAUTH_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
].join(' ');

// GET /api/ebay/oauth/initiate — start eBay 3-legged OAuth flow (admin only)
router.get('/initiate', requireAuth, requireRole('admin'), (req, res) => {
  const clientId = process.env.EBAY_APP_CLIENT_ID;
  const ruName = process.env.EBAY_RUNAME;

  if (!clientId || !ruName) {
    return res.status(500).json({ error: 'eBay OAuth is not configured. EBAY_APP_CLIENT_ID and EBAY_RUNAME must be set.' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  req.session.ebayOAuthState = state;

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: ruName,
    scope: EBAY_OAUTH_SCOPES,
    state: state,
  });

  res.redirect(`https://auth.ebay.com/oauth2/authorize?${params.toString()}`);
});

// GET /api/ebay/oauth/callback — handle eBay OAuth callback (auth required, any role)
router.get('/callback', requireAuth, async (req, res) => {
  const { code, state } = req.query;
  const savedState = req.session.ebayOAuthState;

  // Clean up state from session regardless of outcome
  delete req.session.ebayOAuthState;

  // Handle user declining consent
  if (req.query.error === 'access_denied' || req.query.error === 'consent_declined') {
    return res.redirect('/config.html?ebay_oauth=declined');
  }

  // Validate state parameter
  if (!savedState || state !== savedState) {
    return res.redirect('/config.html?ebay_oauth=error&reason=invalid_state');
  }

  // Validate code is present
  if (!code) {
    return res.redirect('/config.html?ebay_oauth=declined');
  }

  const clientId = process.env.EBAY_APP_CLIENT_ID;
  const clientSecret = process.env.EBAY_APP_CLIENT_SECRET;
  const ruName = process.env.EBAY_RUNAME;

  if (!clientId || !clientSecret || !ruName) {
    return res.redirect('/config.html?ebay_oauth=error&reason=server_error');
  }

  try {
    // Exchange authorization code for tokens
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenResp = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: ruName,
      }).toString(),
    });

    const tokenData = await tokenResp.json();

    if (!tokenResp.ok || !tokenData.access_token) {
      console.error('eBay token exchange failed:', tokenData);
      return res.redirect('/config.html?ebay_oauth=error&reason=token_exchange');
    }

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || null;
    const expiresIn = tokenData.expires_in || 7200;
    const tokenExpiry = new Date(Date.now() + expiresIn * 1000);

    // Best-effort: fetch eBay username
    let ebayUsername = null;
    try {
      const userResp = await fetch('https://apiz.ebay.com/commerce/identity/v1/user/', {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      if (userResp.ok) {
        const userData = await userResp.json();
        ebayUsername = userData.username || null;
      }
    } catch (e) {
      // Best-effort — don't fail if this errors
    }

    // Store encrypted tokens on the account owner's record
    const accountId = req.session.accountId;
    await pool.query(
      `UPDATE users SET
        ebay_oauth_access_token = $1,
        ebay_oauth_refresh_token = $2,
        ebay_oauth_token_expiry = $3,
        ebay_oauth_username = $4,
        updated_at = NOW()
      WHERE id = $5`,
      [
        encrypt(accessToken),
        refreshToken ? encrypt(refreshToken) : null,
        tokenExpiry,
        ebayUsername,
        accountId,
      ]
    );

    return res.redirect('/config.html?ebay_oauth=success');
  } catch (err) {
    console.error('eBay OAuth callback error:', err);
    return res.redirect('/config.html?ebay_oauth=error&reason=server_error');
  }
});

// POST /api/ebay/oauth/disconnect — clear eBay OAuth tokens (admin only)
router.post('/disconnect', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const accountId = req.session.accountId;
    await pool.query(
      `UPDATE users SET
        ebay_oauth_access_token = NULL,
        ebay_oauth_refresh_token = NULL,
        ebay_oauth_token_expiry = NULL,
        ebay_oauth_username = NULL,
        updated_at = NOW()
      WHERE id = $1`,
      [accountId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('eBay OAuth disconnect error:', err);
    res.status(500).json({ error: 'Failed to disconnect eBay account' });
  }
});

module.exports = router;
