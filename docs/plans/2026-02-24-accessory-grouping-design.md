# Accessory Grouping Feature Design

**Date:** 2026-02-24
**Status:** Approved

## Problem

When a user uploads images of related items (e.g., a phone and its charger), the system creates separate listings for each. Sellers typically want to list a main item with its accessories as a single listing.

## Solution

Extend the existing Gemini identification prompt to also detect accessory/companion relationships between product groups. Show a merge suggestion UI before drafts are created. The user confirms or rejects each suggested bundle.

## Design Decisions

- **Approach:** Single Gemini call (extend existing prompt) rather than a second API call or client-side heuristics
- **User control:** AI suggests bundles, user confirms — no auto-merging
- **UI placement:** After identification, before draft creation
- **Bundle naming:** Main item + "with accessories" pattern (e.g., "iPhone 15 with USB-C Charger")

## Changes

### 1. Gemini Prompt (server.js)

The identification prompt gains additional instructions for accessory detection. The JSON response format changes from a flat array to:

```json
{
  "groups": [
    { "groupId": 0, "productName": "Apple iPhone 15", "confidence": 95, "imageIndices": [0, 1], "isMainItem": true },
    { "groupId": 1, "productName": "Apple USB-C Charger", "confidence": 90, "imageIndices": [2], "isMainItem": false }
  ],
  "suggestedBundles": [
    {
      "mainGroupId": 0,
      "accessoryGroupIds": [1],
      "reason": "The USB-C charger is a compatible accessory for the iPhone 15",
      "bundleConfidence": 85
    }
  ]
}
```

Key fields:
- `suggestedBundles` — optional array, empty when no relationships detected
- `mainGroupId` — the primary product group
- `accessoryGroupIds` — accessories that could be bundled with the main item
- `reason` — human-readable explanation for the suggestion
- `bundleConfidence` — 0-100, how confident the AI is these belong together

Backward compatible: if Gemini returns just an array (old format), frontend treats it as no bundles.

### 2. Frontend Flow (index.html)

After Gemini responds and before `createDraftsInDB()`:

1. **When `suggestedBundles` is non-empty**, show a modal/panel with:
   - Thumbnails of main item and accessories side by side
   - AI's reason for the suggestion
   - Confidence badge
   - "Merge into one listing" / "Keep separate" buttons per bundle

2. **On merge:**
   - Accessory group images folded into the main group's cluster
   - Product name becomes: `"Main Product with Accessory1, Accessory2"`
   - Merged cluster goes to draft creation as a single draft

3. **On keep separate:**
   - No change, drafts created as today

4. **When no bundles suggested:**
   - Flow proceeds exactly as today, zero UI change

### 3. Listing Generation Impact

When a merged bundle goes through `generateListing()` / `buildPrompt()`, the product name already contains the accessories, so the listing title and description naturally include them. Title pattern: "Main Item with Accessory1, Accessory2".

## Files Affected

- `server.js` — Gemini prompt modification (~lines 501-517), response parsing
- `index.html` — Bundle suggestion UI, merge logic, cluster data handling
