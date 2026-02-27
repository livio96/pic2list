# LOT Mode Image Analysis - Design

## Summary

Add a LOT mode toggle that allows users to upload images containing multiple items (e.g., books on a shelf, trading cards, products in a display). Gemini 2.5 Flash analyzes the image(s) and identifies each individual item, creating one draft per item.

## UI

- **Pill-shaped toggle** above the drop zone: "Single Items" (default) | "LOT"
- LOT mode highlighted in amber/orange to stand out from the blue theme
- Drop zone label updates: "Drop lot image(s) here - we'll identify every item"
- Action button text changes: "Identify Items in Lot"
- Multiple lot images supported (different angles/sections of same lot)

## Backend

- New endpoint: `POST /api/openrouter/identify-lot`
- Uses Gemini 2.5 Flash via OpenRouter (existing integration)
- Specialized prompt with scratchpad analysis for systematic item identification
- Parses structured response (`<item_count>`, `<identified_items>`)
- Returns: `{ itemCount: N, items: [{ index, title, details }] }`

## Draft Creation

- Each identified item becomes its own draft automatically
- `product_name` = identified item title
- All lot images attached to every draft
- Drafts flow into existing pipeline (generate title/description, publish)

## No Schema Changes

- Existing drafts table has all needed fields
- Optionally tag with `item_aspects: { source: "lot" }` for tracking
