# eBay OAuth Integration Design

## Problem
Users currently must manually enter eBay API keys (Trading API token, Client ID, Client Secret) to use LazyListings. We want to offer a "Connect to eBay" button that lets users authorize via OAuth instead, while keeping the existing key-based approach for users who prefer it.

## Approach
Add eBay Authorization Code Grant (3-legged OAuth) as an alternative to manual API keys. App-level credentials are stored in `.env`; per-user OAuth tokens are stored encrypted in new columns on the `users` table.

## Database Changes (Additive Only)
New nullable columns on `users` table:
- `ebay_oauth_access_token` TEXT — encrypted access token
- `ebay_oauth_refresh_token` TEXT — encrypted refresh token
- `ebay_oauth_token_expiry` TIMESTAMP — when access token expires
- `ebay_oauth_username` VARCHAR(255) — eBay username for display

No existing columns or tables are modified.

## Environment Variables
```
EBAY_APP_CLIENT_ID=<app client ID>
EBAY_APP_CLIENT_SECRET=<app cert ID>
EBAY_RUNAME=Livio_Beqiri-LivioBeq-telque-vkjmowbih
```

## New Routes
- `GET /api/ebay/oauth/initiate` — admin only, redirects to eBay consent screen
- `GET /api/ebay/oauth/callback` — exchanges auth code for tokens, stores encrypted
- `POST /api/ebay/oauth/disconnect` — admin only, clears OAuth columns

## OAuth Scopes
- `https://api.ebay.com/oauth/api_scope`
- `https://api.ebay.com/oauth/api_scope/sell.inventory`
- `https://api.ebay.com/oauth/api_scope/sell.account`
- `https://api.ebay.com/oauth/api_scope/sell.fulfillment`
- `https://api.ebay.com/oauth/api_scope/commerce.identity.readonly`

## Token Priority in Middleware
1. OAuth token exists and not expired → use it
2. OAuth token expired, refresh token exists → auto-refresh, store new token, use it
3. Fall back to existing manual keys (`ebay_token`, `ebay_client_id`, `ebay_client_secret`)

## UI Changes (config.html)
- New "Connect to eBay" section for admins, above existing key fields
- When connected: shows "Connected as [username]" with disconnect option
- Existing key fields remain functional but visually secondary when OAuth is active

## What Stays The Same
- All existing DB columns and tables
- Users using manual API keys — zero behavioral change
- Sub-user roles, session management, encryption approach
