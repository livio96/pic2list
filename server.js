require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const pool = require('./db');
const { requireAuth, requireRole, loadUserConfig } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const configRoutes = require('./routes/config');
const listingsRoutes = require('./routes/listings');
const usersRoutes = require('./routes/users');
const draftsRoutes = require('./routes/drafts');
const ebayOAuthRoutes = require('./routes/ebay-oauth');

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
  const token = req.userConfig.ebayToken;
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
  const token = req.userConfig.ebayToken;
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

app.get('/api/ebay/policies', (req, res) => {
  res.json(SELLER_POLICIES);
});

// ── Add item listing ──
app.post('/api/ebay/add-item', requireRole('admin', 'publisher'), async (req, res) => {
  const token = req.userConfig.ebayToken;
  if (!token) return res.json({ success: false, error: 'eBay token not configured. Go to Settings.' });

  const {
    title, description, price, categoryId,
    conditionId, pictureUrls, quantity, location,
    sku, itemSpecifics, shippingPolicyId, returnPolicyId,
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

  const shipId = shippingPolicyId || SELLER_POLICIES.shipping[0].id;
  const payId = SELLER_POLICIES.payment;

  // Resolve return policy to inline details (bypasses deprecated returnDescription in profiles)
  const retPolicy = SELLER_POLICIES.returnPolicies.find(r => r.id === returnPolicyId)
    || SELLER_POLICIES.returnPolicies.find(r => r.default)
    || SELLER_POLICIES.returnPolicies[0];

  const returnPolicyXml = [
    '    <ReturnPolicy>',
    `      <ReturnsAcceptedOption>${retPolicy.accepted}</ReturnsAcceptedOption>`,
    retPolicy.within ? `      <ReturnsWithinOption>${retPolicy.within}</ReturnsWithinOption>` : null,
    retPolicy.paidBy ? `      <ShippingCostPaidByOption>${retPolicy.paidBy}</ShippingCostPaidByOption>` : null,
    '    </ReturnPolicy>',
  ].filter(Boolean).join('\n');

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
    '    <PictureDetails>',
    pictureUrlsXml,
    '    </PictureDetails>',
    itemSpecificsXml,
    returnPolicyXml,
    '    <SellerProfiles>',
    '      <SellerShippingProfile>',
    `        <ShippingProfileID>${escapeXml(shipId)}</ShippingProfileID>`,
    '      </SellerShippingProfile>',
    '      <SellerPaymentProfile>',
    `        <PaymentProfileID>${escapeXml(payId)}</PaymentProfileID>`,
    '      </SellerPaymentProfile>',
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

// ── Item aspects for a category via Taxonomy API ──
app.get('/api/ebay/item-aspects', async (req, res) => {
  const { ebayClientId, ebayClientSecret } = req.userConfig;
  if (!ebayClientId || !ebayClientSecret) return res.json({ success: false, error: 'eBay OAuth credentials not configured. Go to Settings.' });

  const { category_id } = req.query;
  if (!category_id) return res.json({ success: false, error: 'Missing category_id' });

  try {
    const token = await getEbayBrowseToken(req.session.accountId, ebayClientId, ebayClientSecret);
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
  const { ebayClientId, ebayClientSecret } = req.userConfig;
  if (!ebayClientId || !ebayClientSecret) return res.json({ success: false, error: 'eBay OAuth credentials not configured. Go to Settings.' });

  const { q } = req.query;
  if (!q) return res.json({ success: false, error: 'Missing search query (q)' });

  try {
    const token = await getEbayBrowseToken(req.session.accountId, ebayClientId, ebayClientSecret);
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
  const { ebayClientId, ebayClientSecret } = req.userConfig;
  if (!ebayClientId || !ebayClientSecret) return res.json({ success: false, error: 'eBay OAuth credentials not configured. Go to Settings.' });

  const { q, category_id, condition_id } = req.query;
  if (!q) return res.json({ success: false, error: 'Missing search query (q)' });

  try {
    const token = await getEbayBrowseToken(req.session.accountId, ebayClientId, ebayClientSecret);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  LazyListings running at http://localhost:${PORT}\n`);
});
