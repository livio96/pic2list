# eBay OAuth Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Connect to eBay" OAuth flow so users can authorize LazyListings without manually entering API keys, while preserving existing key-based auth for current users.

**Architecture:** New columns on `users` table store encrypted OAuth tokens per-account. A new route file handles the 3-legged OAuth flow (initiate → eBay consent → callback). The `loadUserConfig` middleware is extended to prefer OAuth tokens over manual keys, with transparent auto-refresh. The config page gets a "Connect to eBay" button.

**Tech Stack:** Express.js, PostgreSQL (Neon), eBay OAuth2 Authorization Code Grant, existing AES-256-GCM encryption via `crypto-utils.js`.

---

### Task 1: Database Migration — Add OAuth Columns

**Files:**
- Modify: `setup-db.js:105-116` (add to migrations array)

**Step 1: Add migration statements to setup-db.js**

In `setup-db.js`, add these 4 lines to the `migrations` array (after line 115, before the closing `];`):

```javascript
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ebay_oauth_access_token" TEXT`,
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ebay_oauth_refresh_token" TEXT`,
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ebay_oauth_token_expiry" TIMESTAMP`,
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ebay_oauth_username" VARCHAR(255)`,
```

**Step 2: Run the migration**

Run: `node setup-db.js`
Expected: "Database tables created successfully." with no errors.

**Step 3: Commit**

```bash
git add setup-db.js
git commit -m "feat: add OAuth columns to users table migration"
```

---

### Task 2: Create eBay OAuth Route File

**Files:**
- Create: `routes/ebay-oauth.js`

**Step 1: Create the route file**

Create `routes/ebay-oauth.js` with the full OAuth flow:

```javascript
const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { encrypt, decrypt } = require('../crypto-utils');
const { requireAuth, requireRole } = require('../middleware/auth');
const router = express.Router();

const EBAY_AUTH_URL = 'https://auth.ebay.com/oauth2/authorize';
const EBAY_TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';

const OAUTH_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
].join(' ');

// GET /api/ebay/oauth/initiate — redirect admin to eBay consent screen
router.get('/initiate', requireAuth, requireRole('admin'), (req, res) => {
  const clientId = process.env.EBAY_APP_CLIENT_ID;
  const ruName = process.env.EBAY_RUNAME;
  if (!clientId || !ruName) {
    return res.status(500).json({ error: 'eBay OAuth not configured on the server.' });
  }

  // Generate random state and store in session
  const state = crypto.randomBytes(16).toString('hex');
  req.session.ebayOAuthState = state;

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: ruName,
    scope: OAUTH_SCOPES,
    state: state,
  });

  res.redirect(`${EBAY_AUTH_URL}?${params.toString()}`);
});

// GET /api/ebay/oauth/callback — exchange code for tokens
router.get('/callback', requireAuth, async (req, res) => {
  const { code, state } = req.query;

  // Validate state parameter
  if (!state || state !== req.session.ebayOAuthState) {
    return res.redirect('/config.html?ebay_oauth=error&reason=invalid_state');
  }
  delete req.session.ebayOAuthState;

  if (!code) {
    return res.redirect('/config.html?ebay_oauth=error&reason=no_code');
  }

  const clientId = process.env.EBAY_APP_CLIENT_ID;
  const clientSecret = process.env.EBAY_APP_CLIENT_SECRET;
  const ruName = process.env.EBAY_RUNAME;

  if (!clientId || !clientSecret || !ruName) {
    return res.redirect('/config.html?ebay_oauth=error&reason=server_config');
  }

  try {
    // Exchange authorization code for tokens
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenResp = await fetch(EBAY_TOKEN_URL, {
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
      console.error('eBay OAuth token exchange failed:', tokenData);
      return res.redirect('/config.html?ebay_oauth=error&reason=token_exchange');
    }

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || null;
    const expiresIn = tokenData.expires_in || 7200; // default 2 hours
    const tokenExpiry = new Date(Date.now() + expiresIn * 1000);

    // Fetch eBay username via identity API
    let ebayUsername = null;
    try {
      const userResp = await fetch('https://apiz.ebay.com/commerce/identity/v1/user/', {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      const userData = await userResp.json();
      ebayUsername = userData.username || null;
    } catch (e) {
      console.error('Failed to fetch eBay username:', e.message);
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

    res.redirect('/config.html?ebay_oauth=success');
  } catch (err) {
    console.error('eBay OAuth callback error:', err);
    res.redirect('/config.html?ebay_oauth=error&reason=server_error');
  }
});

// POST /api/ebay/oauth/disconnect — clear OAuth connection
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
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

module.exports = router;
```

**Step 2: Commit**

```bash
git add routes/ebay-oauth.js
git commit -m "feat: add eBay OAuth route (initiate, callback, disconnect)"
```

---

### Task 3: Wire OAuth Routes into server.js

**Files:**
- Modify: `server.js:11` (add require)
- Modify: `server.js:52` (add public callback route)
- Modify: `server.js:78` (add authenticated route)

**Step 1: Add require at top of server.js**

After line 11 (`const draftsRoutes = require('./routes/drafts');`), add:

```javascript
const ebayOAuthRoutes = require('./routes/ebay-oauth');
```

**Step 2: Add the callback route as a public route**

The OAuth callback must be accessible without `loadUserConfig` (user is coming back from eBay). After line 57 (`app.get('/how-it-works.html', ...)`), add:

```javascript
app.get('/api/ebay/oauth/callback', requireAuth, (req, res, next) => next(), ebayOAuthRoutes);
```

Wait — actually the callback route is on the router already. We need a different approach. The callback needs session (for state validation) but NOT loadUserConfig. Since `requireAuth` is applied globally at line 68 and `loadUserConfig` is applied to `/api` at line 72, the callback will hit loadUserConfig. That's fine — loadUserConfig doesn't block, it just populates `req.userConfig`. The callback doesn't use `req.userConfig` so this is safe.

So just mount the routes after the existing API routes. After line 78 (`app.use('/api/drafts', draftsRoutes);`), add:

```javascript
app.use('/api/ebay/oauth', ebayOAuthRoutes);
```

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat: wire eBay OAuth routes into server"
```

---

### Task 4: Update Middleware to Load and Auto-Refresh OAuth Tokens

**Files:**
- Modify: `middleware/auth.js:22-55` (update `loadUserConfig`)

**Step 1: Replace the `loadUserConfig` function**

Replace the existing `loadUserConfig` function (lines 22-55) with this version that also loads OAuth tokens and handles auto-refresh:

```javascript
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

    // Build base config from manual keys
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
      const isExpired = !expiry || Date.now() > expiry.getTime();

      if (!isExpired) {
        // Token is still valid
        req.userConfig.ebayOAuthToken = decrypt(row.ebay_oauth_access_token);
        req.userConfig.ebayOAuthConnected = true;
      } else if (row.ebay_oauth_refresh_token) {
        // Token expired — try to refresh
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

  // Update DB with new access token (and new refresh token if provided)
  const { encrypt: enc } = require('../crypto-utils');
  const updateFields = [enc(data.access_token), newExpiry, accountId];
  let sql = `UPDATE users SET ebay_oauth_access_token = $1, ebay_oauth_token_expiry = $2, updated_at = NOW()`;

  if (data.refresh_token) {
    sql += `, ebay_oauth_refresh_token = $3 WHERE id = $4`;
    updateFields.splice(2, 0, enc(data.refresh_token));
  } else {
    sql += ` WHERE id = $3`;
  }

  await pool.query(sql, updateFields);
  return data.access_token;
}
```

Note: Add `const { encrypt } = require('../crypto-utils');` to the existing require line at the top (line 2). Change it from:
```javascript
const { decrypt } = require('../crypto-utils');
```
to:
```javascript
const { encrypt, decrypt } = require('../crypto-utils');
```

**Step 2: Commit**

```bash
git add middleware/auth.js
git commit -m "feat: extend loadUserConfig with OAuth token loading and auto-refresh"
```

---

### Task 5: Update server.js eBay Endpoints to Use OAuth Token

**Files:**
- Modify: `server.js` — each eBay endpoint

**Step 1: Update token selection in Trading API endpoints**

For each endpoint that uses `req.userConfig.ebayToken`, update to prefer OAuth:

In `GET /api/ebay/test-token` (line 127-157):
Replace line 128:
```javascript
  const token = req.userConfig.ebayToken;
```
with:
```javascript
  const token = req.userConfig.ebayOAuthToken || req.userConfig.ebayToken;
```

In `POST /api/ebay/upload-image` (line 160-214):
Replace line 161:
```javascript
  const token = req.userConfig.ebayToken;
```
with:
```javascript
  const token = req.userConfig.ebayOAuthToken || req.userConfig.ebayToken;
```

In `POST /api/ebay/add-item` (line 250-436):
Replace line 251:
```javascript
  const token = req.userConfig.ebayToken;
```
with:
```javascript
  const token = req.userConfig.ebayOAuthToken || req.userConfig.ebayToken;
```

**Step 2: Update REST API endpoints to use OAuth token**

For `GET /api/ebay/item-aspects` (line 639-672), `GET /api/ebay/category-suggestions` (line 675-707), and `GET /api/ebay/price-range` (line 710-769):

In each of these, the token is obtained via `getEbayBrowseToken()`. Update each to prefer the OAuth user token:

For `/api/ebay/item-aspects`, replace lines 640-641:
```javascript
  const { ebayClientId, ebayClientSecret } = req.userConfig;
  if (!ebayClientId || !ebayClientSecret) return res.json({ success: false, error: 'eBay OAuth credentials not configured. Go to Settings.' });
```
with:
```javascript
  const { ebayClientId, ebayClientSecret, ebayOAuthToken } = req.userConfig;
  if (!ebayOAuthToken && (!ebayClientId || !ebayClientSecret)) return res.json({ success: false, error: 'eBay OAuth credentials not configured. Go to Settings.' });
```

And replace line 647:
```javascript
    const token = await getEbayBrowseToken(req.session.accountId, ebayClientId, ebayClientSecret);
```
with:
```javascript
    const token = ebayOAuthToken || await getEbayBrowseToken(req.session.accountId, ebayClientId, ebayClientSecret);
```

Apply the same pattern to `/api/ebay/category-suggestions` (lines 676-677 and 683) and `/api/ebay/price-range` (lines 711-712 and 718).

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat: prefer OAuth user token across all eBay API endpoints"
```

---

### Task 6: Update Config API to Return OAuth Status

**Files:**
- Modify: `routes/config.js:23-52` (GET endpoint)

**Step 1: Update the GET /api/config query and response**

In `routes/config.js`, update the owner query (line 23-26) to also fetch OAuth fields:

Replace:
```javascript
    const ownerResult = await pool.query(
      'SELECT ebay_token, ebay_client_id, ebay_client_secret, example_template FROM users WHERE id = $1',
      [accountId]
    );
```
with:
```javascript
    const ownerResult = await pool.query(
      'SELECT ebay_token, ebay_client_id, ebay_client_secret, example_template, ebay_oauth_username, ebay_oauth_access_token FROM users WHERE id = $1',
      [accountId]
    );
```

Then, inside the `if (role === 'admin')` block (after line 49), add the OAuth status:

```javascript
      response.ebay_oauth = {
        connected: !!owner.ebay_oauth_access_token,
        username: owner.ebay_oauth_username || null,
      };
```

**Step 2: Commit**

```bash
git add routes/config.js
git commit -m "feat: return eBay OAuth connection status in config API"
```

---

### Task 7: Update Config Page UI

**Files:**
- Modify: `config.html`

**Step 1: Add the eBay OAuth Connect section**

In `config.html`, add a new section BEFORE the existing `section-ebay-trading` div (before line 121). Insert this new section:

```html
      <div class="config-section" id="section-ebay-connect" style="display:none;">
        <h3>eBay Account</h3>
        <div id="ebayOAuthNotConnected">
          <p style="font-size:13px; color:#555b6e; margin-bottom:14px;">Connect your eBay account to list items without entering API keys manually.</p>
          <a href="/api/ebay/oauth/initiate" style="display:inline-flex; align-items:center; gap:8px; padding:10px 24px; border:none; border-radius:10px; background:#0064d2; color:#fff; font-size:14px; font-weight:600; text-decoration:none; cursor:pointer; transition:background 0.15s;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
            Connect to eBay
          </a>
        </div>
        <div id="ebayOAuthConnected" style="display:none;">
          <div style="display:flex; align-items:center; gap:12px; padding:14px 18px; background:#ecfdf5; border:1px solid #a7f3d0; border-radius:10px; margin-bottom:14px;">
            <div style="width:36px; height:36px; border-radius:50%; background:#059669; color:#fff; display:flex; align-items:center; justify-content:center; font-size:16px; font-weight:700;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <div>
              <div style="font-size:14px; font-weight:600; color:#065f46;">Connected to eBay</div>
              <div style="font-size:12px; color:#059669;" id="ebayOAuthUsernameDisplay"></div>
            </div>
          </div>
          <button class="btn-sm" id="ebayDisconnectBtn" style="color:#dc2626; border-color:#fecaca;">Disconnect eBay Account</button>
        </div>
      </div>
```

**Step 2: Add the OAuth status logic to the JS**

In the `<script>` section, inside the `(async () => { ... })()` block, after the existing eBay status badge logic (after the closing `}` of the `if (userRole === 'admin')` block around line 220), add:

```javascript
        // eBay OAuth connection status (admin only)
        if (userRole === 'admin') {
          document.getElementById('section-ebay-connect').style.display = '';
          if (cfg.ebay_oauth && cfg.ebay_oauth.connected) {
            document.getElementById('ebayOAuthNotConnected').style.display = 'none';
            document.getElementById('ebayOAuthConnected').style.display = '';
            document.getElementById('ebayOAuthUsernameDisplay').textContent =
              cfg.ebay_oauth.username ? `Signed in as ${cfg.ebay_oauth.username}` : 'Account connected';
          }
        }

        // Handle OAuth redirect result
        const urlParams = new URLSearchParams(window.location.search);
        const oauthResult = urlParams.get('ebay_oauth');
        if (oauthResult === 'success') {
          const errorMsg = document.getElementById('errorMsg');
          errorMsg.textContent = 'eBay account connected successfully!';
          errorMsg.style.display = 'block';
          errorMsg.style.background = '#ecfdf5';
          errorMsg.style.borderColor = '#a7f3d0';
          errorMsg.style.color = '#059669';
          history.replaceState(null, '', '/config.html');
        } else if (oauthResult === 'error') {
          const errorMsg = document.getElementById('errorMsg');
          errorMsg.textContent = 'Failed to connect eBay account. Please try again.';
          errorMsg.style.display = 'block';
          history.replaceState(null, '', '/config.html');
        } else if (oauthResult === 'declined') {
          const errorMsg = document.getElementById('errorMsg');
          errorMsg.textContent = 'eBay connection was declined.';
          errorMsg.style.display = 'block';
          history.replaceState(null, '', '/config.html');
        }
```

**Step 3: Add the disconnect button handler**

After the save button event listener (after line 290), add:

```javascript
    // Disconnect eBay OAuth
    document.getElementById('ebayDisconnectBtn').addEventListener('click', async () => {
      if (!confirm('Disconnect your eBay account? You can reconnect at any time.')) return;
      try {
        const resp = await fetch('/api/ebay/oauth/disconnect', { method: 'POST' });
        const data = await resp.json();
        if (data.success) {
          window.location.reload();
        } else {
          alert('Failed to disconnect: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Network error. Please try again.');
      }
    });
```

**Step 4: Commit**

```bash
git add config.html
git commit -m "feat: add Connect to eBay button and OAuth status to config page"
```

---

### Task 8: Manual Testing

**Step 1: Verify app starts without errors**

Run: `node server.js`
Expected: "LazyListings running at http://localhost:3000" with no errors.

**Step 2: Verify config page loads**

Visit `http://localhost:3000/config.html` as an admin user.
Expected: See the new "eBay Account" section with a "Connect to eBay" button above the existing eBay key sections.

**Step 3: Test the OAuth flow**

1. Add `EBAY_APP_CLIENT_ID`, `EBAY_APP_CLIENT_SECRET`, and `EBAY_RUNAME` to `.env`
2. Click "Connect to eBay" button
3. Should redirect to eBay login/consent page
4. After granting access, should redirect back to `/config.html?ebay_oauth=success`
5. Should see "Connected to eBay" with eBay username displayed
6. Existing eBay key fields should still be visible below

**Step 4: Test disconnect**

Click "Disconnect eBay Account" → confirm → page reloads → should show "Connect to eBay" button again.

**Step 5: Test that existing key-based users are unaffected**

Log in as a user that has manual API keys set and NO OAuth connection. All eBay features (test token, upload image, add item, category search, price range) should work exactly as before.

**Step 6: Final commit**

```bash
git add -A
git commit -m "feat: complete eBay OAuth integration"
```
