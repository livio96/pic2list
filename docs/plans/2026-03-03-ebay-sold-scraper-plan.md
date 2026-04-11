# eBay Sold Listings Scraper — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an eBay sold listings scraper that fetches real sold/completed data from eBay search pages and displays Terapeak-style summaries alongside the existing Browse API price research.

**Architecture:** Server-side HTTP scraper using Cheerio to parse eBay's sold listings search page. New Express route `/api/ebay/sold-scrape`. Frontend adds a "Sold Listings" button next to the existing "Price Research" button, reusing the existing modal with additional columns.

**Tech Stack:** Node.js, Express, Cheerio (new dep), vanilla JS frontend

---

### Task 1: Install Cheerio dependency

**Files:**
- Modify: `package.json`

**Step 1: Install cheerio**

Run: `npm install cheerio`
Expected: cheerio added to package.json dependencies

**Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add cheerio dependency for eBay scraper"
```

---

### Task 2: Add the scraper route to server.js

**Files:**
- Modify: `server.js:975` (insert before `const PORT` line at line 977)

**Step 1: Add the scraper route**

Insert the following code at `server.js:976` (after the closing `});` of the Browse API route at line 975, before `const PORT`):

```javascript
// ── Sold listings scraper (actual sold data from eBay search page) ──
const cheerio = require('cheerio');

app.get('/api/ebay/sold-scrape', requireAuth, loadUserConfig, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ success: false, error: 'Missing search query (q)' });

  try {
    const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1&_ipg=120&_sop=13`;

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

    // Each sold item is an li with class s-card inside srp-results
    $('li[data-listingid]').each((_, el) => {
      const card = $(el);

      // Title: .s-card__title > span
      const title = card.find('.s-card__title span').first().text().trim();
      if (!title) return; // skip empty/ad cards

      // Price: .s-card__price
      const priceText = card.find('.s-card__price').first().text().trim();
      const priceMatch = priceText.match(/\$([\d,]+\.?\d*)/);
      const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : 0;
      if (price <= 0) return;

      // Handle price ranges like "$50.00 to $100.00"
      const priceRange = priceText.match(/\$([\d,]+\.?\d*)\s*to\s*\$([\d,]+\.?\d*)/);
      const finalPrice = priceRange
        ? (parseFloat(priceRange[1].replace(/,/g, '')) + parseFloat(priceRange[2].replace(/,/g, ''))) / 2
        : price;

      // Sold date: text containing "Sold  Mon DD, YYYY"
      const cardText = card.text();
      const dateMatch = cardText.match(/Sold\s+([A-Z][a-z]+\s+\d+,\s+\d{4})/);
      const soldDate = dateMatch ? dateMatch[1].trim() : '';

      // Condition: first text in .s-card__subtitle span (e.g. "Pre-Owned ·")
      const conditionText = card.find('.s-card__subtitle span').first().text().trim();
      const condition = conditionText.replace(/\s*·\s*$/, '').trim() || 'Unknown';

      // Shipping: look for delivery text
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

      // Image: first img src from s-card
      const imgEl = card.find('img').first();
      const image = imgEl.attr('src') || imgEl.attr('data-defer-load') || '';

      // URL: first link with /itm/
      const linkEl = card.find('a[href*="/itm/"]').first();
      const itemUrl = linkEl.attr('href') || '';
      // Clean URL — strip tracking params
      const cleanUrl = itemUrl.split('?')[0];

      listings.push({
        title,
        price: +finalPrice.toFixed(2),
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
    console.error('Sold scrape error:', err);
    res.json({ success: false, error: 'Scraping temporarily unavailable' });
  }
});
```

**Step 2: Move the `require('cheerio')` to the top of server.js**

Add at `server.js:7` (after the other require statements):

```javascript
const cheerio = require('cheerio');
```

And remove the inline `require` from the route code added in Step 1.

**Step 3: Verify the server starts**

Run: `node server.js`
Expected: "LazyListings running at http://localhost:3000" with no errors

**Step 4: Test the endpoint manually**

Run: `curl "http://localhost:3000/api/ebay/sold-scrape?q=iphone+15+pro" -b <session-cookie>`
Expected: JSON response with `success: true`, `count` > 0, `stats` object, `listings` array

**Step 5: Commit**

```bash
git add server.js
git commit -m "feat: add eBay sold listings scraper route"
```

---

### Task 3: Add the "Sold Listings" button to the frontend

**Files:**
- Modify: `index.html:1703` (inside the price cell, after existing Price Research button)

**Step 1: Add CSS for the new button**

Insert after `index.html:264` (after `.sold-research-btn:hover` rule):

```css
.sold-scrape-btn {
  background: none; border: 1px solid #d1d5db; border-radius: 6px;
  color: #4f6ef7; font-size: 11px; cursor: pointer; padding: 2px 6px;
  white-space: nowrap; transition: all 0.15s;
}
.sold-scrape-btn:hover { background: #eef2ff; border-color: #4f6ef7; }
```

**Step 2: Add the button in the item row HTML**

At `index.html:1703`, change:

```html
<button class="sold-research-btn" id="soldResearchBtn-${ci}">📊 Price Research</button>
```

to:

```html
<button class="sold-research-btn" id="soldResearchBtn-${ci}">📊 Price Research</button>
<button class="sold-scrape-btn" id="soldScrapeBtn-${ci}">💰 Sold Listings</button>
```

**Step 3: Wire up the button event listener**

At `index.html:1893` (after the existing `soldBtn` listener), add:

```javascript
const scrapeBtn = document.getElementById(`soldScrapeBtn-${ci}`);
if (scrapeBtn) scrapeBtn.addEventListener('click', () => soldScrapeResearch(ci));
```

**Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add Sold Listings button to item rows"
```

---

### Task 4: Add the scraper JS function and update the modal

**Files:**
- Modify: `index.html` (multiple locations)

**Step 1: Update modal table headers to support both modes**

At `index.html:868-874`, change the thead to have an id so we can update columns dynamically:

```html
<thead id="soldTableHead">
  <tr>
    <th style="width:48px"></th>
    <th style="width:40%">Title</th>
    <th>Condition</th>
    <th>Type</th>
    <th>Price</th>
  </tr>
</thead>
```

**Step 2: Add the `soldScrapeResearch()` function**

Insert after the `soldResearch()` function (after `index.html:1972`):

```javascript
// ── Sold listings scraper (actual sold data) ──
async function soldScrapeResearch(ci) {
  const meta = clusterData[ci];
  const query = meta.generatedTitle || meta.productName || '';
  if (!query) { alert('No product name to search for.'); return; }

  const btn = document.getElementById(`soldScrapeBtn-${ci}`);
  btn.textContent = 'Loading...';
  btn.disabled = true;

  try {
    const params = new URLSearchParams({ q: query });
    const resp = await apiFetch(`/api/ebay/sold-scrape?${params}`);
    const data = await resp.json();

    if (!data.success) throw new Error(data.error);

    openSoldModal(query, data, true);
  } catch (err) {
    alert('Error: ' + err.message);
  }

  btn.textContent = '💰 Sold Listings';
  btn.disabled = false;
}
```

**Step 3: Update `openSoldModal()` to handle both modes**

Replace the `openSoldModal` function at `index.html:1974-2024` with:

```javascript
function openSoldModal(query, data, isScrape = false) {
  const titlePrefix = isScrape ? '💰 eBay Sold Listings' : '📊 eBay Market Prices';
  document.getElementById('soldModalTitle').textContent = `${titlePrefix}: ${query}`;

  // Update table headers based on mode
  const thead = document.getElementById('soldTableHead');
  if (isScrape) {
    thead.innerHTML = `<tr>
      <th style="width:48px"></th>
      <th style="width:35%">Title</th>
      <th>Condition</th>
      <th>Price</th>
      <th>Shipping</th>
      <th>Sold Date</th>
    </tr>`;
  } else {
    thead.innerHTML = `<tr>
      <th style="width:48px"></th>
      <th style="width:40%">Title</th>
      <th>Condition</th>
      <th>Type</th>
      <th>Price</th>
    </tr>`;
  }

  // Stats bar
  const statsBar = document.getElementById('soldStatsBar');
  if (data.count === 0 || !data.stats) {
    statsBar.innerHTML = '';
  } else {
    const s = data.stats;
    statsBar.innerHTML = `
      <div class="sold-stat">
        <div class="sold-stat-label">${isScrape ? 'Sold' : 'Listings'}</div>
        <div class="sold-stat-value">${data.count}</div>
      </div>
      <div class="sold-stat">
        <div class="sold-stat-label">Avg Price</div>
        <div class="sold-stat-value">$${s.avg.toFixed(2)}</div>
      </div>
      <div class="sold-stat">
        <div class="sold-stat-label">Median</div>
        <div class="sold-stat-value">$${s.median.toFixed(2)}</div>
      </div>
      <div class="sold-stat">
        <div class="sold-stat-label">Low</div>
        <div class="sold-stat-value">$${s.low.toFixed(2)}</div>
      </div>
      <div class="sold-stat">
        <div class="sold-stat-label">High</div>
        <div class="sold-stat-value">$${s.high.toFixed(2)}</div>
      </div>
    `;
  }

  // Table body
  const tbody = document.getElementById('soldTableBody');
  const colCount = isScrape ? 6 : 5;
  if (data.count === 0) {
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="sold-empty">No listings found. Try broadening the search.</td></tr>`;
  } else if (isScrape) {
    tbody.innerHTML = data.listings.map(l => `
      <tr>
        <td>${l.image ? `<img src="${l.image}" alt="" class="sold-img" loading="lazy">` : ''}</td>
        <td><a href="${l.url.startsWith('https://') ? l.url : '#'}" target="_blank" rel="noopener" class="sold-title-link">${escapeHtml(l.title)}</a></td>
        <td>${escapeHtml(l.condition)}</td>
        <td class="sold-price">$${l.price.toFixed(2)}</td>
        <td style="color:#8b8fa3">${l.shippingLabel || 'Free'}</td>
        <td style="color:#8b8fa3">${escapeHtml(l.soldDate || '')}</td>
      </tr>
    `).join('');
  } else {
    tbody.innerHTML = data.listings.map(l => `
      <tr>
        <td>${l.image ? `<img src="${l.image}" alt="" class="sold-img" loading="lazy">` : ''}</td>
        <td><a href="${l.url.startsWith('https://') ? l.url : '#'}" target="_blank" rel="noopener" class="sold-title-link">${escapeHtml(l.title)}</a></td>
        <td>${escapeHtml(l.condition)}</td>
        <td style="color:#8b8fa3">${escapeHtml(l.type)}</td>
        <td class="sold-price">$${l.price.toFixed(2)}</td>
      </tr>
    `).join('');
  }

  document.getElementById('soldModalOverlay').classList.add('open');
}
```

**Step 4: Verify everything works end-to-end**

1. Run: `node server.js`
2. Open browser to localhost:3000
3. Upload items, click "Sold Listings" button
4. Verify modal opens with sold data, correct columns, stats

**Step 5: Commit**

```bash
git add index.html
git commit -m "feat: wire up Sold Listings scraper to modal with sold date and shipping columns"
```

---

### Task 5: Final verification and cleanup

**Step 1: Test both buttons work independently**

1. Click "Price Research" → modal shows active listings with Type column
2. Close modal
3. Click "Sold Listings" → modal shows sold listings with Shipping + Sold Date columns
4. Verify stats are different between the two

**Step 2: Test edge cases**

- Search with no results (obscure query)
- Search with special characters in product name

**Step 3: Final commit with all changes**

```bash
git add -A
git commit -m "feat: eBay sold listings scraper - complete implementation"
```
