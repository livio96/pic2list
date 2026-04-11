# eBay Sold Listings (Terapeak-style) Design

**Date:** 2026-03-03
**Status:** Approved

## Overview

Add a "📊 Sold" button next to the existing "Suggested Price" button on each item card. Clicking it opens a Terapeak-style modal showing eBay sold listings for that item with summary stats and a scrollable listings table.

## Section 1 — New Button

A `📊 Sold` button added to `.price-cell-wrap` next to `price-range-btn`. Same base styling as `price-range-btn` with a green tint to visually differentiate it.

```html
<div class="price-cell-wrap">
  <input type="number" class="cell-price-input" id="price-${ci}" placeholder="0.00">
  <button class="price-range-btn" id="priceRangeBtn-${ci}">Suggested Price</button>
  <button class="sold-research-btn" id="soldResearchBtn-${ci}">📊 Sold</button>
  <div id="priceRange-${ci}"></div>
</div>
```

## Section 2 — Modal Layout

A dedicated modal (`soldModal` / `soldModalOverlay`) separate from the existing detail modal. Follows the same CSS patterns (`.modal-overlay`, `.modal`, `.modal-header`, `.modal-body`).

Layout:
- **Header:** "📊 eBay Sold Listings: {product name}" + close button
- **Stats bar:** 5 stat cards — Total Sold, Avg Price, Median Price, Low, High
- **Table:** Scrollable, columns: Title (clickable link), Condition, Qty, Price, Date Sold
- Up to 100 results from the API
- Close via X button, click-outside, or Escape key

## Section 3 — Backend API

**Endpoint:** `GET /api/ebay/sold-listings`

**Query params:**
- `q` — search query (generatedTitle or productName)
- `category_id` — optional eBay category ID
- `condition_id` — optional condition filter

**Data source:** eBay Finding API
- URL: `https://svcs.ebay.com/services/search/FindingService/v1`
- Operation: `findCompletedItems` with `itemFilter=[{name:SoldItemsOnly,value:true}]`
- Auth: App Client ID only (`EBAY_APP_CLIENT_ID`) — no OAuth required
- Returns up to 100 results, ~90 days of sales history

**Response shape:**
```json
{
  "success": true,
  "count": 42,
  "stats": { "avg": 47.00, "median": 42.00, "low": 29.00, "high": 89.00 },
  "listings": [
    {
      "title": "iPhone 12 64GB",
      "price": 45.00,
      "condition": "Used",
      "qty": 1,
      "date": "2024-06-03",
      "url": "https://www.ebay.com/itm/..."
    }
  ]
}
```

## Files to Modify

| File | Change |
|------|--------|
| `server.js` | Add `GET /api/ebay/sold-listings` endpoint |
| `index.html` | Add button HTML in template, sold modal HTML, CSS styles, `soldResearch(ci)` JS function, event listener |
