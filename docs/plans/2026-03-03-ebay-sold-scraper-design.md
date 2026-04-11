# eBay Sold Listings Scraper — Design

## Problem
Current "Price Research" uses eBay Browse API which only returns active listings.
Users need actual sold/completed listing data for accurate pricing decisions.

## Solution
Server-side web scraper using Cheerio that fetches eBay's sold listings search page and extracts structured data. Adds a new "Sold Listings" button alongside the existing "Price Research" button.

## Decisions
- **Approach:** HTTP fetch + Cheerio HTML parsing (not headless browser)
- **Scope:** First page of results (~48-60 items)
- **Coexistence:** Both buttons remain — active listings (API) and sold listings (scraper)
- **Data points:** Title, sold price, sold date, condition, shipping, image, URL

## Backend

### New Route: `GET /api/ebay/sold-scrape`

**Query params:** `q` (required), `category_id` (optional)

**Flow:**
1. Build URL: `https://www.ebay.com/sch/i.html?_nkw={q}&LH_Sold=1&LH_Complete=1&_ipg=120`
2. Fetch with realistic User-Agent header
3. Parse with Cheerio, extract from each `.s-item`:
   - Title (`.s-item__title`)
   - Sold price (`.s-item__price`) — handle "X to Y" ranges by taking average
   - Shipping cost (`.s-item__shipping`) — parse "Free" as 0
   - Sold date (`.s-item__title--tagblock`)
   - Condition (`.SECONDARY_INFO`)
   - Image (`.s-item__image img`)
   - Listing URL (`.s-item__link`)
4. Calculate stats: count, avg, median, low, high
5. Return JSON

**Response shape:**
```json
{
  "success": true,
  "count": 48,
  "stats": { "avg": 45.23, "median": 42.50, "low": 15.99, "high": 89.99 },
  "listings": [
    {
      "title": "Product Name",
      "price": 45.99,
      "shipping": 5.99,
      "soldDate": "Feb 28, 2026",
      "condition": "Pre-Owned",
      "url": "https://www.ebay.com/itm/...",
      "image": "https://..."
    }
  ]
}
```

**Error handling:**
- eBay blocks / unexpected HTML → `{ success: false, error: "Scraping temporarily unavailable" }`
- No results → `{ success: true, count: 0, stats: null, listings: [] }`

## Frontend

### New Button
- Label: "Sold Listings" (next to existing "Price Research")
- Distinct styling to differentiate from Browse API button

### Modal Reuse
- Reuse existing `soldModal` overlay + stats bar
- Update title to "eBay Sold Listings: {query}" when invoked from scraper
- Add **Sold Date** and **Shipping** columns to table
- Table columns: Image | Title | Condition | Price | Shipping | Sold Date

### JS Function
- New `soldScrapeResearch(ci)` function, mirrors `soldResearch(ci)` pattern
- Calls `/api/ebay/sold-scrape` instead of `/api/ebay/sold-listings`
- Passes extra columns to `openSoldModal()`

## Dependencies
- `cheerio` — lightweight HTML parser for Node.js

## Risks
- eBay HTML structure changes could break the scraper (mitigated: Cheerio selectors are easy to update)
- Rate limiting if used heavily (mitigated: single page fetch, normal use patterns are low-volume)
