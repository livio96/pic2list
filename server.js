require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const pool = require('./db');
const cheerio = require('cheerio');
const { requireAuth, requireRole, loadUserConfig } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const configRoutes = require('./routes/config');
const listingsRoutes = require('./routes/listings');
const usersRoutes = require('./routes/users');
const draftsRoutes = require('./routes/drafts');
const ebayOAuthRoutes = require('./routes/ebay-oauth');
const myListingsRoutes = require('./routes/my-listings');

const app = express();
app.use(express.json({ limit: '200mb' }));

// Log body parser errors
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large' || err.status === 413) {
    console.error(`[body-parser] Payload too large: ${req.method} ${req.url}`);
    return res.status(413).json({ error: 'Request payload too large' });
  }
  if (err.type === 'entity.parse.failed') {
    console.error(`[body-parser] Parse failed: ${req.method} ${req.url}`);
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  next(err);
});

// ── Server-level keys (from .env) ──
const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.2';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'anthropic/claude-opus-4-6';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'google/gemini-2.5-flash';

// ── Session middleware ──
app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: 'lax',
  },
}));

// ── Public routes (no auth) ──
app.use('/api/auth', authRoutes);
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/signup.html', (req, res) => res.sendFile(path.join(__dirname, 'signup.html')));
app.get('/reset-password.html', (req, res) => res.sendFile(path.join(__dirname, 'reset-password.html')));
app.get('/landing.html', (req, res) => res.sendFile(path.join(__dirname, 'landing.html')));
app.get('/how-it-works.html', (req, res) => res.sendFile(path.join(__dirname, 'how-it-works.html')));
app.get('/terms.html', (req, res) => res.sendFile(path.join(__dirname, 'terms.html')));

// Root: show landing page for guests, dashboard for authenticated users
app.get('/', (req, res) => {
  if (req.session && req.session.userId) {
    return res.sendFile(path.join(__dirname, 'index.html'));
  }
  res.sendFile(path.join(__dirname, 'landing.html'));
});

// ── Everything below requires auth ──
app.use(requireAuth);
app.use(express.static(path.join(__dirname)));

// ── Load user config for all API routes (must be before route handlers to refresh session role) ──
app.use('/api', loadUserConfig);

// ── Routes ──
app.use('/api/config', configRoutes);
app.use('/api/listings', listingsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/drafts', draftsRoutes);
app.use('/api/ebay/oauth', ebayOAuthRoutes);
app.use('/api/my-listings', myListingsRoutes);

// ── eBay helpers ──
const EBAY_API_URL = 'https://api.ebay.com/ws/api.dll';

const ebayHeaders = (callName, token) => ({
  'X-EBAY-API-SITEID': '0',
  'X-EBAY-API-COMPATIBILITY-LEVEL': '1421',
  'X-EBAY-API-IAF-TOKEN': token,
  'X-EBAY-API-CALL-NAME': callName,
});

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── eBay OAuth token cache (per user) ──
const browseTokenCache = new Map();

async function getEbayBrowseToken(accountId, clientId, clientSecret) {
  const cached = browseTokenCache.get(accountId);
  if (cached && Date.now() < cached.expiry) return cached.token;

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const resp = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'OAuth token request failed');
  }
  browseTokenCache.set(accountId, {
    token: data.access_token,
    expiry: Date.now() + (data.expires_in - 300) * 1000,
  });
  return data.access_token;
}

// ── Test eBay token ──
app.get('/api/ebay/test-token', async (req, res) => {
  const token = req.userConfig.ebayOAuthToken || req.userConfig.ebayToken;
  if (!token) return res.json({ success: false, error: 'eBay token not configured. Go to Settings.' });

  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents">',
    '  <ErrorLanguage>en_US</ErrorLanguage>',
    '</GetUserRequest>',
  ].join('\n');

  try {
    const response = await fetch(EBAY_API_URL, {
      method: 'POST',
      headers: { ...ebayHeaders('GetUser', token), 'Content-Type': 'text/xml' },
      body: xml,
    });
    const text = await response.text();
    const ackMatch = text.match(/<Ack>([^<]+)<\/Ack>/);
    const userMatch = text.match(/<UserID>([^<]+)<\/UserID>/);
    const errMatch = text.match(/<LongMessage>([^<]+)<\/LongMessage>/);

    if (ackMatch && (ackMatch[1] === 'Success' || ackMatch[1] === 'Warning')) {
      res.json({ success: true, userId: userMatch?.[1] || 'unknown' });
    } else {
      res.json({ success: false, error: errMatch?.[1] || 'Unknown error' });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── Upload image to eBay ──
app.post('/api/ebay/upload-image', requireRole('admin', 'publisher'), async (req, res) => {
  const token = req.userConfig.ebayOAuthToken || req.userConfig.ebayToken;
  if (!token) return res.json({ success: false, error: 'eBay token not configured. Go to Settings.' });

  const { base64, filename, mimeType } = req.body;
  const imageBuffer = Buffer.from(base64, 'base64');
  const boundary = 'MIME_boundary_' + Date.now();

  const xmlPayload = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">',
    `  <PictureName>${escapeXml(filename || 'image')}</PictureName>`,
    '  <PictureSet>Supersize</PictureSet>',
    '</UploadSiteHostedPicturesRequest>',
  ].join('\n');

  const mime = mimeType || 'image/jpeg';
  const parts = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="XML Payload"\r\n`,
    `Content-Type: text/xml\r\n\r\n`,
    xmlPayload,
    `\r\n--${boundary}\r\n`,
    `Content-Disposition: form-data; name="image"; filename="${filename || 'image.jpg'}"\r\n`,
    `Content-Type: ${mime}\r\n`,
    `Content-Transfer-Encoding: binary\r\n\r\n`,
  ];

  const textBefore = Buffer.from(parts.join(''), 'utf-8');
  const textAfter = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
  const body = Buffer.concat([textBefore, imageBuffer, textAfter]);

  try {
    const response = await fetch(EBAY_API_URL, {
      method: 'POST',
      headers: {
        ...ebayHeaders('UploadSiteHostedPictures', token),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    const text = await response.text();
    const urlMatch = text.match(/<FullURL>([^<]+)<\/FullURL>/);
    const ackMatch = text.match(/<Ack>([^<]+)<\/Ack>/);

    if (urlMatch && ackMatch && (ackMatch[1] === 'Success' || ackMatch[1] === 'Warning')) {
      res.json({ success: true, url: urlMatch[1] });
    } else {
      const errMsg = text.match(/<LongMessage>([^<]+)<\/LongMessage>/);
      res.json({ success: false, error: errMsg ? errMsg[1] : 'Upload failed' });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── Seller business policy IDs ──
const SELLER_POLICIES = {
  payment: '61837856022',
  returnPolicy: '65785240022',
  shipping: [
    { id: '80178979022', name: 'Main Shipping Policy (Free Standard)', default: true },
    { id: '338880480022', name: 'Main Shipping Policy Copy' },
    { id: '383110741022', name: 'Buyer Pays - Small Items' },
    { id: '383110975022', name: 'Buyer Pays - Medium Items' },
    { id: '383111232022', name: 'Buyer Pays - Large Items' },
    { id: '384692198022', name: 'Buyer Pays - X-Large Items' },
    { id: '385250446022', name: 'Buyer Pays - XX-Large Items' },
    { id: '338881134022', name: 'Overweight Shipping Policy' },
    { id: '301209796022', name: 'Local Pickup' },
  ],
  returnPolicies: [
    { id: '30day', name: 'Main Return Policy (30 Day)', default: true,
      accepted: 'ReturnsAccepted', within: 'Days_30', paidBy: 'Buyer' },
    { id: '60day', name: 'Cisco 60 Days Return',
      accepted: 'ReturnsAccepted', within: 'Days_60', paidBy: 'Buyer' },
    { id: '30day-free', name: 'Free 30 Day Money Back / Replacement',
      accepted: 'ReturnsAccepted', within: 'Days_30', paidBy: 'Seller' },
    { id: 'none', name: 'No Returns',
      accepted: 'ReturnsNotAccepted', within: null, paidBy: null },
    { id: 'doa', name: 'Dead on Arrival',
      accepted: 'ReturnsAccepted', within: 'Days_14', paidBy: 'Seller' },
  ],
};

app.get('/api/ebay/policies', async (req, res) => {
  const oauthToken = req.userConfig.ebayOAuthToken;

  // If no OAuth token, return hardcoded policies (backward compatible)
  if (!oauthToken) {
    return res.json(SELLER_POLICIES);
  }

  // Fetch real policies from eBay Account API
  try {
    const headers = { 'Authorization': `Bearer ${oauthToken}`, 'Content-Type': 'application/json' };
    const marketplaceId = 'EBAY_US';

    const [fulfillmentResp, returnResp, paymentResp] = await Promise.all([
      fetch(`https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=${marketplaceId}`, { headers }),
      fetch(`https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=${marketplaceId}`, { headers }),
      fetch(`https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=${marketplaceId}`, { headers }),
    ]);

    const [fulfillmentData, returnData, paymentData] = await Promise.all([
      fulfillmentResp.json(),
      returnResp.json(),
      paymentResp.json(),
    ]);

    // Map shipping/fulfillment policies
    const shipping = (fulfillmentData.fulfillmentPolicies || []).map((p, i) => ({
      id: p.fulfillmentPolicyId,
      name: p.name || `Shipping Policy ${p.fulfillmentPolicyId}`,
      default: i === 0,
    }));

    // Map return policies
    const returnPolicies = (returnData.returnPolicies || []).map((p, i) => ({
      id: p.returnPolicyId,
      name: p.name || `Return Policy ${p.returnPolicyId}`,
      default: i === 0,
      // Include inline details for AddItem XML
      accepted: p.returnsAccepted ? 'ReturnsAccepted' : 'ReturnsNotAccepted',
      within: p.returnPeriod ? `Days_${p.returnPeriod.value}` : null,
      paidBy: p.returnShippingCostPayer === 'SELLER' ? 'Seller' : 'Buyer',
    }));

    // Get first payment policy ID
    const paymentPolicies = paymentData.paymentPolicies || [];
    const payment = paymentPolicies.length > 0 ? paymentPolicies[0].paymentPolicyId : '';

    res.json({ shipping, returnPolicies, payment });
  } catch (err) {
    console.error('Failed to fetch eBay policies:', err.message);
    // Fall back to hardcoded on error
    res.json(SELLER_POLICIES);
  }
});

// ── Add item listing ──
app.post('/api/ebay/add-item', requireRole('admin', 'publisher'), async (req, res) => {
  const token = req.userConfig.ebayOAuthToken || req.userConfig.ebayToken;
  if (!token) return res.json({ success: false, error: 'eBay token not configured. Go to Settings.' });

  const {
    title, description, price, categoryId,
    conditionId, pictureUrls, quantity, location,
    sku, upc, itemSpecifics, shippingPolicyId, returnPolicyId, paymentPolicyId,
    bestOfferEnabled, autoAcceptPrice, minBestOfferPrice, autoPay,
  } = req.body;

  // Validate category via Trading API GetCategories (checks leaf + expired remapping)
  let validCategoryId = categoryId;
  try {
    const catXml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<GetCategoriesRequest xmlns="urn:ebay:apis:eBLBaseComponents">',
      '  <ErrorLanguage>en_US</ErrorLanguage>',
      `  <CategoryID>${escapeXml(String(categoryId))}</CategoryID>`,
      '  <CategorySiteID>0</CategorySiteID>',
      '  <DetailLevel>ReturnAll</DetailLevel>',
      '  <ViewAllNodes>true</ViewAllNodes>',
      '  <LevelLimit>1</LevelLimit>',
      '</GetCategoriesRequest>',
    ].join('\n');
    const catResp = await fetch(EBAY_API_URL, {
      method: 'POST',
      headers: { ...ebayHeaders('GetCategories', token), 'Content-Type': 'text/xml' },
      body: catXml,
    });
    const catText = await catResp.text();
    const leafMatch = catText.match(/<LeafCategory>([^<]+)<\/LeafCategory>/);
    const expiredMatch = catText.match(/<Expired>true<\/Expired>/);

    if (expiredMatch) {
      // Category is expired — try to find the replacement
      const catIdMatches = [...catText.matchAll(/<CategoryID>([^<]+)<\/CategoryID>/g)];
      // GetCategories may return the parent or mapped category
      const newCatId = catIdMatches.length > 1 ? catIdMatches[catIdMatches.length - 1][1] : null;
      if (newCatId && newCatId !== categoryId) {
        validCategoryId = newCatId;
      }
    }
    if (leafMatch && leafMatch[1] === 'false' && !expiredMatch) {
      return res.json({ success: false, error: `Category ${categoryId} is not a leaf category. Please choose a more specific sub-category.` });
    }
  } catch (e) { /* proceed if validation fails */ }

  const pictureUrlsXml = pictureUrls.map(u => `      <PictureURL>${escapeXml(u)}</PictureURL>`).join('\n');

  let itemSpecificsXml = '';
  if (itemSpecifics && Object.keys(itemSpecifics).length > 0) {
    const pairs = Object.entries(itemSpecifics)
      .filter(([, v]) => v && (Array.isArray(v) ? v.length > 0 : String(v).trim()))
      .map(([name, value]) => {
        const vals = Array.isArray(value) ? value : [value];
        const valueXml = vals.map(v => `        <Value>${escapeXml(String(v))}</Value>`).join('\n');
        return [
          '      <NameValueList>',
          `        <Name>${escapeXml(name)}</Name>`,
          valueXml,
          '      </NameValueList>',
        ].join('\n');
      });
    if (pairs.length > 0) {
      itemSpecificsXml = `    <ItemSpecifics>\n${pairs.join('\n')}\n    </ItemSpecifics>`;
    }
  }

  const isOAuthUser = !!req.userConfig.ebayOAuthToken;

  let shipId, payId, returnPolicyXml, returnProfileXml;

  if (isOAuthUser) {
    // OAuth user: policy IDs come from their own eBay account (fetched dynamically)
    shipId = shippingPolicyId || '';
    payId = paymentPolicyId || '';
    returnPolicyXml = '';
    returnProfileXml = returnPolicyId ? [
      '      <SellerReturnProfile>',
      `        <ReturnProfileID>${escapeXml(returnPolicyId)}</ReturnProfileID>`,
      '      </SellerReturnProfile>',
    ].join('\n') : '';
  } else {
    // Manual key user: use hardcoded policies
    shipId = shippingPolicyId || SELLER_POLICIES.shipping[0].id;
    payId = SELLER_POLICIES.payment;
    const retPolicy = SELLER_POLICIES.returnPolicies.find(r => r.id === returnPolicyId)
      || SELLER_POLICIES.returnPolicies.find(r => r.default)
      || SELLER_POLICIES.returnPolicies[0];
    returnPolicyXml = [
      '    <ReturnPolicy>',
      `      <ReturnsAcceptedOption>${retPolicy.accepted}</ReturnsAcceptedOption>`,
      retPolicy.within ? `      <ReturnsWithinOption>${retPolicy.within}</ReturnsWithinOption>` : null,
      retPolicy.paidBy ? `      <ShippingCostPaidByOption>${retPolicy.paidBy}</ShippingCostPaidByOption>` : null,
      '    </ReturnPolicy>',
    ].filter(Boolean).join('\n');
    returnProfileXml = '';
  }

  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<AddItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">',
    '  <ErrorLanguage>en_US</ErrorLanguage>',
    '  <WarningLevel>High</WarningLevel>',
    '  <Item>',
    `    <Title>${escapeXml(title.substring(0, 80))}</Title>`,
    sku ? `    <SKU>${escapeXml(sku)}</SKU>` : null,
    `    <Description><![CDATA[${description}]]></Description>`,
    '    <PrimaryCategory>',
    `      <CategoryID>${escapeXml(String(validCategoryId))}</CategoryID>`,
    '    </PrimaryCategory>',
    `    <StartPrice currencyID="USD">${parseFloat(price).toFixed(2)}</StartPrice>`,
    `    <ConditionID>${escapeXml(String(conditionId))}</ConditionID>`,
    '    <Country>US</Country>',
    '    <Currency>USD</Currency>',
    `    <Location>${escapeXml(location || 'United States')}</Location>`,
    '    <DispatchTimeMax>3</DispatchTimeMax>',
    '    <ListingDuration>GTC</ListingDuration>',
    '    <ListingType>FixedPriceItem</ListingType>',
    `    <Quantity>${parseInt(quantity) || 1}</Quantity>`,
    autoPay !== false ? '    <AutoPay>true</AutoPay>' : null,
    bestOfferEnabled ? '    <BestOfferDetails>' : null,
    bestOfferEnabled ? '      <BestOfferEnabled>true</BestOfferEnabled>' : null,
    bestOfferEnabled ? '    </BestOfferDetails>' : null,
    (bestOfferEnabled && (parseFloat(autoAcceptPrice) > 0 || parseFloat(minBestOfferPrice) > 0)) ? '    <ListingDetails>' : null,
    (bestOfferEnabled && parseFloat(autoAcceptPrice) > 0) ? `      <BestOfferAutoAcceptPrice currencyID="USD">${parseFloat(autoAcceptPrice).toFixed(2)}</BestOfferAutoAcceptPrice>` : null,
    (bestOfferEnabled && parseFloat(minBestOfferPrice) > 0) ? `      <MinimumBestOfferPrice currencyID="USD">${parseFloat(minBestOfferPrice).toFixed(2)}</MinimumBestOfferPrice>` : null,
    (bestOfferEnabled && (parseFloat(autoAcceptPrice) > 0 || parseFloat(minBestOfferPrice) > 0)) ? '    </ListingDetails>' : null,
    (upc && /^(\d{8}|\d{12,14}|Does not apply)$/i.test(upc.trim())) ? '    <ProductListingDetails>' : null,
    (upc && /^(\d{8}|\d{12,14}|Does not apply)$/i.test(upc.trim())) ? `      <UPC>${escapeXml(upc.trim())}</UPC>` : null,
    (upc && /^(\d{8}|\d{12,14}|Does not apply)$/i.test(upc.trim())) ? '    </ProductListingDetails>' : null,
    '    <PictureDetails>',
    pictureUrlsXml,
    '    </PictureDetails>',
    itemSpecificsXml,
    returnPolicyXml,
    '    <SellerProfiles>',
    '      <SellerShippingProfile>',
    `        <ShippingProfileID>${escapeXml(shipId)}</ShippingProfileID>`,
    '      </SellerShippingProfile>',
    payId ? '      <SellerPaymentProfile>' : null,
    payId ? `        <PaymentProfileID>${escapeXml(payId)}</PaymentProfileID>` : null,
    payId ? '      </SellerPaymentProfile>' : null,
    returnProfileXml,
    '    </SellerProfiles>',
    '  </Item>',
    '</AddItemRequest>',
  ].filter(Boolean).join('\n');

  try {
    const response = await fetch(EBAY_API_URL, {
      method: 'POST',
      headers: {
        ...ebayHeaders('AddItem', token),
        'Content-Type': 'text/xml',
      },
      body: xml,
    });
    const text = await response.text();

    const ackMatch = text.match(/<Ack>([^<]+)<\/Ack>/);
    const itemIdMatch = text.match(/<ItemID>([^<]+)<\/ItemID>/);
    const feesBlock = text.match(/<Fees>([\s\S]*?)<\/Fees>/);

    let totalFees = '';
    if (feesBlock) {
      const feeMatch = feesBlock[1].match(/<Name>ListingFee<\/Name>\s*<Fee[^>]*>([^<]+)<\/Fee>/);
      if (feeMatch) totalFees = feeMatch[1];
    }

    if (ackMatch && (ackMatch[1] === 'Success' || ackMatch[1] === 'Warning') && itemIdMatch) {
      // Persist listing to DB (best-effort)
      try {
        await pool.query(
          `INSERT INTO listings (user_id, account_id, ebay_item_id, title, price, thumbnail_url, category_id, condition_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            req.session.userId,
            req.session.accountId,
            itemIdMatch[1],
            title.substring(0, 100),
            parseFloat(price).toFixed(2),
            pictureUrls && pictureUrls.length > 0 ? pictureUrls[0] : null,
            String(validCategoryId),
            String(conditionId),
          ]
        );
      } catch (dbErr) {
        console.error('Failed to save listing to DB:', dbErr);
      }
      // Check 1,000-listing milestone for lifetime membership
      try {
        const countResult = await pool.query(
          'SELECT COUNT(*)::int AS total FROM listings WHERE account_id = $1',
          [req.session.accountId]
        );
        if (countResult.rows[0].total >= 1000) {
          await pool.query(
            'UPDATE users SET lifetime_member = true, updated_at = NOW() WHERE id = $1 AND (lifetime_member IS NULL OR lifetime_member = false)',
            [req.session.accountId]
          );
        }
      } catch (milestoneErr) {
        console.error('Milestone check failed (non-fatal):', milestoneErr);
      }
      res.json({ success: true, itemId: itemIdMatch[1], fees: totalFees });
    } else {
      const allErrors = [];
      const errRegex = /<LongMessage>([^<]+)<\/LongMessage>/g;
      let em;
      while ((em = errRegex.exec(text)) !== null) allErrors.push(em[1]);
      res.json({
        success: false,
        error: allErrors.length > 0 ? allErrors.join(' | ') : 'Listing failed',
      });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── Find additional product images via Vision WEB_DETECTION ──
app.post('/api/find-product-images', async (req, res) => {
  if (!GOOGLE_VISION_API_KEY) return res.json({ success: true, images: [] });
  const { imageBase64 } = req.body;
  if (!imageBase64) return res.json({ success: true, images: [] });

  try {
    const visionResp = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ image: { content: imageBase64 }, features: [{ type: 'WEB_DETECTION', maxResults: 10 }] }]
      })
    });
    const visionData = await visionResp.json();
    const web = visionData.responses?.[0]?.webDetection;
    const candidates = [
      ...(web?.fullMatchingImages || []),
      ...(web?.visuallySimilarImages || [])
    ].map(i => i.url).filter(u => u && u.startsWith('http'));
    const uniqueUrls = [...new Set(candidates)].slice(0, 8);

    const images = [];
    for (const url of uniqueUrls) {
      if (images.length >= 4) break;
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 5000);
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(tid);
        if (!r.ok) continue;
        const ct = r.headers.get('content-type') || '';
        if (!ct.startsWith('image/')) continue;
        const buf = await r.arrayBuffer();
        images.push(`data:${ct.split(';')[0]};base64,${Buffer.from(buf).toString('base64')}`);
      } catch { /* skip */ }
    }
    res.json({ success: true, images });
  } catch {
    res.json({ success: true, images: [] });
  }
});

// ── Google Vision proxy ──
app.post('/api/vision/annotate', async (req, res) => {
  if (!GOOGLE_VISION_API_KEY) return res.status(400).json({ error: { message: 'Google Vision API key not configured in .env' } });
  const visionKey = GOOGLE_VISION_API_KEY;

  const { requests } = req.body;
  try {
    const resp = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${visionKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── OpenRouter (Gemini) — identify & group products from images ──

// Helper: call Gemini via OpenRouter
async function callGemini(content, maxTokens = 1000) {
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      messages: [{ role: 'user', content }],
      max_tokens: maxTokens,
      temperature: 0.1,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `Gemini API error ${resp.status}`);
  let raw = data.choices?.[0]?.message?.content?.trim() || '[]';
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(raw);
}

// Helper: run async tasks with concurrency limit
async function runWithConcurrency(tasks, limit) {
  const results = [];
  let i = 0;
  async function next() {
    const idx = i++;
    if (idx >= tasks.length) return;
    results[idx] = await tasks[idx]();
    await next();
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => next()));
  return results;
}

const BATCH_THRESHOLD = 10;
const BATCH_SIZE = 10;
const BATCH_CONCURRENCY = 3;

app.post('/api/openrouter/identify', async (req, res) => {
  if (!OPENROUTER_API_KEY) return res.status(400).json({ error: { message: 'OpenRouter API key not configured in .env' } });

  const { images } = req.body; // array of base64 strings
  if (!images || images.length === 0) return res.status(400).json({ error: { message: 'No images provided' } });

  try {
    const imageContent = images.map((b64) => ({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${b64}` }
    }));

    const prompt = `You are a product identification expert. I'm sending you ${images.length} numbered images (image 0 through image ${images.length - 1}).

For each image, identify the product shown (brand + model/type if visible).

Then GROUP images that show the SAME product together — even if the names aren't exactly identical. For example "Logitech Brio Webcam" and "Logitech Brio 4K Webcam" are the same product and must be in the same group. Use your best judgment to normalize product names.

After grouping, check if any groups are ACCESSORIES or COMPANIONS of each other. For example: a phone case is an accessory for a phone, a charger is an accessory for a laptop, a remote is an accessory for a TV. Also consider PACKAGING: if you see a generic brown/cardboard shipping box, it is almost certainly the packaging for one of the other items — treat it as an accessory of the most likely product it belongs to. Boxes are not sold separately. Think about whether a buyer would reasonably want to list these items together as a bundle.

Return ONLY valid JSON, no markdown, no explanation. Use this exact format:
{
  "groups": [
    { "groupId": 0, "productName": "Brand Model Product", "confidence": 95, "imageIndices": [0, 2, 3] },
    { "groupId": 1, "productName": "Brand Model Product", "confidence": 60, "imageIndices": [1] }
  ],
  "suggestedBundles": [
    { "mainGroupId": 0, "accessoryGroupIds": [1], "reason": "Short explanation of why these go together", "bundleConfidence": 85 }
  ]
}

Rules:
- Every image index (0 to ${images.length - 1}) must appear in exactly one group
- groupId must be the index of the group in the array (0, 1, 2, ...)
- Use the most specific and complete product name for each group
- If you truly cannot identify a product, use "Unknown product" as the name
- confidence is 0-100: how certain you are that you correctly identified the exact product (brand, model, variant). 90-100 = exact match with brand+model clearly visible, 60-89 = likely correct but some details uncertain, 30-59 = rough guess, 0-29 = unable to identify
- suggestedBundles: only include if you detect genuine accessory/companion relationships. Leave as empty array [] if no items are related
- mainGroupId: the group index of the PRIMARY product (not the accessory)
- accessoryGroupIds: array of group indices that are accessories OF the main product
- bundleConfidence: 0-100, how confident you are these items belong together as a bundle
- A group can only appear in ONE bundle (either as main or accessory, not both)`;

    const result = await callGemini([{ type: 'text', text: prompt }, ...imageContent], Math.max(1500, images.length * 150));

    // Backward compat: if Gemini returns a plain array (old format), wrap it
    let groups, suggestedBundles;
    if (Array.isArray(result)) {
      groups = result;
      suggestedBundles = [];
    } else {
      groups = result.groups || [];
      suggestedBundles = (result.suggestedBundles || []).filter(b =>
        typeof b.mainGroupId === 'number' &&
        Array.isArray(b.accessoryGroupIds) &&
        typeof b.reason === 'string' &&
        typeof b.bundleConfidence === 'number'
      );
    }

    res.json({ groups, suggestedBundles });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── LOT mode: identify individual items within lot image(s) ──
app.post('/api/openrouter/identify-lot', async (req, res) => {
  if (!OPENROUTER_API_KEY) return res.status(400).json({ error: { message: 'OpenRouter API key not configured in .env' } });

  const { images } = req.body;
  if (!images || images.length === 0) return res.status(400).json({ error: { message: 'No images provided' } });

  try {
    const imageContent = images.map((b64) => ({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${b64}` }
    }));

    const prompt = `You will be analyzing ${images.length > 1 ? images.length + ' images that together show' : 'an image that contains'} multiple items (such as books on a shelf, products in a display, trading cards, or any collection of items visible in a photograph). Your task is to identify each individual item as accurately as possible and provide a descriptive title for each one.

Your goal is to:
1. Carefully examine all visible items in the image${images.length > 1 ? 's' : ''}
2. Identify each distinct item individually
3. Provide an accurate, descriptive title for each item

Carefully scan the image${images.length > 1 ? 's' : ''} systematically from left to right, top to bottom. Note any visible text, labels, titles, or identifying features on each item. Count all distinct items.

When identifying items, follow these guidelines:
- For books: Include the full title as visible on the spine or cover, and author name if visible
- For products: Include brand name, product name, and any distinguishing features (size, flavor, color, etc.)
- For cards: Include the card name, set name, or any identifying numbers/text visible
- For unlabeled items: Provide a clear descriptive title based on what the item appears to be
- If an item is partially obscured but you can make a reasonable identification, note this with phrases like "appears to be" or "partially visible"
- If an item cannot be identified at all, note it as "Unidentifiable item" with a brief description of what's visible

Your final answer MUST be ONLY valid JSON, no markdown, no explanation outside the JSON. Use this exact format:
{
  "itemCount": <number>,
  "items": [
    { "index": 1, "title": "<descriptive title>", "details": "<additional details or empty string>" },
    { "index": 2, "title": "<descriptive title>", "details": "<additional details or empty string>" }
  ]
}

Rules:
- Every distinct item visible in the image${images.length > 1 ? 's' : ''} must be listed
- "title" should be the most specific, descriptive name you can determine (brand + product name + distinguishing features)
- "details" should include author, condition notes, or any extra info in parenthetical style — leave as "" if nothing extra to note
- Be thorough: scan every part of the image${images.length > 1 ? 's' : ''}, do not skip items just because they are small or partially visible`;

    const maxTokens = Math.max(2000, images.length * 1500);
    const result = await callGemini([{ type: 'text', text: prompt }, ...imageContent], maxTokens);

    // Normalize: ensure we have the expected format
    const itemCount = result.itemCount || (result.items ? result.items.length : 0);
    const items = (result.items || []).map((item, i) => ({
      index: item.index || i + 1,
      title: item.title || `Unidentified item ${i + 1}`,
      details: item.details || '',
    }));

    res.json({ itemCount, items });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── OpenAI proxy ──
app.post('/api/openai/chat', async (req, res) => {
  if (!OPENAI_API_KEY) return res.status(400).json({ error: { message: 'OpenAI API key not configured in .env' } });
  const apiKey = OPENAI_API_KEY;
  const model = OPENAI_MODEL;

  const { messages, temperature, max_completion_tokens } = req.body;
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: temperature ?? 0.7,
        max_completion_tokens: max_completion_tokens ?? 4000,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Claude proxy (via OpenRouter) ──
app.post('/api/claude/chat', async (req, res) => {
  if (!OPENROUTER_API_KEY) return res.status(400).json({ error: { message: 'OpenRouter API key not configured in .env' } });

  const { messages, temperature, max_tokens } = req.body;
  try {
    // Convert messages: extract system prompt for OpenRouter compatibility
    let systemPrompt = '';
    const chatMessages = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt = msg.content;
      } else {
        chatMessages.push(msg);
      }
    }

    const body = {
      model: CLAUDE_MODEL,
      messages: chatMessages,
      temperature: temperature ?? 0.4,
      max_tokens: max_tokens ?? 4096,
    };
    if (systemPrompt) {
      body.messages = [{ role: 'system', content: systemPrompt }, ...chatMessages];
    }

    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Generate product infographic features ──
app.post('/api/generate-images', async (req, res) => {
  if (!OPENROUTER_API_KEY) return res.status(400).json({ success: false, error: 'OpenRouter API key not configured' });

  const { imageBase64, images, title, description } = req.body;
  if (!title && !description) return res.status(400).json({ success: false, error: 'Title or description required' });

  try {
    const descText = description
      ? description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 2000)
      : '';

    const content = [];
    // Support multiple images (new) or single image (backwards compat)
    const allImages = images || (imageBase64 ? [imageBase64] : []);
    for (const img of allImages) {
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img}` } });
    }
    content.push({
      type: 'text',
      text: `You are an expert product analyst. Analyze this product listing and return structured data for professional eBay infographic images. Use your knowledge of this product model/brand to add specific details beyond what's visible.

Product: "${title}"${descText ? `\n\nDescription:\n${descText}` : ''}

Return ONLY valid JSON in exactly this format:
{
  "accentColor": "#hexcolor",
  "headline": "Short punchy marketing headline (max 6 words, like 'Built for high-speed business.' or 'Enterprise power. Zero subscriptions.')",
  "featureGroups": [
    {
      "id": "specs",
      "features": [
        { "name": "Short Name", "detail": "Full specification text, up to 60 chars", "icon": "emoji", "position": "top-left", "hx": 0.45, "hy": 0.55 }
      ]
    },
    { "id": "design", "features": [...] },
    { "id": "value", "features": [...] }
  ],
  "conditionBadges": [
    { "label": "Badge text (max 20 chars)", "colorKey": "green" }
  ]
}

Rules for headline:
- Short, punchy, marketing-style headline for the product (NOT the product name)
- Max 6 words. Examples: "Built for high-speed business.", "Enterprise power. Zero subscriptions.", "Unparalleled network defense.", "Professional grade. Affordable price."
- Should highlight the product's key value proposition or use case
- End with a period

Rules for featureGroups — return exactly 3 groups, each with 5–6 features. Each group covers a DIFFERENT angle:

Group "specs" — Technical specifications only: materials, dimensions, model numbers, performance figures, connectivity, compatibility. Use your product knowledge to be precise (e.g. "Full-Grain Suede" not just "Suede", "Vulcanized Gum Sole" not just "Rubber Sole").

Group "design" — Key selling points and physical features: build quality, form factor, ports/connections visible, design advantages (fanless, compact, rack-mountable), what makes it stand out from competitors. Focus on buyer-relevant attributes, not just colors.

Group "value" — Buyer-focused highlights only: brand heritage, retail price context, resale value, what's included, ideal use (e.g. "Court-to-Street Style", "Collector's Item"), condition clues.

Rules for each feature:
- "name": 1–3 very specific words (NOT generic — "Herringbone Tread" not "Rubber Sole", "Perforated Toe Cap" not "Breathable")
- "detail": full specification text, max 60 chars — do NOT abbreviate or truncate, write the complete fact
- "icon": single most relevant emoji
- "position": one of top-left, top-right, bottom-left, bottom-right, left, right — use all 6 positions, no repeats within a group
- "hx": 0.0–1.0 — where on the product image this feature is physically located (0=left, 1=right)
- "hy": 0.0–1.0 — where on the product image this feature is physically located (0=top, 1=bottom)

Rules for accentColor:
- Brand-appropriate hex (Nike → "#ff6600", Apple → "#1c1c1e", Jordan → "#cc0000", Adidas → "#000000", Dell → "#0076ce", Sony → "#003087", Cisco → "#049fd9", default → "#4f6ef7")

Rules for conditionBadges (exactly 4):
- "label": short trust signal, max 20 chars, must be COMPLETE words (never truncate)
- "colorKey": green (cosmetic condition), blue (completeness), amber (functionality), red (notable detail)`,
    });

    const result = await callGemini(content, 1800);
    const accentColor = /^#[0-9a-fA-F]{6}$/.test(result.accentColor || '') ? result.accentColor : '#4f6ef7';
    const validPositions = new Set(['top-left','top-right','bottom-left','bottom-right','left','right']);

    const featureGroups = [];
    if (Array.isArray(result.featureGroups)) {
      for (const group of result.featureGroups.slice(0, 3)) {
        const features = (group.features || []).slice(0, 6).map(f => {
          if (!f) return null;
          if (!validPositions.has(f.position)) f.position = null;
          f.hx = (typeof f.hx === 'number') ? Math.max(0, Math.min(1, f.hx)) : 0.5;
          f.hy = (typeof f.hy === 'number') ? Math.max(0, Math.min(1, f.hy)) : 0.5;
          return f;
        }).filter(Boolean);
        featureGroups.push({ id: group.id || 'group', features });
      }
    }
    // Fallback: if Gemini returned old-style flat features, wrap them
    if (featureGroups.length === 0 && Array.isArray(result.features)) {
      const flat = result.features.slice(0, 6).map(f => { if (f && !validPositions.has(f?.position)) f.position = null; return f; }).filter(Boolean);
      featureGroups.push({ id: 'specs', features: flat });
    }
    const features = featureGroups[0]?.features || [];

    const validColorKeys = new Set(['green','blue','amber','red']);
    const conditionBadges = (result.conditionBadges || [])
      .filter(b => b && typeof b.label === 'string' && validColorKeys.has(b.colorKey))
      .slice(0, 4)
      .map(b => ({ ...b, label: b.label.substring(0, 28) }));

    const headline = (typeof result.headline === 'string' && result.headline.length > 0)
      ? result.headline.substring(0, 80)
      : '';

    res.json({ success: true, features, featureGroups, accentColor, conditionBadges, headline });
  } catch (err) {
    console.error('Generate images error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Item aspects for a category via Taxonomy API ──
app.get('/api/ebay/item-aspects', async (req, res) => {
  const { ebayClientId, ebayClientSecret, ebayOAuthToken } = req.userConfig;
  if (!ebayOAuthToken && (!ebayClientId || !ebayClientSecret)) return res.json({ success: false, error: 'eBay OAuth credentials not configured. Go to Settings.' });

  const { category_id } = req.query;
  if (!category_id) return res.json({ success: false, error: 'Missing category_id' });

  try {
    const token = ebayOAuthToken || await getEbayBrowseToken(req.session.accountId, ebayClientId, ebayClientSecret);
    const url = `https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${encodeURIComponent(category_id)}`;

    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await resp.json();

    if (!resp.ok) {
      return res.json({ success: false, error: data.errors?.[0]?.longMessage || `Taxonomy API error ${resp.status}` });
    }

    const aspects = (data.aspects || []).map(a => ({
      name: a.localizedAspectName,
      required: a.aspectConstraint?.aspectRequired || false,
      usage: a.aspectConstraint?.aspectUsage || 'OPTIONAL',
      mode: a.aspectConstraint?.aspectMode || 'FREE_TEXT',
      multi: a.aspectConstraint?.itemToAspectCardinality === 'MULTI',
      values: (a.aspectValues || []).map(v => v.localizedValue),
    }));

    res.json({ success: true, aspects });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── Category suggestions via Taxonomy API ──
app.get('/api/ebay/category-suggestions', async (req, res) => {
  const { ebayClientId, ebayClientSecret, ebayOAuthToken } = req.userConfig;
  if (!ebayOAuthToken && (!ebayClientId || !ebayClientSecret)) return res.json({ success: false, error: 'eBay OAuth credentials not configured. Go to Settings.' });

  const { q } = req.query;
  if (!q) return res.json({ success: false, error: 'Missing search query (q)' });

  try {
    const token = ebayOAuthToken || await getEbayBrowseToken(req.session.accountId, ebayClientId, ebayClientSecret);
    const url = `https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(q)}`;

    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await resp.json();

    if (!resp.ok) {
      return res.json({ success: false, error: data.errors?.[0]?.longMessage || data.errors?.[0]?.message || `Taxonomy API error ${resp.status}` });
    }

    const rawSuggestions = (data.categorySuggestions || []).map(s => {
      const ancestors = (s.categoryTreeNodeAncestors || [])
        .sort((a, b) => a.categoryTreeNodeLevel - b.categoryTreeNodeLevel)
        .map(a => a.categoryName);
      const pathStr = [...ancestors, s.category.categoryName].join(' > ');
      return { id: s.category.categoryId, name: s.category.categoryName, path: pathStr };
    });

    res.json({ success: true, suggestions: rawSuggestions });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── Price range lookup via Browse API ──
app.get('/api/ebay/price-range', async (req, res) => {
  const { ebayClientId, ebayClientSecret, ebayOAuthToken } = req.userConfig;
  if (!ebayOAuthToken && (!ebayClientId || !ebayClientSecret)) return res.json({ success: false, error: 'eBay OAuth credentials not configured. Go to Settings.' });

  const { q, category_id, condition_id } = req.query;
  if (!q) return res.json({ success: false, error: 'Missing search query (q)' });

  try {
    const token = ebayOAuthToken || await getEbayBrowseToken(req.session.accountId, ebayClientId, ebayClientSecret);

    let filters = 'priceCurrency:USD,buyingOptions:{FIXED_PRICE|BEST_OFFER}';
    if (condition_id) filters += `,conditionIds:{${condition_id}}`;

    let url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&filter=${encodeURIComponent(filters)}&sort=price&limit=200`;
    if (category_id) url += `&category_ids=${encodeURIComponent(category_id)}`;

    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
    });
    const data = await resp.json();

    if (!resp.ok) {
      return res.json({ success: false, error: data.errors?.[0]?.longMessage || data.errors?.[0]?.message || `Browse API error ${resp.status}` });
    }

    const items = data.itemSummaries || [];
    if (items.length === 0) {
      return res.json({ success: true, count: 0, low: null, high: null, avg: null, median: null });
    }

    const prices = items
      .map(item => parseFloat(item.price?.value))
      .filter(p => !isNaN(p) && p > 0)
      .sort((a, b) => a - b);

    if (prices.length === 0) {
      return res.json({ success: true, count: 0, low: null, high: null, avg: null, median: null });
    }

    const low = prices[0];
    const high = prices[prices.length - 1];
    const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];

    res.json({
      success: true,
      count: prices.length,
      low: +low.toFixed(2),
      high: +high.toFixed(2),
      avg: +avg.toFixed(2),
      median: +median.toFixed(2),
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── Market price research via Browse API (active listings) ──
app.get('/api/ebay/sold-listings', async (req, res) => {
  const { ebayClientId, ebayClientSecret, ebayOAuthToken } = req.userConfig;
  const appClientId = ebayClientId || process.env.EBAY_APP_CLIENT_ID;
  const appClientSecret = ebayClientSecret || process.env.EBAY_APP_CLIENT_SECRET;
  if (!ebayOAuthToken && (!appClientId || !appClientSecret)) {
    return res.json({ success: false, error: 'eBay credentials not configured. Go to Settings.' });
  }

  const { q, category_id, condition_id } = req.query;
  if (!q) return res.json({ success: false, error: 'Missing search query (q)' });

  try {
    const token = ebayOAuthToken || await getEbayBrowseToken(req.session.accountId, appClientId, appClientSecret);

    let filters = 'priceCurrency:USD,buyingOptions:{FIXED_PRICE|BEST_OFFER|AUCTION}';
    if (condition_id) filters += `,conditionIds:{${condition_id}}`;

    let url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&filter=${encodeURIComponent(filters)}&sort=price&limit=100`;
    if (category_id) url += `&category_ids=${encodeURIComponent(category_id)}`;

    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
    });
    const data = await resp.json();

    if (!resp.ok) {
      return res.json({ success: false, error: data.errors?.[0]?.longMessage || data.errors?.[0]?.message || `Browse API error ${resp.status}` });
    }

    const items = data.itemSummaries || [];
    if (items.length === 0) {
      return res.json({ success: true, count: 0, stats: null, listings: [] });
    }

    const listings = items.map(item => ({
      title: item.title || '',
      price: parseFloat(item.price?.value || 0),
      condition: item.condition || 'Unknown',
      type: item.buyingOptions?.includes('AUCTION') ? 'Auction' : 'Fixed',
      url: item.itemWebUrl || '',
      image: item.image?.imageUrl || '',
    })).filter(l => l.price > 0);

    if (listings.length === 0) {
      return res.json({ success: true, count: 0, stats: null, listings: [] });
    }

    const prices = listings.map(l => l.price).sort((a, b) => a - b);
    const low = prices[0];
    const high = prices[prices.length - 1];
    const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];

    res.json({
      success: true,
      count: listings.length,
      stats: {
        avg: +avg.toFixed(2),
        median: +median.toFixed(2),
        low: +low.toFixed(2),
        high: +high.toFixed(2),
      },
      listings,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── Sold listings scraper (actual sold data from eBay search page) ──
const scrapeCache = new Map();
const SCRAPE_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

app.get('/api/ebay/sold-scrape', requireAuth, loadUserConfig, async (req, res) => {
  const { q, condition } = req.query;
  if (!q) return res.json({ success: false, error: 'Missing search query (q)' });

  const cacheKey = `${q.toLowerCase().trim()}|${condition || ''}`;
  const cached = scrapeCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SCRAPE_CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    let url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1&_ipg=120&_sop=13`;
    if (condition) url += `&LH_ItemCondition=${encodeURIComponent(condition)}`;

    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!resp.ok) {
      return res.json({ success: false, error: `eBay returned status ${resp.status}` });
    }

    const html = await resp.text();
    const $ = cheerio.load(html);

    const listings = [];

    $('li[data-listingid]').each((_, el) => {
      const card = $(el);

      // Title
      const title = card.find('.s-card__title span').first().text().trim();
      if (!title) return;

      // Price
      const priceText = card.find('.s-card__price').first().text().trim();
      const priceRange = priceText.match(/\$([\d,]+\.?\d*)\s*to\s*\$([\d,]+\.?\d*)/);
      let price;
      if (priceRange) {
        price = (parseFloat(priceRange[1].replace(/,/g, '')) + parseFloat(priceRange[2].replace(/,/g, ''))) / 2;
      } else {
        const priceMatch = priceText.match(/\$([\d,]+\.?\d*)/);
        price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : 0;
      }
      if (price <= 0) return;

      // Sold date
      const cardText = card.text();
      const dateMatch = cardText.match(/Sold\s+([A-Z][a-z]+\s+\d+,\s+\d{4})/);
      const soldDate = dateMatch ? dateMatch[1].trim() : '';

      // Condition
      const conditionText = card.find('.s-card__subtitle span').first().text().trim();
      const condition = conditionText.replace(/\s*·\s*$/, '').trim() || 'Unknown';

      // Shipping
      const shippingText = cardText.match(/(Free delivery|[\+]?\$[\d.]+\s*delivery)/i);
      let shipping = 0;
      let shippingLabel = 'Free';
      if (shippingText) {
        if (shippingText[1].toLowerCase().includes('free')) {
          shipping = 0;
          shippingLabel = 'Free';
        } else {
          const shipMatch = shippingText[1].match(/\$([\d.]+)/);
          shipping = shipMatch ? parseFloat(shipMatch[1]) : 0;
          shippingLabel = `$${shipping.toFixed(2)}`;
        }
      }

      // Image
      const imgEl = card.find('img').first();
      const image = imgEl.attr('src') || imgEl.attr('data-defer-load') || '';

      // URL (clean, no tracking params)
      const linkEl = card.find('a[href*="/itm/"]').first();
      const itemUrl = linkEl.attr('href') || '';
      const cleanUrl = itemUrl.split('?')[0];

      listings.push({
        title,
        price: +price.toFixed(2),
        shipping,
        shippingLabel,
        soldDate,
        condition,
        url: cleanUrl,
        image,
      });
    });

    if (listings.length === 0) {
      return res.json({ success: true, count: 0, stats: null, listings: [] });
    }

    const prices = listings.map(l => l.price).sort((a, b) => a - b);
    const low = prices[0];
    const high = prices[prices.length - 1];
    const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];

    const result = {
      success: true,
      count: listings.length,
      stats: {
        avg: +avg.toFixed(2),
        median: +median.toFixed(2),
        low: +low.toFixed(2),
        high: +high.toFixed(2),
      },
      listings,
    };

    scrapeCache.set(cacheKey, { ts: Date.now(), data: result });
    res.json(result);
  } catch (err) {
    console.error('Sold scrape error:', err);
    res.json({ success: false, error: 'Scraping temporarily unavailable' });
  }
});

// ── Search active listings via Browse API (for copying specs) ──
app.get('/api/ebay/search-listings', requireAuth, loadUserConfig, async (req, res) => {
  const { ebayClientId, ebayClientSecret, ebayOAuthToken } = req.userConfig;
  const appClientId = ebayClientId || process.env.EBAY_APP_CLIENT_ID;
  const appClientSecret = ebayClientSecret || process.env.EBAY_APP_CLIENT_SECRET;
  if (!ebayOAuthToken && (!appClientId || !appClientSecret)) {
    return res.json({ success: false, error: 'eBay credentials not configured. Go to Settings.' });
  }

  const { q } = req.query;
  if (!q) return res.json({ success: false, error: 'Missing search query (q)' });

  try {
    const token = ebayOAuthToken || await getEbayBrowseToken(req.session.accountId, appClientId, appClientSecret);

    const filters = 'priceCurrency:USD,buyingOptions:{FIXED_PRICE|BEST_OFFER}';
    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&filter=${encodeURIComponent(filters)}&sort=price&limit=50`;

    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
    });
    const data = await resp.json();

    if (!resp.ok) {
      return res.json({ success: false, error: data.errors?.[0]?.longMessage || `Browse API error ${resp.status}` });
    }

    const items = data.itemSummaries || [];
    const listings = items.map(item => ({
      title: item.title || '',
      price: parseFloat(item.price?.value || 0),
      condition: item.condition || 'Unknown',
      image: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || '',
      url: item.itemWebUrl || '',
      itemId: item.itemId || '',
    })).filter(l => l.price > 0);

    res.json({ success: true, count: listings.length, listings });
  } catch (err) {
    console.error('Search listings error:', err);
    res.json({ success: false, error: err.message });
  }
});

// ── Get Item Specifics via Browse API ──
app.get('/api/ebay/listing-specs', requireAuth, loadUserConfig, async (req, res) => {
  const { ebayClientId, ebayClientSecret, ebayOAuthToken } = req.userConfig;
  const appClientId = ebayClientId || process.env.EBAY_APP_CLIENT_ID;
  const appClientSecret = ebayClientSecret || process.env.EBAY_APP_CLIENT_SECRET;
  if (!ebayOAuthToken && (!appClientId || !appClientSecret)) {
    return res.json({ success: false, error: 'eBay credentials not configured. Go to Settings.' });
  }

  const { itemId } = req.query;
  if (!itemId) return res.json({ success: false, error: 'Missing itemId' });

  try {
    const token = ebayOAuthToken || await getEbayBrowseToken(req.session.accountId, appClientId, appClientSecret);

    const url = `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemId)}`;
    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
    });
    const data = await resp.json();

    if (!resp.ok) {
      return res.json({ success: false, error: data.errors?.[0]?.longMessage || `Browse API error ${resp.status}` });
    }

    const specs = {};
    if (data.localizedAspects) {
      for (const aspect of data.localizedAspects) {
        if (aspect.name && aspect.value && aspect.value !== 'Does not apply') {
          specs[aspect.name] = aspect.value;
        }
      }
    }

    if (Object.keys(specs).length === 0) {
      return res.json({ success: false, error: 'No specs found on this listing' });
    }

    res.json({ success: true, specs });
  } catch (err) {
    console.error('Listing specs scrape error:', err);
    res.json({ success: false, error: 'Could not fetch listing page' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  LazyListings running at http://localhost:${PORT}\n`);
});
