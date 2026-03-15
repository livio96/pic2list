# LOT Mode Image Analysis — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a prominent toggle above the drop zone that switches between "Single Items" (default) and "LOT" mode. In LOT mode, users upload image(s) of a lot containing multiple items, Gemini identifies each individual item, and one draft is created per item.

**Architecture:** New backend endpoint `/api/openrouter/identify-lot` using the existing `callGemini()` helper with a specialized lot-analysis prompt. Frontend adds a segmented toggle above the drop zone that changes the UI labels and routes the "Identify" button to the appropriate endpoint. LOT results are normalized into the same `clusterData` format so the existing draft/listing pipeline works unchanged.

**Tech Stack:** Express (server.js), Vanilla JS + CSS (index.html), Gemini 2.5 Flash via OpenRouter

---

### Task 1: Add the LOT toggle UI (HTML + CSS)

**Files:**
- Modify: `index.html:645-650` (above the drop zone)
- Modify: `index.html:7-97` (add CSS styles)

**Step 1: Add CSS for the mode toggle**

Insert this CSS after line 96 (before the `/* Product Table */` comment at line 98):

```css
/* Mode toggle */
.mode-toggle-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-bottom: 20px;
}
.mode-toggle {
  display: flex;
  background: #e9ecef;
  border-radius: 12px;
  padding: 4px;
  gap: 2px;
}
.mode-toggle button {
  padding: 10px 28px;
  border: none;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.2s;
  background: transparent;
  color: #8b8fa3;
}
.mode-toggle button.active {
  color: #fff;
  box-shadow: 0 2px 8px rgba(0,0,0,0.10);
}
.mode-toggle button[data-mode="single"].active {
  background: #4f6ef7;
}
.mode-toggle button[data-mode="lot"].active {
  background: #f59e0b;
}
.mode-toggle button:hover:not(.active) {
  color: #3a3f5c;
  background: #f4f6f9;
}
.lot-badge {
  display: inline-block;
  background: #fef3c7;
  color: #92400e;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 6px;
  letter-spacing: 0.5px;
}
```

**Step 2: Add the toggle HTML**

Insert this right before the `<div class="drop-zone" id="dropZone">` line (line 646):

```html
<div class="mode-toggle-wrap" id="modeToggleWrap">
  <div class="mode-toggle" id="modeToggle">
    <button data-mode="single" class="active">Single Items</button>
    <button data-mode="lot">LOT <span class="lot-badge">MULTI</span></button>
  </div>
</div>
```

**Step 3: Verify visually**

Open http://localhost:3000, confirm the toggle renders above the drop zone, "Single Items" is active/blue by default, "LOT" button is visible with amber styling when clicked.

**Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add LOT/Single mode toggle UI above drop zone"
```

---

### Task 2: Wire up the toggle + update labels dynamically

**Files:**
- Modify: `index.html` — JavaScript section (after line ~845 where DOM refs are declared)

**Step 1: Add mode state and toggle logic**

After the line `let totalRawBytes = 0;` (line 848), add:

```javascript
let uploadMode = 'single'; // 'single' or 'lot'

// Mode toggle
document.querySelectorAll('#modeToggle button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#modeToggle button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    uploadMode = btn.dataset.mode;
    updateModeUI();
  });
});

function updateModeUI() {
  const dzTitle = dropZone.querySelector('h2');
  const dzDesc = dropZone.querySelector('p');
  if (uploadMode === 'lot') {
    dzTitle.textContent = 'Drop LOT image(s) here or click to browse';
    dzDesc.textContent = "Upload photos of a lot — we'll identify every individual item";
    submitBtn.textContent = 'Identify Items in Lot';
  } else {
    dzTitle.textContent = 'Drop images here or click to browse';
    dzDesc.textContent = "Upload multiple photos — they'll be grouped by product automatically";
    submitBtn.textContent = 'Identify & Group Products';
  }
}
```

**Step 2: Verify**

Click between "Single Items" and "LOT" — the drop zone text and button label should change dynamically.

**Step 3: Commit**

```bash
git add index.html
git commit -m "feat: wire up mode toggle to update drop zone labels"
```

---

### Task 3: Add the backend `/api/openrouter/identify-lot` endpoint

**Files:**
- Modify: `server.js:634` (insert new endpoint after the existing `/api/openrouter/identify` handler, before the OpenAI proxy)

**Step 1: Add the endpoint**

Insert after line 634 (after the closing `});` of the identify endpoint):

```javascript
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

Before providing your final answer, use the scratchpad below to work through your analysis:

<scratchpad>
In your scratchpad, you should:
- Systematically scan through the image${images.length > 1 ? 's' : ''} from left to right, top to bottom (or in whatever logical order makes sense for the layout)
- Note any visible text, labels, titles, or identifying features on each item
- Count the total number of distinct items you can identify
- For items where text is partially visible or unclear, note what you can see and make reasonable inferences
- Group items by type if that helps with organization (e.g., all books together, all cards together)
- Note any items that are too obscured or unclear to identify with confidence
</scratchpad>

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
```

**Step 2: Test with curl**

```bash
# Smoke test — should return error about no images
curl -s -X POST http://localhost:3000/api/openrouter/identify-lot \
  -H "Content-Type: application/json" \
  -d '{"images":[]}' | head -c 200
```

Expected: `{"error":{"message":"No images provided"}}` (or auth redirect).

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add /api/openrouter/identify-lot endpoint for lot image analysis"
```

---

### Task 4: Wire frontend LOT mode to the new endpoint

**Files:**
- Modify: `index.html` — the `submitBtn` click handler (around line 1279)

**Step 1: Add the LOT identification path**

Replace the `submitBtn.addEventListener('click', async () => {` block (lines 1279–1346) with updated logic that branches on `uploadMode`:

The key change is inside the `try` block. After `const base64Images = imageFiles.map(img => img.base64);`, branch:

```javascript
if (uploadMode === 'lot') {
  // LOT mode: send to lot endpoint, get individual items back
  statusText.innerHTML = '<span class="spinner"></span>Analyzing lot — identifying individual items...';
  const resp = await apiFetch('/api/openrouter/identify-lot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: base64Images })
  });
  if (!resp.ok) { const err = await resp.json(); throw new Error(err.error?.message || `API error ${resp.status}`); }
  const data = await resp.json();
  const items = data.items || [];

  if (items.length === 0) {
    statusText.textContent = 'No items identified in the lot image(s). Try a clearer photo.';
    submitBtn.disabled = false;
    return;
  }

  statusText.innerHTML = `<span class="spinner"></span>Found ${items.length} items — building drafts...`;

  // Convert LOT items into clusterData format (one "cluster" per item, all images shared)
  clusterData = items.map((item) => {
    // Each item gets ALL uploaded images (since we can't crop individuals from the lot photo)
    const cluster = imageFiles.map((img, i) => ({
      index: i,
      img,
      response: {},
    }));
    const title = item.details ? `${item.title} (${item.details})` : item.title;
    const brand = (title.match(/^(\S+)/)?.[1]) || '';
    return {
      cluster,
      productName: title,
      confidence: 70, // LOT items have moderate confidence by default
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

  renderProductTable(clusterData);
  await createDraftsInDB();
  statusText.innerHTML = `Identified <strong>${items.length} items</strong> from lot. Review and generate listings below.`;
  submitBtn.disabled = false;
} else {
  // SINGLE mode: existing flow (keep the entire current try-block body here)
```

Wrap the **existing** code inside the else branch (the `/api/openrouter/identify` call, bundle suggestions, clusterData mapping, etc.).

The full structure is:

```javascript
submitBtn.addEventListener('click', async () => {
  if (imageFiles.length === 0) return;
  submitBtn.disabled = true;

  try {
    const base64Images = imageFiles.map(img => img.base64);

    if (uploadMode === 'lot') {
      // ... LOT code from above ...
    } else {
      // ... existing single-mode code (lines 1283–1345 unchanged) ...
    }
  } catch (err) {
    statusText.textContent = `Error: ${err.message}`;
    submitBtn.disabled = false;
    return;
  }
  submitBtn.disabled = false;
});
```

**Step 2: Verify end-to-end**

1. Open http://localhost:3000
2. Click "LOT" toggle
3. Upload an image of multiple items (e.g., a bookshelf, trading card collection)
4. Click "Identify Items in Lot"
5. Confirm: spinner shows, items are identified, product table populates with individual items

**Step 3: Commit**

```bash
git add index.html
git commit -m "feat: wire LOT mode to identify-lot endpoint and create per-item drafts"
```

---

### Task 5: Polish and edge cases

**Files:**
- Modify: `index.html`

**Step 1: Reset mode on clear**

In the `clearBtn` click handler (around line 1151), after `resultsSection.style.display = 'none';`, add:

```javascript
// Reset to single mode
uploadMode = 'single';
document.querySelectorAll('#modeToggle button').forEach(b => b.classList.remove('active'));
document.querySelector('#modeToggle button[data-mode="single"]').classList.add('active');
updateModeUI();
```

**Step 2: Disable toggle while processing**

In the `submitBtn` click handler, after `submitBtn.disabled = true;`, add:

```javascript
document.querySelectorAll('#modeToggle button').forEach(b => b.disabled = true);
```

And in the finally/cleanup path (before `submitBtn.disabled = false;`), add:

```javascript
document.querySelectorAll('#modeToggle button').forEach(b => b.disabled = false);
```

**Step 3: Verify**

- Click "Clear All" → mode resets to "Single Items"
- While identifying, toggle buttons are disabled
- After completion/error, toggle buttons re-enable

**Step 4: Commit**

```bash
git add index.html
git commit -m "feat: polish LOT mode — reset on clear, disable toggle during processing"
```
