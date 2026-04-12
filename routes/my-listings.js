const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/auth');

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

// ── GET /api/my-listings — Fetch all active listings from eBay ──
router.get('/', async (req, res) => {
  const token = req.userConfig.ebayOAuthToken || req.userConfig.ebayToken;
  if (!token) return res.status(400).json({ error: 'eBay not connected' });

  const page = parseInt(req.query.page) || 1;
  const perPage = parseInt(req.query.perPage) || 50;

  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">',
    '  <ErrorLanguage>en_US</ErrorLanguage>',
    '  <WarningLevel>High</WarningLevel>',
    '  <ActiveList>',
    '    <Sort>TimeLeft</Sort>',
    '    <Pagination>',
    `      <EntriesPerPage>${perPage}</EntriesPerPage>`,
    `      <PageNumber>${page}</PageNumber>`,
    '    </Pagination>',
    '  </ActiveList>',
    '</GetMyeBaySellingRequest>',
  ].join('\n');

  try {
    const response = await fetch(EBAY_API_URL, {
      method: 'POST',
      headers: { ...ebayHeaders('GetMyeBaySelling', token), 'Content-Type': 'text/xml' },
      body: xml,
    });
    const text = await response.text();

    const ackMatch = text.match(/<Ack>([^<]+)<\/Ack>/);
    if (!ackMatch || (ackMatch[1] !== 'Success' && ackMatch[1] !== 'Warning')) {
      const errMsg = text.match(/<ShortMessage>([^<]+)<\/ShortMessage>/);
      return res.status(400).json({ error: errMsg ? errMsg[1] : 'eBay API error' });
    }

    // Parse pagination
    const totalEntries = parseInt((text.match(/<TotalNumberOfEntries>([^<]+)<\/TotalNumberOfEntries>/) || [])[1]) || 0;
    const totalPages = parseInt((text.match(/<TotalNumberOfPages>([^<]+)<\/TotalNumberOfPages>/) || [])[1]) || 1;

    // Parse items
    const items = [];
    const itemBlocks = text.match(/<Item>([\s\S]*?)<\/Item>/g) || [];
    for (const block of itemBlocks) {
      const get = (tag) => {
        const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
        return m ? m[1] : '';
      };
      const getPrice = () => {
        const m = block.match(/<CurrentPrice[^>]*>([^<]+)<\/CurrentPrice>/);
        return m ? m[1] : '';
      };
      const getPicture = () => {
        const m = block.match(/<GalleryURL>([^<]+)<\/GalleryURL>/);
        return m ? m[1] : '';
      };
      const getQuantity = () => {
        const qTotal = parseInt(get('Quantity')) || 0;
        const qSold = block.match(/<SellingStatus>[\s\S]*?<QuantitySold>(\d+)<\/QuantitySold>[\s\S]*?<\/SellingStatus>/);
        const sold = qSold ? parseInt(qSold[1]) : 0;
        return { total: qTotal, sold, available: qTotal - sold };
      };
      const getWatchers = () => {
        const m = block.match(/<WatchCount>([^<]+)<\/WatchCount>/);
        return m ? parseInt(m[1]) : 0;
      };
      const getViewCount = () => {
        const m = block.match(/<HitCount>([^<]+)<\/HitCount>/);
        return m ? parseInt(m[1]) : 0;
      };
      const getListingType = () => get('ListingType');
      const getTimeLeft = () => get('TimeLeft');

      const qty = getQuantity();
      items.push({
        itemId: get('ItemID'),
        title: get('Title'),
        price: getPrice(),
        picture: getPicture(),
        quantity: qty.total,
        quantitySold: qty.sold,
        quantityAvailable: qty.available,
        watchers: getWatchers(),
        views: getViewCount(),
        listingType: getListingType(),
        timeLeft: getTimeLeft(),
        sku: get('SKU'),
        conditionId: get('ConditionID'),
      });
    }

    res.json({
      items,
      pagination: { page, perPage, totalEntries, totalPages },
    });
  } catch (err) {
    console.error('GetMyeBaySelling error:', err);
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

// ── GET /api/my-listings/:itemId — Full item details ──
router.get('/:itemId', async (req, res) => {
  const token = req.userConfig.ebayOAuthToken || req.userConfig.ebayToken;
  if (!token) return res.status(400).json({ error: 'eBay not connected' });

  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">',
    '  <ErrorLanguage>en_US</ErrorLanguage>',
    '  <WarningLevel>High</WarningLevel>',
    `  <ItemID>${escapeXml(req.params.itemId)}</ItemID>`,
    '  <DetailLevel>ReturnAll</DetailLevel>',
    '  <IncludeItemSpecifics>true</IncludeItemSpecifics>',
    '</GetItemRequest>',
  ].join('\n');

  try {
    const response = await fetch(EBAY_API_URL, {
      method: 'POST',
      headers: { ...ebayHeaders('GetItem', token), 'Content-Type': 'text/xml' },
      body: xml,
    });
    const text = await response.text();

    const ackMatch = text.match(/<Ack>([^<]+)<\/Ack>/);
    if (!ackMatch || (ackMatch[1] !== 'Success' && ackMatch[1] !== 'Warning')) {
      const errMsg = text.match(/<ShortMessage>([^<]+)<\/ShortMessage>/);
      return res.status(400).json({ error: errMsg ? errMsg[1] : 'eBay API error' });
    }

    const get = (tag) => {
      const m = text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
      return m ? m[1] : '';
    };

    // Parse pictures
    const pictures = [];
    const picMatches = text.match(/<PictureURL>([^<]+)<\/PictureURL>/g) || [];
    for (const pm of picMatches) {
      const url = pm.match(/<PictureURL>([^<]+)<\/PictureURL>/);
      if (url) pictures.push(url[1]);
    }

    // Parse item specifics
    const specifics = {};
    const nvMatches = text.match(/<NameValueList>([\s\S]*?)<\/NameValueList>/g) || [];
    for (const nv of nvMatches) {
      const name = (nv.match(/<Name>([^<]+)<\/Name>/) || [])[1];
      const value = (nv.match(/<Value>([^<]+)<\/Value>/) || [])[1];
      if (name && value) specifics[name] = value;
    }

    // Parse description (CDATA)
    let description = '';
    const descMatch = text.match(/<Description>([\s\S]*?)<\/Description>/);
    if (descMatch) {
      description = descMatch[1].replace(/<!\[CDATA\[/, '').replace(/\]\]>/, '');
    }

    // Parse price
    const priceMatch = text.match(/<StartPrice[^>]*>([^<]+)<\/StartPrice>/);
    const price = priceMatch ? priceMatch[1] : '';

    // Parse best offer
    const bestOfferEnabled = /<BestOfferEnabled>true<\/BestOfferEnabled>/i.test(text);
    const autoAcceptMatch = text.match(/<BestOfferAutoAcceptPrice[^>]*>([^<]+)<\/BestOfferAutoAcceptPrice>/);
    const minOfferMatch = text.match(/<MinimumBestOfferPrice[^>]*>([^<]+)<\/MinimumBestOfferPrice>/);

    // Parse quantity
    const quantity = parseInt(get('Quantity')) || 1;
    const qSold = text.match(/<SellingStatus>[\s\S]*?<QuantitySold>(\d+)<\/QuantitySold>/);
    const quantitySold = qSold ? parseInt(qSold[1]) : 0;

    // Parse category
    const categoryId = get('CategoryID');
    const categoryName = (text.match(/<PrimaryCategory>[\s\S]*?<CategoryName>([^<]+)<\/CategoryName>/) || [])[1] || '';

    // Parse condition
    const conditionId = get('ConditionID');
    const conditionName = get('ConditionDisplayName');

    // Parse SKU / UPC
    const sku = get('SKU');
    const upcMatch = text.match(/<ProductListingDetails>[\s\S]*?<UPC>([^<]+)<\/UPC>/);
    const upc = upcMatch ? upcMatch[1] : '';

    // Parse listing URL
    const listingUrl = get('ViewItemURL');

    // Parse shipping profile
    const shippingProfileId = (text.match(/<ShippingProfileID>([^<]+)<\/ShippingProfileID>/) || [])[1] || '';
    const returnProfileId = (text.match(/<ReturnProfileID>([^<]+)<\/ReturnProfileID>/) || [])[1] || '';
    const paymentProfileId = (text.match(/<PaymentProfileID>([^<]+)<\/PaymentProfileID>/) || [])[1] || '';

    res.json({
      itemId: get('ItemID'),
      title: get('Title'),
      description,
      price,
      pictures,
      specifics,
      quantity,
      quantitySold,
      quantityAvailable: quantity - quantitySold,
      categoryId,
      categoryName,
      conditionId,
      conditionName,
      sku,
      upc,
      listingUrl,
      bestOfferEnabled,
      autoAcceptPrice: autoAcceptMatch ? autoAcceptMatch[1] : '',
      minBestOfferPrice: minOfferMatch ? minOfferMatch[1] : '',
      shippingProfileId,
      returnProfileId,
      paymentProfileId,
    });
  } catch (err) {
    console.error('GetItem error:', err);
    res.status(500).json({ error: 'Failed to fetch item details' });
  }
});

// ── POST /api/my-listings/:itemId/end — End a listing ──
router.post('/:itemId/end', requireRole('admin', 'publisher'), async (req, res) => {
  const token = req.userConfig.ebayOAuthToken || req.userConfig.ebayToken;
  if (!token) return res.status(400).json({ error: 'eBay not connected' });

  const reason = req.body.reason || 'NotAvailable';
  const validReasons = ['NotAvailable', 'Incorrect', 'LostOrBroken', 'OtherListingError', 'SellToHighBidder'];
  if (!validReasons.includes(reason)) {
    return res.status(400).json({ error: 'Invalid ending reason' });
  }

  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<EndItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">',
    '  <ErrorLanguage>en_US</ErrorLanguage>',
    '  <WarningLevel>High</WarningLevel>',
    `  <ItemID>${escapeXml(req.params.itemId)}</ItemID>`,
    `  <EndingReason>${escapeXml(reason)}</EndingReason>`,
    '</EndItemRequest>',
  ].join('\n');

  try {
    const response = await fetch(EBAY_API_URL, {
      method: 'POST',
      headers: { ...ebayHeaders('EndItem', token), 'Content-Type': 'text/xml' },
      body: xml,
    });
    const text = await response.text();

    const ackMatch = text.match(/<Ack>([^<]+)<\/Ack>/);
    if (!ackMatch || (ackMatch[1] !== 'Success' && ackMatch[1] !== 'Warning')) {
      const errMsg = text.match(/<ShortMessage>([^<]+)<\/ShortMessage>/);
      return res.status(400).json({ error: errMsg ? errMsg[1] : 'Failed to end listing' });
    }

    res.json({ success: true, message: 'Listing ended successfully' });
  } catch (err) {
    console.error('EndItem error:', err);
    res.status(500).json({ error: 'Failed to end listing' });
  }
});

// ── PUT /api/my-listings/:itemId — Revise a listing ──
router.put('/:itemId', requireRole('admin', 'publisher'), async (req, res) => {
  const token = req.userConfig.ebayOAuthToken || req.userConfig.ebayToken;
  if (!token) return res.status(400).json({ error: 'eBay not connected' });

  const {
    title, description, price, quantity, conditionId,
    sku, upc, pictureUrls, specifics,
    bestOfferEnabled, autoAcceptPrice, minBestOfferPrice,
    shippingProfileId, returnProfileId, paymentProfileId,
  } = req.body;

  const xmlParts = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">',
    '  <ErrorLanguage>en_US</ErrorLanguage>',
    '  <WarningLevel>High</WarningLevel>',
    '  <Item>',
    `    <ItemID>${escapeXml(req.params.itemId)}</ItemID>`,
  ];

  if (title !== undefined) {
    xmlParts.push(`    <Title>${escapeXml(title.substring(0, 80))}</Title>`);
  }
  if (description !== undefined) {
    xmlParts.push(`    <Description><![CDATA[${description}]]></Description>`);
  }
  if (price !== undefined) {
    xmlParts.push(`    <StartPrice currencyID="USD">${parseFloat(price).toFixed(2)}</StartPrice>`);
  }
  if (quantity !== undefined) {
    xmlParts.push(`    <Quantity>${parseInt(quantity) || 1}</Quantity>`);
  }
  if (conditionId !== undefined) {
    xmlParts.push(`    <ConditionID>${escapeXml(String(conditionId))}</ConditionID>`);
  }
  if (sku !== undefined) {
    xmlParts.push(`    <SKU>${escapeXml(sku)}</SKU>`);
  }
  if (upc !== undefined) {
    xmlParts.push('    <ProductListingDetails>');
    xmlParts.push(`      <UPC>${escapeXml(upc)}</UPC>`);
    xmlParts.push('    </ProductListingDetails>');
  }
  if (pictureUrls && pictureUrls.length > 0) {
    xmlParts.push('    <PictureDetails>');
    for (const url of pictureUrls) {
      xmlParts.push(`      <PictureURL>${escapeXml(url)}</PictureURL>`);
    }
    xmlParts.push('    </PictureDetails>');
  }
  if (specifics && Object.keys(specifics).length > 0) {
    xmlParts.push('    <ItemSpecifics>');
    for (const [name, value] of Object.entries(specifics)) {
      xmlParts.push('      <NameValueList>');
      xmlParts.push(`        <Name>${escapeXml(name)}</Name>`);
      xmlParts.push(`        <Value>${escapeXml(value)}</Value>`);
      xmlParts.push('      </NameValueList>');
    }
    xmlParts.push('    </ItemSpecifics>');
  }

  // Best offer
  if (bestOfferEnabled !== undefined) {
    xmlParts.push('    <BestOfferDetails>');
    xmlParts.push(`      <BestOfferEnabled>${bestOfferEnabled ? 'true' : 'false'}</BestOfferEnabled>`);
    xmlParts.push('    </BestOfferDetails>');
  }
  if (autoAcceptPrice !== undefined || minBestOfferPrice !== undefined) {
    xmlParts.push('    <ListingDetails>');
    if (autoAcceptPrice !== undefined && parseFloat(autoAcceptPrice) > 0) {
      xmlParts.push(`      <BestOfferAutoAcceptPrice currencyID="USD">${parseFloat(autoAcceptPrice).toFixed(2)}</BestOfferAutoAcceptPrice>`);
    }
    if (minBestOfferPrice !== undefined && parseFloat(minBestOfferPrice) > 0) {
      xmlParts.push(`      <MinimumBestOfferPrice currencyID="USD">${parseFloat(minBestOfferPrice).toFixed(2)}</MinimumBestOfferPrice>`);
    }
    xmlParts.push('    </ListingDetails>');
  }

  // Seller profiles
  if (shippingProfileId || returnProfileId || paymentProfileId) {
    xmlParts.push('    <SellerProfiles>');
    if (shippingProfileId) {
      xmlParts.push('      <SellerShippingProfile>');
      xmlParts.push(`        <ShippingProfileID>${escapeXml(shippingProfileId)}</ShippingProfileID>`);
      xmlParts.push('      </SellerShippingProfile>');
    }
    if (paymentProfileId) {
      xmlParts.push('      <SellerPaymentProfile>');
      xmlParts.push(`        <PaymentProfileID>${escapeXml(paymentProfileId)}</PaymentProfileID>`);
      xmlParts.push('      </SellerPaymentProfile>');
    }
    if (returnProfileId) {
      xmlParts.push('      <SellerReturnProfile>');
      xmlParts.push(`        <ReturnProfileID>${escapeXml(returnProfileId)}</ReturnProfileID>`);
      xmlParts.push('      </SellerReturnProfile>');
    }
    xmlParts.push('    </SellerProfiles>');
  }

  xmlParts.push('  </Item>');
  xmlParts.push('</ReviseItemRequest>');

  try {
    const response = await fetch(EBAY_API_URL, {
      method: 'POST',
      headers: { ...ebayHeaders('ReviseItem', token), 'Content-Type': 'text/xml' },
      body: xmlParts.filter(Boolean).join('\n'),
    });
    const text = await response.text();

    const ackMatch = text.match(/<Ack>([^<]+)<\/Ack>/);
    if (!ackMatch || (ackMatch[1] !== 'Success' && ackMatch[1] !== 'Warning')) {
      const errMsg = text.match(/<LongMessage>([^<]+)<\/LongMessage>/) || text.match(/<ShortMessage>([^<]+)<\/ShortMessage>/);
      return res.status(400).json({ error: errMsg ? errMsg[1] : 'Failed to revise listing' });
    }

    // Parse fees if any
    const feesBlock = text.match(/<Fees>([\s\S]*?)<\/Fees>/);
    let totalFees = '';
    if (feesBlock) {
      const feeMatch = feesBlock[1].match(/<Name>ListingFee<\/Name>\s*<Fee[^>]*>([^<]+)<\/Fee>/);
      if (feeMatch) totalFees = feeMatch[1];
    }

    res.json({ success: true, message: 'Listing updated successfully', fees: totalFees });
  } catch (err) {
    console.error('ReviseItem error:', err);
    res.status(500).json({ error: 'Failed to revise listing' });
  }
});

module.exports = router;
