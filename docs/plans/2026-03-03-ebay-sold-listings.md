# eBay Sold Listings (Terapeak-style) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "📊 Sold" button next to the Suggested Price button that opens a Terapeak-style modal showing eBay sold listings with summary stats and a scrollable table.

**Architecture:** New backend endpoint `/api/ebay/sold-listings` calls eBay Finding API `findCompletedItems` (App ID only, no OAuth). Frontend adds a button, a dedicated modal, and a `soldResearch(ci)` function following the same patterns as the existing `lookupPriceRange` and modal system.

**Tech Stack:** Node.js/Express (server.js), Vanilla JS + HTML/CSS (index.html), eBay Finding API v1.13.0

---

### Task 1: Add backend `/api/ebay/sold-listings` endpoint

**Files:**
- Modify: `server.js:901` (insert before `const PORT = ...` line)

**Step 1: Add the endpoint**

Insert the following block into `server.js` immediately before the line `const PORT = process.env.PORT || 3000;` (currently line 903):

```javascript
// ── Sold listings lookup via Finding API ──
app.get('/api/ebay/sold-listings', async (req, res) => {
  const { ebayClientId } = req.userConfig;
  if (!ebayClientId) return res.json({ success: false, error: 'eBay App ID not configured. Go to Settings.' });

  const { q, category_id, condition_id } = req.query;
  if (!q) return res.json({ success: false, error: 'Missing search query (q)' });

  try {
    const params = new URLSearchParams({
      'OPERATION-NAME': 'findCompletedItems',
      'SERVICE-VERSION': '1.13.0',
      'SECURITY-APPNAME': ebayClientId,
      'RESPONSE-DATA-FORMAT': 'JSON',
      'keywords': q,
      'itemFilter(0).name': 'SoldItemsOnly',
      'itemFilter(0).value': 'true',
      'paginationInput.entriesPerPage': '100',
      'sortOrder': 'EndTimeSoonest',
    });

    let filterIndex = 1;
    if (condition_id) {
      params.set(`itemFilter(${filterIndex}).name`, 'Condition');
      params.set(`itemFilter(${filterIndex}).value`, condition_id);
      filterIndex++;
    }
    if (category_id) {
      params.set('categoryId', category_id);
    }

    const url = `https://svcs.ebay.com/services/search/FindingService/v1?${params}`;
    const resp = await fetch(url);
    const data = await resp.json();

    const result = data?.findCompletedItemsResponse?.[0];
    if (!result || result.ack?.[0] !== 'Success') {
      const msg = result?.errorMessage?.[0]?.error?.[0]?.message?.[0] || 'Finding API error';
      return res.json({ success: false, error: msg });
    }

    const rawItems = result?.searchResult?.[0]?.item || [];
    if (rawItems.length === 0) {
      return res.json({ success: true, count: 0, stats: null, listings: [] });
    }

    const listings = rawItems.map(item => ({
      title: item.title?.[0] || '',
      price: parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || 0),
      condition: item.condition?.[0]?.conditionDisplayName?.[0] || 'Unknown',
      qty: parseInt(item.sellingStatus?.[0]?.quantitySold?.[0] || 1, 10),
      date: item.listingInfo?.[0]?.endTime?.[0]?.split('T')[0] || '',
      url: item.viewItemURL?.[0] || '',
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
    const totalQty = listings.reduce((s, l) => s + l.qty, 0);

    res.json({
      success: true,
      count: listings.length,
      stats: {
        totalQty,
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
```

**Step 2: Verify the server starts without errors**

```bash
node server.js
```
Expected: `LazyListings running at http://localhost:3000`

**Step 3: Test the endpoint manually**

```bash
curl "http://localhost:3000/api/ebay/sold-listings?q=iphone+12+64gb" \
  -H "Cookie: <your session cookie>"
```
Expected: JSON with `success: true`, `count`, `stats`, and `listings` array.

---

### Task 2: Add CSS for the Sold button and modal

**Files:**
- Modify: `index.html:246` (insert after `.price-range-info .pr-val` rule, around line 246)

**Step 1: Insert CSS**

After line 246 (`.price-range-info .pr-val { font-weight: 600; color: #1a1a2e; }`), insert:

```css
    .sold-research-btn {
      background: none; border: 1px solid #d1d5db; border-radius: 6px;
      color: #16a34a; font-size: 11px; cursor: pointer; padding: 2px 6px;
      white-space: nowrap; transition: all 0.15s;
    }
    .sold-research-btn:hover { background: #f0fdf4; border-color: #16a34a; }

    /* Sold Research Modal */
    .sold-modal-overlay {
      display: none; position: fixed; inset: 0; z-index: 1060;
      background: rgba(0,0,0,0.35); backdrop-filter: blur(6px);
      align-items: center; justify-content: center;
    }
    .sold-modal-overlay.open { display: flex; }
    .sold-modal {
      background: #fff; border: 1px solid #e5e7eb; border-radius: 16px;
      width: 90vw; max-width: 760px; max-height: 85vh;
      display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 20px 60px rgba(0,0,0,0.12);
    }
    .sold-modal-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 20px; border-bottom: 1px solid #e5e7eb; flex-shrink: 0;
    }
    .sold-modal-header h3 {
      font-size: 14px; font-weight: 600; color: #1a1a2e;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      flex: 1; margin-right: 12px;
    }
    .sold-stats-bar {
      display: flex; gap: 0; border-bottom: 1px solid #e5e7eb; flex-shrink: 0;
    }
    .sold-stat {
      flex: 1; padding: 12px 16px; text-align: center;
      border-right: 1px solid #e5e7eb;
    }
    .sold-stat:last-child { border-right: none; }
    .sold-stat-label { font-size: 10px; color: #8b8fa3; text-transform: uppercase; letter-spacing: 0.05em; }
    .sold-stat-value { font-size: 16px; font-weight: 700; color: #1a1a2e; margin-top: 2px; }
    .sold-table-wrap { overflow-y: auto; flex: 1; }
    .sold-table {
      width: 100%; border-collapse: collapse; font-size: 12px;
    }
    .sold-table th {
      padding: 8px 12px; text-align: left; font-size: 11px;
      color: #8b8fa3; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.04em; background: #f9fafb;
      position: sticky; top: 0; border-bottom: 1px solid #e5e7eb;
    }
    .sold-table td {
      padding: 8px 12px; border-bottom: 1px solid #f3f4f6;
      color: #1a1a2e; vertical-align: middle;
    }
    .sold-table tr:last-child td { border-bottom: none; }
    .sold-table tr:hover td { background: #f9fafb; }
    .sold-title-link {
      color: #1a1a2e; text-decoration: none; display: -webkit-box;
      -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .sold-title-link:hover { color: #4f6ef7; text-decoration: underline; }
    .sold-price { font-weight: 600; color: #16a34a; }
    .sold-empty {
      padding: 40px; text-align: center; color: #8b8fa3; font-size: 13px;
    }
```

---

### Task 3: Add the Sold button in the HTML template

**Files:**
- Modify: `index.html:1599`

**Step 1: Locate the price-cell-wrap template**

Find line 1599, which currently reads:
```javascript
            ${meta.status !== 'listed' && meta.status !== 'rejected' ? `<button class="price-range-btn" id="priceRangeBtn-${ci}">Suggested Price</button>` : ''}
```

**Step 2: Add the Sold button on the next line**

Change the block from:
```javascript
            ${meta.status !== 'listed' && meta.status !== 'rejected' ? `<button class="price-range-btn" id="priceRangeBtn-${ci}">Suggested Price</button>` : ''}
            <div id="priceRange-${ci}"></div>
```

To:
```javascript
            ${meta.status !== 'listed' && meta.status !== 'rejected' ? `<button class="price-range-btn" id="priceRangeBtn-${ci}">Suggested Price</button>` : ''}
            <button class="sold-research-btn" id="soldResearchBtn-${ci}">📊 Sold</button>
            <div id="priceRange-${ci}"></div>
```

---

### Task 4: Add the Sold modal HTML

**Files:**
- Modify: `index.html:779` (after the bundle modal closing `</div>`, around line 779)

**Step 1: Insert modal HTML**

After the closing `</div>` of the bundle modal (around line 779, after `</div>` that closes `bundleOverlay`), insert:

```html
  <!-- Sold Research Modal -->
  <div class="sold-modal-overlay" id="soldModalOverlay">
    <div class="sold-modal">
      <div class="sold-modal-header">
        <h3 id="soldModalTitle">📊 eBay Sold Listings</h3>
        <button class="modal-close" id="soldModalClose">&times;</button>
      </div>
      <div class="sold-stats-bar" id="soldStatsBar"></div>
      <div class="sold-table-wrap">
        <table class="sold-table">
          <thead>
            <tr>
              <th style="width:45%">Title</th>
              <th>Condition</th>
              <th>Qty</th>
              <th>Price</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody id="soldTableBody"></tbody>
        </table>
      </div>
    </div>
  </div>
```

---

### Task 5: Add the `soldResearch` JS function and event listeners

**Files:**
- Modify: `index.html:1787` (event listener section, after the `prBtn` listener)
- Modify: `index.html:1836` (after `lookupPriceRange` function)

**Step 1: Add event listener for sold button**

After line 1787 (`if (prBtn) prBtn.addEventListener('click', () => lookupPriceRange(ci));`), insert:

```javascript
      const soldBtn = document.getElementById(`soldResearchBtn-${ci}`);
      if (soldBtn) soldBtn.addEventListener('click', () => soldResearch(ci));
```

**Step 2: Add `soldResearch` function**

After the closing `}` of `lookupPriceRange` (after line 1836), insert:

```javascript
    // ── Sold listings research (Terapeak-style) ──
    async function soldResearch(ci) {
      const meta = clusterData[ci];
      const query = meta.generatedTitle || meta.productName || '';
      if (!query) { alert('No product name to search for.'); return; }

      const btn = document.getElementById(`soldResearchBtn-${ci}`);
      btn.textContent = 'Loading...';
      btn.disabled = true;

      try {
        const params = new URLSearchParams({ q: query });
        if (meta.suggestedCategoryId) params.set('category_id', meta.suggestedCategoryId);
        const condSelect = document.getElementById(`condition-${ci}`);
        if (condSelect) params.set('condition_id', condSelect.value);

        const resp = await apiFetch(`/api/ebay/sold-listings?${params}`);
        const data = await resp.json();

        if (!data.success) throw new Error(data.error);

        openSoldModal(query, data);
      } catch (err) {
        alert('Error: ' + err.message);
      }

      btn.textContent = '📊 Sold';
      btn.disabled = false;
    }

    function openSoldModal(query, data) {
      document.getElementById('soldModalTitle').textContent = `📊 eBay Sold Listings: ${query}`;

      // Stats bar
      const statsBar = document.getElementById('soldStatsBar');
      if (data.count === 0 || !data.stats) {
        statsBar.innerHTML = '';
      } else {
        const s = data.stats;
        statsBar.innerHTML = `
          <div class="sold-stat">
            <div class="sold-stat-label">Total Sold</div>
            <div class="sold-stat-value">${data.count}</div>
          </div>
          <div class="sold-stat">
            <div class="sold-stat-label">Avg Price</div>
            <div class="sold-stat-value">$${s.avg}</div>
          </div>
          <div class="sold-stat">
            <div class="sold-stat-label">Median</div>
            <div class="sold-stat-value">$${s.median}</div>
          </div>
          <div class="sold-stat">
            <div class="sold-stat-label">Low</div>
            <div class="sold-stat-value">$${s.low}</div>
          </div>
          <div class="sold-stat">
            <div class="sold-stat-label">High</div>
            <div class="sold-stat-value">$${s.high}</div>
          </div>
        `;
      }

      // Table body
      const tbody = document.getElementById('soldTableBody');
      if (data.count === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="sold-empty">No sold listings found. Try broadening the search.</td></tr>`;
      } else {
        tbody.innerHTML = data.listings.map(l => `
          <tr>
            <td><a href="${l.url}" target="_blank" rel="noopener" class="sold-title-link">${escapeHtml(l.title)}</a></td>
            <td>${escapeHtml(l.condition)}</td>
            <td>${l.qty}</td>
            <td class="sold-price">$${l.price.toFixed(2)}</td>
            <td style="color:#8b8fa3">${l.date}</td>
          </tr>
        `).join('');
      }

      document.getElementById('soldModalOverlay').classList.add('open');
    }
```

**Step 3: Add modal close handlers**

Find the section where the detail modal close handlers are registered (around line 2103-2110). After those handlers, add:

```javascript
    // Sold modal close
    document.getElementById('soldModalClose').addEventListener('click', () => {
      document.getElementById('soldModalOverlay').classList.remove('open');
    });
    document.getElementById('soldModalOverlay').addEventListener('click', (e) => {
      if (e.target === document.getElementById('soldModalOverlay'))
        document.getElementById('soldModalOverlay').classList.remove('open');
    });
```

Also add to the existing `keydown` Escape handler (find `if (e.key === 'Escape') closeModal();` and add alongside):

```javascript
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeModal();
        document.getElementById('soldModalOverlay').classList.remove('open');
      }
    });
```

Note: The existing keydown handler already calls `closeModal()`. Either add to it, or add a second listener — both are fine.

---

### Task 6: Smoke test the full feature

**Step 1: Start the server**
```bash
node server.js
```

**Step 2: Open the app and log in**

Navigate to `http://localhost:3000`, log in.

**Step 3: Test the button**

- Upload or use an existing item in the dashboard
- Click the `📊 Sold` button next to an item
- Verify: button shows "Loading...", then modal opens with stats bar and table
- Verify: clicking a listing title opens eBay in a new tab
- Verify: Escape key and clicking outside the modal close it
- Verify: "Suggested Price" button still works as before

**Step 4: Test edge cases**

- Item with no results: modal shows "No sold listings found" message in table
- Network/API error: alert shown, button re-enabled
