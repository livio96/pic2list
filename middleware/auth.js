const pool = require('../db');
const { encrypt, decrypt } = require('../crypto-utils');

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
              owner.ebay_token, owner.ebay_client_id, owner.ebay_client_secret,
              owner.ebay_oauth_access_token, owner.ebay_oauth_refresh_token,
              owner.ebay_oauth_token_expiry, owner.ebay_oauth_username
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
      ebayOAuthToken:   null,
      ebayOAuthConnected: false,
      ebayOAuthUsername: row.ebay_oauth_username || null,
    };

    // Try to use OAuth token if available
    if (row.ebay_oauth_access_token) {
      const expiry = row.ebay_oauth_token_expiry ? new Date(row.ebay_oauth_token_expiry) : null;
      const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // refresh 5 minutes early
      const isExpired = !expiry || Date.now() > (expiry.getTime() - EXPIRY_BUFFER_MS);

      if (!isExpired) {
        req.userConfig.ebayOAuthToken = decrypt(row.ebay_oauth_access_token);
        req.userConfig.ebayOAuthConnected = true;
      } else if (row.ebay_oauth_refresh_token) {
        try {
          const refreshed = await refreshEbayOAuthToken(
            decrypt(row.ebay_oauth_refresh_token),
            row.account_id
          );
          if (refreshed) {
            req.userConfig.ebayOAuthToken = refreshed;
            req.userConfig.ebayOAuthConnected = true;
          }
        } catch (refreshErr) {
          console.error('eBay OAuth auto-refresh failed:', refreshErr.message);
        }
      }
    }

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

async function refreshEbayOAuthToken(refreshToken, accountId) {
  const clientId = process.env.EBAY_APP_CLIENT_ID;
  const clientSecret = process.env.EBAY_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret || !refreshToken) return null;

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const resp = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: [
        'https://api.ebay.com/oauth/api_scope',
        'https://api.ebay.com/oauth/api_scope/sell.inventory',
        'https://api.ebay.com/oauth/api_scope/sell.account',
        'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
        'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
      ].join(' '),
    }).toString(),
  });

  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Token refresh failed');
  }

  const newExpiry = new Date(Date.now() + (data.expires_in || 7200) * 1000);

  if (data.refresh_token) {
    await pool.query(
      `UPDATE users SET ebay_oauth_access_token = $1, ebay_oauth_token_expiry = $2, ebay_oauth_refresh_token = $3, updated_at = NOW() WHERE id = $4`,
      [encrypt(data.access_token), newExpiry, encrypt(data.refresh_token), accountId]
    );
  } else {
    await pool.query(
      `UPDATE users SET ebay_oauth_access_token = $1, ebay_oauth_token_expiry = $2, updated_at = NOW() WHERE id = $3`,
      [encrypt(data.access_token), newExpiry, accountId]
    );
  }

  return data.access_token;
}

module.exports = { requireAuth, requireRole, loadUserConfig };
