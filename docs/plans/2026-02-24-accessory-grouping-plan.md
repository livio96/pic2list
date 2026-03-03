# Accessory Grouping Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users merge related items (e.g., phone + charger) into a single eBay listing by extending the Gemini identification prompt to detect accessory relationships and adding a confirmation UI.

**Architecture:** Extend the existing Gemini `/api/openrouter/identify` call to return both product groups and suggested bundles. Add a bundle suggestion modal to the frontend that appears between identification and draft creation. When the user accepts a bundle, merge the accessory clusters into the main item's cluster.

**Tech Stack:** Express.js backend, vanilla JS frontend, Gemini 2.5 Flash via OpenRouter API

---

### Task 1: Update Gemini Prompt and Backend Response

**Files:**
- Modify: `server.js:501-520`

**Step 1: Update the Gemini prompt to request accessory detection**

Replace the prompt string at `server.js:501-517` with:

```javascript
    const prompt = `You are a product identification expert. I'm sending you ${images.length} numbered images (image 0 through image ${images.length - 1}).

For each image, identify the product shown (brand + model/type if visible).

Then GROUP images that show the SAME product together — even if the names aren't exactly identical. For example "Logitech Brio Webcam" and "Logitech Brio 4K Webcam" are the same product and must be in the same group. Use your best judgment to normalize product names.

After grouping, check if any groups are ACCESSORIES or COMPANIONS of each other. For example: a phone case is an accessory for a phone, a charger is an accessory for a laptop, a remote is an accessory for a TV. Think about whether a buyer would reasonably want to list these items together as a bundle.

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
```

**Step 2: Update the response parsing at `server.js:519-520`**

Replace:
```javascript
    const groups = await callGemini([{ type: 'text', text: prompt }, ...imageContent], Math.max(1000, images.length * 100));
    res.json({ groups });
```

With:
```javascript
    const result = await callGemini([{ type: 'text', text: prompt }, ...imageContent], Math.max(1500, images.length * 150));

    // Backward compat: if Gemini returns a plain array (old format), wrap it
    let groups, suggestedBundles;
    if (Array.isArray(result)) {
      groups = result;
      suggestedBundles = [];
    } else {
      groups = result.groups || [];
      suggestedBundles = result.suggestedBundles || [];
    }

    res.json({ groups, suggestedBundles });
```

**Step 3: Verify the server starts without errors**

Run: `node server.js` (kill after startup)
Expected: Server starts on configured port with no syntax errors

**Step 4: Commit**

```bash
git add server.js
git commit -m "feat: extend Gemini prompt to detect accessory relationships

Add suggestedBundles to identification response for grouping
related items (e.g., phone + charger) into bundles."
```

---

### Task 2: Add Bundle Suggestion Modal CSS

**Files:**
- Modify: `index.html` (CSS section, after the existing modal styles around line ~348)

**Step 1: Add CSS for the bundle suggestion modal**

Insert after the `.modal-thumb-wrap:hover .modal-thumb-edit { opacity: 1; }` rule (line 348):

```css
    /* ═══════════════════════════════════════
       Bundle Suggestion Modal
       ══════════════════════════════════════ */
    .bundle-overlay {
      display: none; position: fixed; inset: 0; z-index: 1050;
      background: rgba(0,0,0,0.35); backdrop-filter: blur(6px);
      align-items: center; justify-content: center;
    }
    .bundle-overlay.open { display: flex; }
    .bundle-modal {
      background: #fff; border: 1px solid #e5e7eb; border-radius: 16px;
      width: 90vw; max-width: 640px; max-height: 80vh;
      display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 20px 60px rgba(0,0,0,0.12);
    }
    .bundle-header {
      padding: 16px 24px; border-bottom: 1px solid #e5e7eb;
      display: flex; align-items: center; justify-content: space-between;
    }
    .bundle-header h3 { font-size: 15px; font-weight: 600; color: #1a1a2e; margin: 0; }
    .bundle-body { padding: 16px 24px; overflow-y: auto; flex: 1; }
    .bundle-card {
      border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px;
      margin-bottom: 12px; background: #fafbfc;
    }
    .bundle-card:last-child { margin-bottom: 0; }
    .bundle-products {
      display: flex; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap;
    }
    .bundle-product {
      display: flex; align-items: center; gap: 8px;
      background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 6px 10px;
    }
    .bundle-product img {
      width: 40px; height: 40px; border-radius: 6px; object-fit: cover;
    }
    .bundle-product-name { font-size: 12px; font-weight: 600; color: #1a1a2e; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bundle-plus { font-size: 18px; font-weight: 700; color: #4f6ef7; }
    .bundle-reason { font-size: 12px; color: #6b7280; margin-bottom: 12px; font-style: italic; }
    .bundle-actions { display: flex; gap: 8px; }
    .bundle-footer { padding: 12px 24px; border-top: 1px solid #e5e7eb; text-align: right; }
```

**Step 2: Commit**

```bash
git add index.html
git commit -m "style: add CSS for bundle suggestion modal"
```

---

### Task 3: Add Bundle Suggestion Modal HTML

**Files:**
- Modify: `index.html` (HTML section, after the editor modal around line ~674)

**Step 1: Add modal HTML**

Insert after the editor modal closing `</div>` (line 674):

```html
  <!-- Bundle Suggestion Modal -->
  <div class="bundle-overlay" id="bundleOverlay">
    <div class="bundle-modal">
      <div class="bundle-header">
        <h3>Bundle Suggestions</h3>
      </div>
      <div class="bundle-body" id="bundleBody"></div>
      <div class="bundle-footer">
        <button class="btn btn-primary btn-sm" id="bundleDoneBtn">Done</button>
      </div>
    </div>
  </div>
```

**Step 2: Commit**

```bash
git add index.html
git commit -m "feat: add bundle suggestion modal HTML"
```

---

### Task 4: Add Bundle Suggestion Logic in Frontend

**Files:**
- Modify: `index.html` (JavaScript section, inside the `submitBtn` click handler around line ~1125-1154)

**Step 1: Add the `showBundleSuggestions` function**

Insert before the `submitBtn.addEventListener('click', ...)` block (before line 1107):

```javascript
    // ═══════════════════════════════════════
    //  Bundle suggestion logic
    // ═══════════════════════════════════════
    function showBundleSuggestions(groups, suggestedBundles) {
      return new Promise((resolve) => {
        const overlay = document.getElementById('bundleOverlay');
        const body = document.getElementById('bundleBody');
        const doneBtn = document.getElementById('bundleDoneBtn');

        // Track which bundles the user accepted
        const accepted = new Set();

        // Build cards for each suggested bundle
        body.innerHTML = suggestedBundles.map((bundle, bi) => {
          const mainGroup = groups[bundle.mainGroupId];
          const accGroups = bundle.accessoryGroupIds.map(id => groups[id]);

          const mainThumb = mainGroup.imageIndices[0];
          const mainHtml = `<div class="bundle-product">
            <img src="${imageFiles[mainThumb]?.dataUrl || ''}" alt="">
            <span class="bundle-product-name" title="${escapeHtml(mainGroup.productName)}">${escapeHtml(mainGroup.productName)}</span>
          </div>`;

          const accHtml = accGroups.map(g => {
            const accThumb = g.imageIndices[0];
            return `<span class="bundle-plus">+</span>
              <div class="bundle-product">
                <img src="${imageFiles[accThumb]?.dataUrl || ''}" alt="">
                <span class="bundle-product-name" title="${escapeHtml(g.productName)}">${escapeHtml(g.productName)}</span>
              </div>`;
          }).join('');

          const confBadge = bundle.bundleConfidence >= 80 ? 'confidence-high'
            : bundle.bundleConfidence >= 50 ? 'confidence-med' : 'confidence-low';

          return `<div class="bundle-card" id="bundleCard-${bi}">
            <div class="bundle-products">${mainHtml}${accHtml}
              <span class="confidence-badge ${confBadge}" style="margin-left:auto;">${bundle.bundleConfidence}%</span>
            </div>
            <div class="bundle-reason">${escapeHtml(bundle.reason)}</div>
            <div class="bundle-actions">
              <button class="btn btn-primary btn-xs" data-bundle="${bi}" data-action="merge">Merge into one listing</button>
              <button class="btn btn-secondary btn-xs" data-bundle="${bi}" data-action="separate">Keep separate</button>
            </div>
          </div>`;
        }).join('');

        // Handle merge/separate clicks
        body.addEventListener('click', function handler(e) {
          const btn = e.target.closest('[data-bundle]');
          if (!btn) return;
          const bi = parseInt(btn.dataset.bundle);
          const action = btn.dataset.action;
          const card = document.getElementById(`bundleCard-${bi}`);
          const buttons = card.querySelectorAll('.bundle-actions button');

          if (action === 'merge') {
            accepted.add(bi);
            buttons.forEach(b => b.classList.remove('btn-primary', 'btn-secondary'));
            btn.classList.add('btn-primary');
            buttons.forEach(b => { if (b !== btn) b.classList.add('btn-secondary'); });
            card.style.borderColor = '#4f6ef7';
            card.style.background = '#f0f4ff';
          } else {
            accepted.delete(bi);
            buttons.forEach(b => b.classList.remove('btn-primary', 'btn-secondary'));
            btn.classList.add('btn-secondary');
            buttons.forEach(b => { if (b !== btn) { b.classList.remove('btn-primary'); b.classList.add('btn-secondary'); } });
            // Reset: first btn is merge (secondary), second is separate (primary visual = selected)
            const [mergeBtn, sepBtn] = buttons;
            mergeBtn.classList.add('btn-secondary');
            sepBtn.classList.remove('btn-secondary');
            sepBtn.classList.add('btn-primary');
            card.style.borderColor = '#e5e7eb';
            card.style.background = '#fafbfc';
          }
        });

        // Done button closes modal and resolves
        function finish() {
          overlay.classList.remove('open');
          body.innerHTML = '';
          resolve(accepted);
        }
        doneBtn.onclick = finish;

        overlay.classList.add('open');
      });
    }

    function applyBundleMerges(groups, suggestedBundles, acceptedSet) {
      // For each accepted bundle, merge accessory groups into the main group
      const removedGroupIds = new Set();

      for (const bi of acceptedSet) {
        const bundle = suggestedBundles[bi];
        const mainGroup = groups[bundle.mainGroupId];

        // Build the "with accessories" product name
        const accNames = bundle.accessoryGroupIds.map(id => groups[id].productName);
        mainGroup.productName = mainGroup.productName + ' with ' + accNames.join(', ');

        // Merge image indices
        for (const accId of bundle.accessoryGroupIds) {
          mainGroup.imageIndices.push(...groups[accId].imageIndices);
          removedGroupIds.add(accId);
        }
      }

      // Filter out merged accessory groups
      return groups.filter((_, i) => !removedGroupIds.has(i));
    }
```

**Step 2: Update the `submitBtn` click handler to use bundle suggestions**

Replace the section at lines 1125-1154 (from `const data = await resp.json();` through the `clusterData = groups.map(...)` block) with:

```javascript
        const data = await resp.json();
        let groups = data.groups || [];
        const suggestedBundles = data.suggestedBundles || [];

        // Show bundle suggestions if any
        if (suggestedBundles.length > 0) {
          statusText.innerHTML = 'Review suggested bundles...';
          const accepted = await showBundleSuggestions(groups, suggestedBundles);
          if (accepted.size > 0) {
            groups = applyBundleMerges(groups, suggestedBundles, accepted);
          }
        }

        statusText.innerHTML = '<span class="spinner"></span>Building product list...';

        clusterData = groups.map(group => {
          const cluster = group.imageIndices.map(i => ({
            index: i,
            img: imageFiles[i],
            response: {},
          }));
          const brand = (group.productName.match(/^(\S+)/)?.[1]) || '';
          return {
            cluster,
            productName: group.productName,
            confidence: group.confidence || 0,
            brand,
            topLabels: [],
            topWeb: [],
            topLogos: [],
            generatedTitle: null, generatedHtml: null,
            suggestedCategoryId: null, suggestedCategoryName: null,
            suggestedBrand: null, suggestedType: null, suggestedMpn: null,
            ebayItemId: null, rejected: false,
            status: 'pending',
          };
        });
```

**Step 3: Verify the page loads without JS errors**

Open the app in a browser, open dev console, confirm no errors on page load.

**Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add bundle suggestion UI with merge/separate flow

Users can now review AI-suggested bundles and choose to merge
accessories into a single listing before drafts are created."
```

---

### Task 5: Manual End-to-End Testing

**Files:** None (testing only)

**Step 1: Start the server**

Run: `node server.js`

**Step 2: Test with unrelated items**

Upload 2 images of completely different products (e.g., a book and a shoe).
Expected: No bundle suggestion modal appears. Two separate drafts created as before.

**Step 3: Test with related items**

Upload an image of a phone and an image of a charger (or similar accessory pair).
Expected: Bundle suggestion modal appears with one suggestion showing both items, a reason, and merge/separate buttons.

**Step 4: Test merge flow**

Click "Merge into one listing", then "Done".
Expected: One draft created with the combined product name (e.g., "Apple iPhone 15 with Apple USB-C Charger") and all images from both groups.

**Step 5: Test keep separate flow**

Repeat the accessory test. Click "Keep separate", then "Done".
Expected: Two separate drafts created, same as the old behavior.

**Step 6: Commit any fixes found during testing**

```bash
git add -A
git commit -m "fix: address issues found during bundle feature testing"
```
