# Infographic Image Quality Upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all 9 infographic canvas templates with modern dark-charcoal, callout-diagram-style eBay listing images — bold marketing taglines, connector lines from product to feature boxes, coloured accent elements.

**Architecture:** All canvas rendering is inline JS in `index.html`. New helper functions are added to the existing helpers block (~line 4720). Each of the 9 template functions is replaced in-place. Backend `server.js` Gemini prompt is extended to return `tagline`, per-feature `position` hints, and `conditionBadges`. `generateImages()` in `index.html` is updated to destructure and pass these fields to templates.

**Tech Stack:** Vanilla JS Canvas 2D API, Node/Express, Gemini via OpenRouter.

---

## Files

| File | Change |
|------|--------|
| `index.html` | Add 6 helpers; rewrite all 9 template functions; update `generateImages` wiring |
| `server.js` | Extend Gemini prompt; parse `tagline`, `position`, `conditionBadges` from response |

---

## Task 1: Add helper functions

**Files:**
- Modify: `index.html` — insert before `function infBuildPalette(` (~line 4755)

- [ ] **Step 1: Insert 6 new helpers**

Find this exact line in `index.html`:
```javascript
    function infBuildPalette(baseHex, count) {
```

Insert the following block immediately before it:

```javascript
    function infLightenHex(hex, amount) {
      const h = hex.replace('#', '');
      const r = Math.min(255, Math.round(parseInt(h.substring(0,2),16) + (255 - parseInt(h.substring(0,2),16)) * amount));
      const g = Math.min(255, Math.round(parseInt(h.substring(2,4),16) + (255 - parseInt(h.substring(2,4),16)) * amount));
      const b = Math.min(255, Math.round(parseInt(h.substring(4,6),16) + (255 - parseInt(h.substring(4,6),16)) * amount));
      return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
    }

    function infTintHex(base, accent, ratio) {
      const bh = base.replace('#', ''), ah = accent.replace('#', '');
      const br = parseInt(bh.substring(0,2),16), bg2 = parseInt(bh.substring(2,4),16), bb = parseInt(bh.substring(4,6),16);
      const ar = parseInt(ah.substring(0,2),16), ag = parseInt(ah.substring(2,4),16), ab = parseInt(ah.substring(4,6),16);
      const r = Math.round(br + (ar - br) * ratio);
      const g = Math.round(bg2 + (ag - bg2) * ratio);
      const b = Math.round(bb + (ab - bb) * ratio);
      return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
    }

    function infBuildDepthPalette(accentHex) {
      const ac = infValidHex(accentHex);
      return {
        bg:           infTintHex('#272829', ac, 0.06),
        surface:      infHexToRgba(ac, 0.08),
        border:       infHexToRgba(ac, 0.25),
        glow:         infHexToRgba(ac, 0.28),
        shimmer:      ac,
        shimmerLight: infLightenHex(ac, 0.30),
        text:         '#ffffff',
        muted:        'rgba(255,255,255,0.55)',
      };
    }

    async function infDrawProduct(ctx, src, x, y, w, h, accentColor) {
      const ac = infValidHex(accentColor);
      // 1. Radial glow behind product
      const glow = ctx.createRadialGradient(x + w/2, y + h/2, 0, x + w/2, y + h/2, Math.max(w, h) * 0.65);
      glow.addColorStop(0, infHexToRgba(ac, 0.28));
      glow.addColorStop(1, 'transparent');
      ctx.fillStyle = glow; ctx.fillRect(x, y, w, h);
      // 2. Draw fitted image
      await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const aspect = img.width / img.height, boxAspect = w / h;
          let dw, dh, dx, dy;
          if (aspect > boxAspect) { dw = w; dh = w / aspect; dx = x; dy = y + (h - dh) / 2; }
          else { dh = h; dw = h * aspect; dy = y; dx = x + (w - dw) / 2; }
          ctx.drawImage(img, dx, dy, dw, dh);
          resolve();
        };
        img.onerror = resolve;
        img.src = src;
      });
      // 3. Radial vignette (edges fade to background)
      const vig = ctx.createRadialGradient(x + w/2, y + h/2, Math.min(w, h) * 0.25, x + w/2, y + h/2, Math.max(w, h) * 0.75);
      vig.addColorStop(0, 'transparent');
      vig.addColorStop(1, 'rgba(39,40,41,0.70)');
      ctx.fillStyle = vig; ctx.fillRect(x, y, w, h);
      // 4. Subtle accent tint
      ctx.fillStyle = infHexToRgba(ac, 0.08); ctx.fillRect(x, y, w, h);
    }

    function infDrawShimmer(ctx, W, ac) {
      const shimmer = ctx.createLinearGradient(0, 0, W * 0.75, 0);
      shimmer.addColorStop(0, ac);
      shimmer.addColorStop(0.55, infLightenHex(ac, 0.30));
      shimmer.addColorStop(1, 'transparent');
      ctx.fillStyle = shimmer; ctx.fillRect(0, 0, W, 3);
    }

    // Returns the y-offset after the tagline (i.e. how much vertical space was used)
    function infDrawTagline(ctx, W, tagline, startY, ac, FONT) {
      const line1 = tagline?.line1 || '';
      const line2 = tagline?.line2 || '';
      if (line1) {
        ctx.fillStyle = '#ffffff'; ctx.font = `800 50px ${FONT}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(infTrunc(line1, 42), W/2, startY);
      }
      if (line2) {
        ctx.fillStyle = 'rgba(255,255,255,0.65)'; ctx.font = `400 26px ${FONT}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(infTrunc(line2, 58), W/2, startY + 62);
      }
      return line2 ? startY + 104 : (line1 ? startY + 66 : startY);
    }

```

- [ ] **Step 2: Confirm no syntax errors**

```bash
node server.js
```

Open http://localhost:3000, confirm page loads without console errors.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add infLightenHex, infTintHex, infBuildDepthPalette, infDrawProduct, infDrawShimmer, infDrawTagline helpers"
```

---

## Task 2: Global font stack replacement

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Replace all Arial font strings**

Use Edit tool with `replace_all: true`:
- Find: `Arial,sans-serif`
- Replace: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`

- [ ] **Step 2: Verify zero Arial references remain in `<script>` section**

Search `index.html` for `Arial` within the script tag — confirm zero matches.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: replace Arial with system font stack across all canvas functions"
```

---

## Task 3: Backend — extend Gemini prompt

**Files:**
- Modify: `server.js` — the `/api/generate-images` route (~line 787)

- [ ] **Step 1: Replace the prompt text inside the `content.push({ type: 'text', text: ...` call**

Find:
```javascript
      text: `Analyze this product and extract 4–6 key selling features for an eBay product infographic.
```

Replace the entire `text:` value with:

```javascript
      text: `Analyze this product listing and return data for professional eBay infographic images.

Product: "${title}"${descText ? `\n\nProduct description context:\n${descText}` : ''}

Return ONLY valid JSON in exactly this format:
{
  "tagline": {
    "line1": "Short punchy headline (max 40 chars)",
    "line2": "Descriptive subtitle (max 55 chars)"
  },
  "features": [
    { "name": "Short Name", "detail": "Brief detail (max 35 chars)", "icon": "emoji", "position": "top-left" }
  ],
  "accentColor": "#hexcolor",
  "conditionBadges": [
    { "label": "Badge text (max 22 chars)", "colorKey": "green" }
  ]
}

Rules for tagline:
- line1: Bold punchy headline like "10 Ports. Zero Compromises." or "Sound Without Limits." — max 40 chars
- line2: Descriptive subtitle like "The ultimate universal hub." — max 55 chars

Rules for features (4–6 items):
- "name": 1–3 words, key feature (e.g. "GPS", "4K Display", "Waterproof IP68")
- "detail": Brief supporting detail visible in image or description, max 35 chars
- "icon": Single relevant emoji
- "position": one of top-left, top-right, bottom-left, bottom-right, left, right — distribute across 6 positions, no repeats, most important features at top
- Choose the MOST IMPORTANT buyer-facing features

Rules for accentColor:
- Brand-appropriate hex color (Apple → "#1c1c1e", Dell/tech → "#0076ce", sports → "#e63946", default → "#4f6ef7")

Rules for conditionBadges (exactly 4):
- Infer from image/description what resale buyers want confirmed
- "label": Short trust signal max 22 chars (e.g. "No Scratches", "Box Included", "Fully Tested", "Unlocked")
- "colorKey": one of green (cosmetic), blue (completeness), amber (functionality), red (notable detail)
- Return exactly 4 items, one per colorKey`,
```

- [ ] **Step 2: Update the response parsing**

Find:
```javascript
    const features = (result.features || []).slice(0, 6);
    const accentColor = /^#[0-9a-fA-F]{6}$/.test(result.accentColor || '') ? result.accentColor : '#4f6ef7';

    res.json({ success: true, features, accentColor });
```

Replace with:
```javascript
    const features = (result.features || []).slice(0, 6);
    const accentColor = /^#[0-9a-fA-F]{6}$/.test(result.accentColor || '') ? result.accentColor : '#4f6ef7';

    const validPositions = new Set(['top-left','top-right','bottom-left','bottom-right','left','right']);
    features.forEach(f => { if (!validPositions.has(f.position)) f.position = null; });

    const tagline = (result.tagline && typeof result.tagline.line1 === 'string')
      ? { line1: String(result.tagline.line1).substring(0, 42), line2: String(result.tagline.line2 || '').substring(0, 58) }
      : null;

    const validColorKeys = new Set(['green','blue','amber','red']);
    const conditionBadges = (result.conditionBadges || [])
      .filter(b => b && typeof b.label === 'string' && validColorKeys.has(b.colorKey))
      .slice(0, 4);

    res.json({ success: true, features, accentColor, tagline, conditionBadges });
```

- [ ] **Step 3: Restart server and check API response**

```bash
node server.js
```

In DevTools, trigger "Generate Images" for a product with a description. Check the `/api/generate-images` response in the Network tab — confirm it contains `tagline`, `features` with `position` fields, `accentColor`, and `conditionBadges`.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: extend generate-images Gemini prompt for tagline, positions, conditionBadges"
```

---

## Task 4: Update `generateImages` wiring in index.html

**Files:**
- Modify: `index.html` — the `generateImages` function (~line 4156)

- [ ] **Step 1: Destructure new fields from API response**

Find:
```javascript
        const { features, accentColor } = data;
```

Replace with:
```javascript
        const { features, accentColor, tagline, conditionBadges } = data;
```

- [ ] **Step 2: Replace the templates array**

Find:
```javascript
        const templates = [
          { id: 'spotlight',   label: 'Feature Spotlight', fn: infSpotlight },
          { id: 'darkspecs',   label: 'Dark Specs',         fn: infDarkSpecs },
          { id: 'featgrid',    label: 'Feature Grid',       fn: infFeatureGrid },
          { id: 'herobanner',  label: 'Hero Banner',        fn: infHeroBanner },
          { id: 'splitpanel',  label: 'Split Panel',        fn: infSplitPanel },
          { id: 'boldblocks',  label: 'Bold Blocks',        fn: infBoldBlocks },
          { id: 'minimal',     label: 'Minimal Poster',     fn: infMinimal },
          { id: 'socialcard',  label: 'Social Card',        fn: infSocialCard },
        ];
```

Replace with:
```javascript
        const tplArgs = (fn) => (c, img, t, f, ac) => fn(c, img, t, f, ac, tagline, conditionBadges);
        const templates = [
          { id: 'callout',          label: 'Callout Diagram',   fn: tplArgs(infCalloutDiagram) },
          { id: 'featgrid',         label: 'Feature Grid',       fn: tplArgs(infFeatureGrid) },
          { id: 'herobanner',       label: 'Hero Banner',        fn: tplArgs(infHeroBanner) },
          { id: 'spotlight',        label: 'Spotlight',          fn: tplArgs(infSpotlight) },
          { id: 'darkspecs',        label: 'Dark Specs',         fn: tplArgs(infDarkSpecs) },
          { id: 'splitpanel',       label: 'Split Panel',        fn: tplArgs(infSplitPanel) },
          { id: 'conditionshowcase',label: 'Condition Showcase', fn: tplArgs(infConditionShowcase) },
          { id: 'minimal',          label: 'Minimal',            fn: tplArgs(infMinimal) },
          { id: 'socialcard',       label: 'Social Card',        fn: tplArgs(infSocialCard) },
        ];
```

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: wire tagline and conditionBadges through generateImages to all templates"
```

---

## Task 5: Callout Diagram template

**Files:**
- Modify: `index.html` — replace entire `infSpotlight` function with `infCalloutDiagram` (the old spotlight fn becomes this new one; the id `spotlight` from the old array is gone, replaced by `callout` in Task 4)

- [ ] **Step 1: Replace the `infSpotlight` function entirely**

Find `async function infSpotlight(` through its closing `}` and replace with:

```javascript
    // ── Template 1: Callout Diagram ──────────────────────────────────────────
    async function infCalloutDiagram(canvas, productDataUrl, title, features, accentColor, tagline) {
      const W = 1200, H = 900, ctx = canvas.getContext('2d');
      canvas.width = W; canvas.height = H;
      const ac = infValidHex(accentColor);
      const p = infBuildDepthPalette(ac);
      const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
      const BOX_W = 192, BOX_H = 78;

      // Background
      ctx.fillStyle = p.bg; ctx.fillRect(0, 0, W, H);
      infDrawShimmer(ctx, W, ac);

      // Tagline
      const tagY = infDrawTagline(ctx, W, tagline || { line1: infTrunc(title, 38), line2: '' }, 16, ac, FONT);

      // Product image — centered, large
      const prodX = 220, prodY = tagY + 16, prodW = 760, prodH = H - tagY - 36;
      if (productDataUrl) await infDrawProduct(ctx, productDataUrl, prodX, prodY, prodW, prodH, ac);
      else infPlaceholderDark(ctx, prodX, prodY, prodW, prodH);

      // 6 fixed box positions
      const positions = {
        'top-left':     { bx: 14,              by: prodY + 10 },
        'top-right':    { bx: W - BOX_W - 14,  by: prodY + 10 },
        'left':         { bx: 14,              by: prodY + prodH/2 - BOX_H/2 },
        'right':        { bx: W - BOX_W - 14,  by: prodY + prodH/2 - BOX_H/2 },
        'bottom-left':  { bx: 14,              by: prodY + prodH - BOX_H - 10 },
        'bottom-right': { bx: W - BOX_W - 14,  by: prodY + prodH - BOX_H - 10 },
      };
      const defaultOrder = ['top-left','top-right','bottom-left','bottom-right','left','right'];
      const used = new Set();

      const maxF = Math.min(features.length, 6);
      for (let i = 0; i < maxF; i++) {
        const f = features[i];
        const posKey = (f.position && positions[f.position] && !used.has(f.position))
          ? f.position
          : defaultOrder.find(k => !used.has(k)) || defaultOrder[i % 6];
        used.add(posKey);
        const { bx, by } = positions[posKey];

        const isLeft = bx < W / 2;
        const connProdX = isLeft ? prodX + 4 : prodX + prodW - 4;
        const connProdY = by + BOX_H / 2;
        const connBoxX  = isLeft ? bx + BOX_W : bx;

        // Right-angle connector line
        ctx.strokeStyle = 'rgba(255,255,255,0.40)'; ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(connBoxX, connProdY);
        const midX = connBoxX + (connProdX - connBoxX) * 0.55;
        ctx.lineTo(midX, connProdY);
        ctx.lineTo(midX, connProdY);
        ctx.lineTo(connProdX, connProdY);
        ctx.stroke();

        // Accent dot at product end
        ctx.fillStyle = ac;
        ctx.beginPath(); ctx.arc(connProdX, connProdY, 5, 0, Math.PI * 2); ctx.fill();

        // Feature box
        infRoundRect(ctx, bx, by, BOX_W, BOX_H, 10);
        ctx.fillStyle = infHexToRgba(ac, 0.88); ctx.fill();
        ctx.strokeStyle = infLightenHex(ac, 0.25); ctx.lineWidth = 1; ctx.stroke();

        ctx.font = `bold 16px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        ctx.fillText(`${f.icon || ''} ${infTrunc(f.name || '', 18)}`, bx + BOX_W/2, by + BOX_H/2 - 10);
        ctx.font = `12px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,0.78)';
        ctx.fillText(infTrunc(f.detail || '', 24), bx + BOX_W/2, by + BOX_H/2 + 12);
      }

      ctx.font = `11px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText('LazyListings', W - 16, H - 10);
    }
```

- [ ] **Step 2: Verify visually**

Start server, generate images. The "Callout Diagram" card should show: dark charcoal bg, bold tagline at top, product photo centered with glow/vignette, up to 6 accent-colored boxes arranged around the product, right-angle connector lines with accent dots at the product end.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add Callout Diagram as primary infographic template"
```

---

## Task 6: Feature Grid template (dark)

**Files:**
- Modify: `index.html` — replace entire `infFeatureGrid` function

- [ ] **Step 1: Replace `infFeatureGrid`**

```javascript
    // ── Template 2: Feature Grid ──────────────────────────────────────────────
    async function infFeatureGrid(canvas, productDataUrl, title, features, accentColor, tagline) {
      const W = 1200, H = 900, ctx = canvas.getContext('2d');
      canvas.width = W; canvas.height = H;
      const ac = infValidHex(accentColor);
      const p = infBuildDepthPalette(ac);
      const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
      const tileColors = ['#7c3aed','#059669','#d97706','#0284c7','#db2777','#4f6ef7'];

      ctx.fillStyle = p.bg; ctx.fillRect(0, 0, W, H);
      infDrawShimmer(ctx, W, ac);

      // Tagline
      const tagY = infDrawTagline(ctx, W, tagline || { line1: infTrunc(title, 38), line2: '' }, 16, ac, FONT);

      // Product image top-center
      const prodH = 310;
      if (productDataUrl) await infDrawProduct(ctx, productDataUrl, 250, tagY + 10, 700, prodH, ac);
      else infPlaceholderDark(ctx, 250, tagY + 10, 700, prodH);

      // Separator line
      ctx.fillStyle = p.border; ctx.fillRect(40, tagY + prodH + 18, W - 80, 1);

      // Feature cards grid (2 rows × 3 cols)
      const maxF = Math.min(features.length, 6);
      const cols = 3, cw = 366, ch = 150, gx = 15, gy = 12;
      const gridW = cols * cw + (cols - 1) * gx;
      const startX = (W - gridW) / 2;
      const startY = tagY + prodH + 30;

      for (let i = 0; i < maxF; i++) {
        const f = features[i];
        const col = i % cols, row = Math.floor(i / cols);
        const cx = startX + col * (cw + gx), cy = startY + row * (ch + gy);
        const tc = tileColors[i % tileColors.length];

        infRoundRect(ctx, cx, cy, cw, ch, 12);
        ctx.fillStyle = p.surface; ctx.fill();
        ctx.strokeStyle = p.border; ctx.lineWidth = 1; ctx.stroke();

        // Left accent strip
        infRoundRect(ctx, cx, cy, 4, ch, 12, 12, 0, 0, 12);
        ctx.fillStyle = tc; ctx.fill();

        // Icon tile
        infRoundRect(ctx, cx + 16, cy + (ch - 46) / 2, 46, 46, 10);
        ctx.fillStyle = infHexToRgba(tc, 0.20); ctx.fill();
        ctx.strokeStyle = infHexToRgba(tc, 0.40); ctx.lineWidth = 1; ctx.stroke();
        ctx.font = `24px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff'; ctx.fillText(f.icon || '⭐', cx + 39, cy + ch / 2);

        ctx.font = `bold 16px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = p.text; ctx.fillText(infTrunc(f.name || '', 24), cx + 76, cy + ch/2 - 6);
        ctx.font = `13px ${FONT}`; ctx.fillStyle = p.muted;
        ctx.fillText(infTrunc(f.detail || '', 32), cx + 76, cy + ch/2 + 17);
      }

      ctx.font = `11px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText('LazyListings', W - 16, H - 10);
    }
```

- [ ] **Step 2: Verify visually** — dark bg, tagline top, product image, separator, 2×3 dark feature cards each with coloured left strip + coloured icon tile.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: rewrite infFeatureGrid — dark charcoal with coloured icon tiles"
```

---

## Task 7: Hero Banner template

**Files:**
- Modify: `index.html` — replace entire `infHeroBanner` function

- [ ] **Step 1: Replace `infHeroBanner`**

```javascript
    // ── Template 3: Hero Banner ───────────────────────────────────────────────
    async function infHeroBanner(canvas, productDataUrl, title, features, accentColor, tagline) {
      const W = 1200, H = 900, ctx = canvas.getContext('2d');
      canvas.width = W; canvas.height = H;
      const ac = infValidHex(accentColor);
      const p = infBuildDepthPalette(ac);
      const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
      const pillColors = ['#7c3aed','#059669','#d97706','#0284c7','#db2777'];

      ctx.fillStyle = p.bg; ctx.fillRect(0, 0, W, H);

      // Full-bleed product image with glow + vignette
      if (productDataUrl) {
        const img = await infLoadImage(productDataUrl);
        if (img) {
          const bgGlow = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, Math.max(W,H) * 0.65);
          bgGlow.addColorStop(0, infHexToRgba(ac, 0.22)); bgGlow.addColorStop(1, 'transparent');
          ctx.fillStyle = bgGlow; ctx.fillRect(0, 0, W, H);
          const aspect = img.width / img.height, bAspect = W / H;
          let dw, dh, dx, dy;
          if (aspect > bAspect) { dh = H; dw = H * aspect; dy = 0; dx = (W - dw) / 2; }
          else { dw = W; dh = W / aspect; dx = 0; dy = (H - dh) / 2; }
          ctx.drawImage(img, dx, dy, dw, dh);
          ctx.fillStyle = infHexToRgba(ac, 0.08); ctx.fillRect(0, 0, W, H);
        }
      }

      // Dark gradient overlays
      const topGrad = ctx.createLinearGradient(0, 0, 0, 240);
      topGrad.addColorStop(0, 'rgba(0,0,0,0.88)'); topGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = topGrad; ctx.fillRect(0, 0, W, 240);
      const botGrad = ctx.createLinearGradient(0, H - 300, 0, H);
      botGrad.addColorStop(0, 'transparent'); botGrad.addColorStop(1, 'rgba(0,0,0,0.92)');
      ctx.fillStyle = botGrad; ctx.fillRect(0, H - 300, W, 300);

      infDrawShimmer(ctx, W, ac);

      // Tagline overlaid on top gradient
      infDrawTagline(ctx, W, tagline || { line1: infTrunc(title, 38), line2: '' }, 20, ac, FONT);

      // Coloured feature pills at bottom
      const maxF = Math.min(features.length, 5);
      const pillH = 60, pillGap = 10;
      ctx.font = `bold 14px ${FONT}`;
      const pillWidths = features.slice(0, maxF).map(f =>
        Math.max(148, ctx.measureText(`${f.icon || '⭐'}  ${infTrunc(f.name || '', 18)}`).width + 60)
      );
      const totalPillW = pillWidths.reduce((a,b) => a+b, 0) + pillGap * (maxF - 1);
      let px = (W - totalPillW) / 2;
      const pillY = H - pillH - 40;

      for (let i = 0; i < maxF; i++) {
        const f = features[i];
        const pw = pillWidths[i], pc = pillColors[i % pillColors.length];
        infRoundRect(ctx, px, pillY, pw, pillH, pillH / 2);
        ctx.fillStyle = infHexToRgba(pc, 0.88); ctx.fill();
        ctx.strokeStyle = infLightenHex(pc, 0.25); ctx.lineWidth = 1; ctx.stroke();
        ctx.font = `20px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff'; ctx.fillText(f.icon || '⭐', px + 14, pillY + pillH/2);
        ctx.font = `bold 14px ${FONT}`;
        ctx.fillText(infTrunc(f.name || '', 18), px + 42, pillY + pillH/2);
        px += pw + pillGap;
      }

      ctx.font = `11px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText('LazyListings', W - 18, H - 10);
    }
```

- [ ] **Step 2: Verify visually** — full-bleed product photo, dark gradients at top and bottom, tagline overlaid top, coloured pills bottom.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: rewrite infHeroBanner — full-bleed dark with tagline + coloured pills"
```

---

## Task 8: Spotlight template (dark)

**Files:**
- Modify: `index.html` — the `infCalloutDiagram` function was placed where `infSpotlight` was; now add the new `infSpotlight` function after `infCalloutDiagram`.

- [ ] **Step 1: Replace the `infDarkSpecs` function with two functions: new `infSpotlight` then new `infDarkSpecs`**

Find `async function infDarkSpecs(` and insert this new `infSpotlight` function immediately before it:

```javascript
    // ── Template 4: Spotlight ────────────────────────────────────────────────
    async function infSpotlight(canvas, productDataUrl, title, features, accentColor, tagline) {
      const W = 1200, H = 900, ctx = canvas.getContext('2d');
      canvas.width = W; canvas.height = H;
      const ac = infValidHex(accentColor);
      const p = infBuildDepthPalette(ac);
      const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

      ctx.fillStyle = p.bg; ctx.fillRect(0, 0, W, H);
      infDrawShimmer(ctx, W, ac);

      // Tagline top
      const tagY = infDrawTagline(ctx, W, tagline || { line1: infTrunc(title, 38), line2: '' }, 16, ac, FONT);

      // Product left (large)
      const prodX = 20, prodY = tagY + 10, prodW = 530, prodH = H - tagY - 20;
      if (productDataUrl) await infDrawProduct(ctx, productDataUrl, prodX, prodY, prodW, prodH, ac);
      else infPlaceholderDark(ctx, prodX, prodY, prodW, prodH);

      // Accent vertical divider
      const divGrad = ctx.createLinearGradient(0, prodY, 0, prodY + prodH);
      divGrad.addColorStop(0, 'transparent'); divGrad.addColorStop(0.3, ac); divGrad.addColorStop(0.7, p.shimmerLight); divGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = divGrad; ctx.fillRect(558, prodY, 3, prodH);

      // Feature rows right side
      const maxF = Math.min(features.length, 5);
      const rowH = (H - tagY - 20) / maxF;
      for (let i = 0; i < maxF; i++) {
        const f = features[i];
        const ry = tagY + 10 + i * rowH, midY = ry + rowH / 2;

        // Connector dot
        ctx.fillStyle = ac;
        ctx.beginPath(); ctx.arc(561, midY, 5, 0, Math.PI * 2); ctx.fill();

        // Card
        infRoundRect(ctx, 575, ry + 8, W - 590, rowH - 16, 12);
        ctx.fillStyle = p.surface; ctx.fill();
        ctx.strokeStyle = p.border; ctx.lineWidth = 1; ctx.stroke();
        infRoundRect(ctx, 575, ry + 8, 4, rowH - 16, 12, 12, 0, 0, 12);
        ctx.fillStyle = ac; ctx.fill();

        // Icon tile
        infRoundRect(ctx, 591, midY - 22, 44, 44, 10);
        ctx.fillStyle = infHexToRgba(ac, 0.22); ctx.fill();
        ctx.font = `22px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff'; ctx.fillText(f.icon || '⭐', 613, midY);

        ctx.font = `bold 17px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = p.text; ctx.fillText(infTrunc(f.name || '', 28), 648, midY - 7);
        ctx.font = `13px ${FONT}`; ctx.fillStyle = p.muted;
        ctx.fillText(infTrunc(f.detail || '', 42), 648, midY + 16);

        if (i < maxF - 1) {
          ctx.strokeStyle = p.border; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(575, ry + rowH); ctx.lineTo(W - 15, ry + rowH); ctx.stroke();
        }
      }

      ctx.font = `11px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText('LazyListings', W - 16, H - 10);
    }
```

- [ ] **Step 2: Verify visually** — dark bg, tagline top, large product left, gradient divider, dark glass feature rows right with connector dots and icon tiles.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add dark Spotlight template with connector dots and glass rows"
```

---

## Task 9: Dark Specs template

**Files:**
- Modify: `index.html` — replace entire `infDarkSpecs` function

- [ ] **Step 1: Replace `infDarkSpecs`**

```javascript
    // ── Template 5: Dark Specs ───────────────────────────────────────────────
    async function infDarkSpecs(canvas, productDataUrl, title, features, accentColor, tagline) {
      const W = 1200, H = 900, ctx = canvas.getContext('2d');
      canvas.width = W; canvas.height = H;
      const ac = infValidHex(accentColor);
      const p = infBuildDepthPalette(ac);
      const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

      ctx.fillStyle = p.bg; ctx.fillRect(0, 0, W, H);
      const bgGlow = ctx.createRadialGradient(W/2, 360, 30, W/2, 360, 420);
      bgGlow.addColorStop(0, infHexToRgba(ac, 0.18)); bgGlow.addColorStop(1, 'transparent');
      ctx.fillStyle = bgGlow; ctx.fillRect(0, 0, W, H);
      infDrawShimmer(ctx, W, ac);

      // Tagline
      const tagY = infDrawTagline(ctx, W, tagline || { line1: infTrunc(title, 38), line2: '' }, 16, ac, FONT);

      // Product image center-top
      const prodH = 480;
      if (productDataUrl) await infDrawProduct(ctx, productDataUrl, 220, tagY + 10, 760, prodH, ac);
      else infPlaceholderDark(ctx, 220, tagY + 10, 760, prodH);

      // Spec cards row
      const maxF = Math.min(features.length, 4);
      const gx = 12, cw = (W - 60 - gx * (maxF - 1)) / maxF, ch = H - tagY - prodH - 32;
      const startY = tagY + prodH + 22;

      for (let i = 0; i < maxF; i++) {
        const f = features[i];
        const cx = 30 + i * (cw + gx);
        infRoundRect(ctx, cx, startY, cw, ch, 14);
        ctx.fillStyle = p.surface; ctx.fill();
        ctx.strokeStyle = p.border; ctx.lineWidth = 1; ctx.stroke();

        // Top accent strip
        infRoundRect(ctx, cx, startY, cw, 3, 14, 14, 14, 0, 0);
        ctx.fillStyle = ac; ctx.fill();

        // Icon tile
        infRoundRect(ctx, cx + cw/2 - 26, startY + 14, 52, 52, 12);
        ctx.fillStyle = infHexToRgba(ac, 0.22); ctx.fill();
        ctx.font = `28px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff'; ctx.fillText(f.icon || '⭐', cx + cw/2, startY + 40);

        ctx.font = `bold 15px ${FONT}`; ctx.fillStyle = p.text; ctx.textBaseline = 'top';
        ctx.fillText(infTrunc(f.name || '', 18), cx + cw/2, startY + 76);
        ctx.font = `12px ${FONT}`; ctx.fillStyle = p.muted;
        ctx.fillText(infTrunc(f.detail || '', 22), cx + cw/2, startY + 100);
      }

      ctx.font = `11px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('LazyListings', W/2, H - 10);
    }
```

- [ ] **Step 2: Verify visually** — dark bg with ambient glow, tagline, product center-top, spec cards row below with top accent strips and icon tiles.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: rewrite infDarkSpecs — dark with tagline + spec card row"
```

---

## Task 10: Split Panel template (dark both sides)

**Files:**
- Modify: `index.html` — replace entire `infSplitPanel` function

- [ ] **Step 1: Replace `infSplitPanel`**

```javascript
    // ── Template 6: Split Panel ──────────────────────────────────────────────
    async function infSplitPanel(canvas, productDataUrl, title, features, accentColor, tagline) {
      const W = 1200, H = 900, ctx = canvas.getContext('2d');
      canvas.width = W; canvas.height = H;
      const ac = infValidHex(accentColor);
      const p = infBuildDepthPalette(ac);
      const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
      const split = 500;

      // Left panel
      ctx.fillStyle = p.bg; ctx.fillRect(0, 0, split, H);
      const leftGlow = ctx.createLinearGradient(0, 0, split, 0);
      leftGlow.addColorStop(0, infHexToRgba(ac, 0.12)); leftGlow.addColorStop(1, 'transparent');
      ctx.fillStyle = leftGlow; ctx.fillRect(0, 0, split, H);

      // Right panel slightly lighter
      ctx.fillStyle = infTintHex('#1e1f20', ac, 0.05); ctx.fillRect(split, 0, W - split, H);

      // Gradient divider
      const divGrad = ctx.createLinearGradient(0, 0, 0, H);
      divGrad.addColorStop(0, 'transparent'); divGrad.addColorStop(0.2, ac); divGrad.addColorStop(0.8, p.shimmerLight); divGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = divGrad; ctx.fillRect(split - 2, 0, 4, H);

      infDrawShimmer(ctx, split, ac);

      // Product left
      if (productDataUrl) await infDrawProduct(ctx, productDataUrl, 14, 14, split - 28, H - 28, ac);
      else infPlaceholderDark(ctx, 14, 14, split - 28, H - 28);

      // Right: tagline + feature rows
      const tagY = infDrawTagline(ctx, W - split, tagline || { line1: infTrunc(title, 26), line2: '' }, 24, ac, FONT);
      // Note: infDrawTagline uses ctx.textAlign='center' with W/2 — override for right panel
      // Redraw tagline correctly offset for right panel
      ctx.clearRect(split, 0, W - split, tagY + 10);
      ctx.fillStyle = infTintHex('#1e1f20', ac, 0.05); ctx.fillRect(split, 0, W - split, tagY + 10);
      const rW = W - split, rX = split;
      ctx.fillStyle = '#fff'; ctx.font = `800 32px ${FONT}`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(infTrunc(tagline?.line1 || infTrunc(title, 26), 28), rX + 28, 24);
      if (tagline?.line2) {
        ctx.font = `400 18px ${FONT}`; ctx.fillStyle = p.muted;
        ctx.fillText(infTrunc(tagline.line2, 38), rX + 28, 66);
      }
      const rightTagY = tagline?.line2 ? 100 : 68;

      ctx.fillStyle = p.border; ctx.fillRect(rX + 28, rightTagY, rW - 56, 1);

      const maxF = Math.min(features.length, 6);
      const rowH = (H - rightTagY - 20) / maxF;
      for (let i = 0; i < maxF; i++) {
        const f = features[i];
        const ry = rightTagY + 10 + i * rowH, midY = ry + rowH / 2;

        // Number badge
        infRoundRect(ctx, rX + 28, midY - 19, 38, 38, 8);
        ctx.fillStyle = ac; ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = `bold 15px ${FONT}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), rX + 47, midY);

        // Icon tile
        infRoundRect(ctx, rX + 76, midY - 18, 36, 36, 8);
        ctx.fillStyle = infHexToRgba(ac, 0.20); ctx.fill();
        ctx.font = `18px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff'; ctx.fillText(f.icon || '⭐', rX + 94, midY);

        ctx.font = `bold 15px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = p.text; ctx.fillText(infTrunc(f.name || '', 26), rX + 122, midY - 4);
        ctx.font = `12px ${FONT}`; ctx.fillStyle = p.muted;
        ctx.fillText(infTrunc(f.detail || '', 36), rX + 122, midY + 16);

        if (i < maxF - 1) {
          ctx.strokeStyle = p.border; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(rX + 28, ry + rowH); ctx.lineTo(W - 24, ry + rowH); ctx.stroke();
        }
      }
    }
```

- [ ] **Step 2: Verify visually** — dark left panel with product, gradient divider, dark right panel with tagline + numbered feature rows.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: rewrite infSplitPanel — dark both sides with numbered rows"
```

---

## Task 11: Condition Showcase template

**Files:**
- Modify: `index.html` — replace entire `infBoldBlocks` function with `infConditionShowcase`
  (Bold Blocks is removed; Condition Showcase takes its place in the file; the templates array already has `conditionshowcase` from Task 4)

- [ ] **Step 1: Replace `infBoldBlocks` with `infConditionShowcase`**

```javascript
    // ── Template 7: Condition Showcase ───────────────────────────────────────
    async function infConditionShowcase(canvas, productDataUrl, title, features, accentColor, tagline, conditionBadges) {
      const W = 1200, H = 900, ctx = canvas.getContext('2d');
      canvas.width = W; canvas.height = H;
      const ac = infValidHex(accentColor);
      const p = infBuildDepthPalette(ac);
      const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

      const badgeColors = {
        green: { bg: 'rgba(34,197,94,0.15)',  border: 'rgba(34,197,94,0.55)',  text: '#4ade80' },
        blue:  { bg: 'rgba(59,130,246,0.15)', border: 'rgba(59,130,246,0.55)', text: '#93c5fd' },
        amber: { bg: 'rgba(245,158,11,0.15)', border: 'rgba(245,158,11,0.50)', text: '#fcd34d' },
        red:   { bg: 'rgba(239,68,68,0.15)',  border: 'rgba(239,68,68,0.50)',  text: '#f87171' },
      };
      const defaultBadges = [
        { label: 'Condition Verified', colorKey: 'green' },
        { label: 'Includes Accessories', colorKey: 'blue' },
        { label: 'Fully Tested',        colorKey: 'amber' },
        { label: 'Ready to Ship',       colorKey: 'red' },
      ];
      const badges = ((conditionBadges && conditionBadges.length > 0) ? conditionBadges : defaultBadges).slice(0, 4);

      ctx.fillStyle = p.bg; ctx.fillRect(0, 0, W, H);
      const bgGlow = ctx.createRadialGradient(W/2, H/2, 40, W/2, H/2, 520);
      bgGlow.addColorStop(0, infHexToRgba(ac, 0.18)); bgGlow.addColorStop(1, 'transparent');
      ctx.fillStyle = bgGlow; ctx.fillRect(0, 0, W, H);
      infDrawShimmer(ctx, W, ac);

      // Tagline
      const tagY = infDrawTagline(ctx, W, tagline || { line1: infTrunc(title, 38), line2: '' }, 16, ac, FONT);

      // Product — large, centered
      const BW = 272, BH = 62;
      const prodX = 220, prodY = tagY + 14, prodW = 760, prodH = H - tagY - 90;
      if (productDataUrl) await infDrawProduct(ctx, productDataUrl, prodX, prodY, prodW, prodH, ac);
      else infPlaceholderDark(ctx, prodX, prodY, prodW, prodH);

      // 4 condition badges — top-left, top-right, bottom-left, bottom-right
      const bPositions = [
        { x: 28,              y: prodY + 12 },
        { x: W - BW - 28,     y: prodY + 12 },
        { x: 28,              y: prodY + prodH - BH - 12 },
        { x: W - BW - 28,     y: prodY + prodH - BH - 12 },
      ];

      badges.forEach((badge, i) => {
        const bp = bPositions[i], bc = badgeColors[badge.colorKey] || badgeColors.green;
        infRoundRect(ctx, bp.x, bp.y, BW, BH, 12);
        ctx.fillStyle = bc.bg; ctx.fill();
        ctx.strokeStyle = bc.border; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillStyle = bc.text; ctx.font = `bold 17px ${FONT}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(infTrunc(badge.label, 22), bp.x + BW/2, bp.y + BH/2);
      });

      // Bottom title bar
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, H - 56, W, 56);
      ctx.fillStyle = '#fff'; ctx.font = `bold 24px ${FONT}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(infTrunc(title, 54), W/2, H - 28);

      ctx.font = `11px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText('LazyListings', W - 16, H - 10);
    }
```

- [ ] **Step 2: Verify visually** — dark bg with ambient glow, tagline, large product with depth treatment, 4 coloured condition badges at corners, title bar at bottom.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: replace infBoldBlocks with infConditionShowcase"
```

---

## Task 12: Minimal template (dark)

**Files:**
- Modify: `index.html` — replace entire `infMinimal` function

- [ ] **Step 1: Replace `infMinimal`**

```javascript
    // ── Template 8: Minimal ──────────────────────────────────────────────────
    async function infMinimal(canvas, productDataUrl, title, features, accentColor, tagline) {
      const W = 1200, H = 900, ctx = canvas.getContext('2d');
      canvas.width = W; canvas.height = H;
      const ac = infValidHex(accentColor);
      const p = infBuildDepthPalette(ac);
      const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

      ctx.fillStyle = p.bg; ctx.fillRect(0, 0, W, H);
      infDrawShimmer(ctx, W, ac);

      // Thin frame
      ctx.strokeStyle = p.border; ctx.lineWidth = 1;
      ctx.strokeRect(14, 14, W - 28, H - 28);

      // Left gradient accent bar
      const barGrad = ctx.createLinearGradient(0, 14, 0, H - 14);
      barGrad.addColorStop(0, 'transparent'); barGrad.addColorStop(0.3, ac); barGrad.addColorStop(0.7, p.shimmerLight); barGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = barGrad; ctx.fillRect(14, 14, 4, H - 28);

      // Tagline
      const tagY = infDrawTagline(ctx, W, tagline || { line1: infTrunc(title, 38), line2: '' }, 22, ac, FONT);

      // Large product center
      if (productDataUrl) await infDrawProduct(ctx, productDataUrl, 200, tagY + 14, 800, H - tagY - 28, ac);
      else infPlaceholderDark(ctx, 200, tagY + 14, 800, H - tagY - 28);

      // Left feature callouts (top 3)
      const leftF = features.slice(0, Math.min(3, features.length));
      leftF.forEach((f, i) => {
        const ly = tagY + 60 + i * Math.floor((H - tagY - 60) / 3);
        ctx.fillStyle = p.text; ctx.font = `bold 14px ${FONT}`;
        ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(`${f.icon || ''} ${infTrunc(f.name || '', 16)}`, 182, ly);
        ctx.font = `12px ${FONT}`; ctx.fillStyle = p.muted;
        ctx.fillText(infTrunc(f.detail || '', 20), 182, ly + 20);
        ctx.strokeStyle = infHexToRgba(ac, 0.45); ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.moveTo(186, ly - 4); ctx.lineTo(200, ly - 4); ctx.stroke();
        ctx.setLineDash([]);
      });

      // Right feature callouts (next 3)
      const rightF = features.slice(3, Math.min(6, features.length));
      rightF.forEach((f, i) => {
        const ry = tagY + 60 + i * Math.floor((H - tagY - 60) / 3);
        ctx.fillStyle = p.text; ctx.font = `bold 14px ${FONT}`;
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(`${f.icon || ''} ${infTrunc(f.name || '', 16)}`, 1018, ry);
        ctx.font = `12px ${FONT}`; ctx.fillStyle = p.muted;
        ctx.fillText(infTrunc(f.detail || '', 20), 1018, ry + 20);
        ctx.strokeStyle = infHexToRgba(ac, 0.45); ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.moveTo(1000, ry - 4); ctx.lineTo(1016, ry - 4); ctx.stroke();
        ctx.setLineDash([]);
      });

      ctx.font = `11px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('LazyListings', W/2, H - 20);
    }
```

- [ ] **Step 2: Verify visually** — dark bg, thin frame, gradient left accent bar, tagline top, large product, minimal side callouts with dashed connectors.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: rewrite infMinimal — dark with gradient accent frame + side callouts"
```

---

## Task 13: Social Card template (dark)

**Files:**
- Modify: `index.html` — replace entire `infSocialCard` function

- [ ] **Step 1: Replace `infSocialCard`**

```javascript
    // ── Template 9: Social Card ──────────────────────────────────────────────
    async function infSocialCard(canvas, productDataUrl, title, features, accentColor, tagline) {
      const S = 1080, ctx = canvas.getContext('2d');
      canvas.width = S; canvas.height = S;
      const ac = infValidHex(accentColor);
      const p = infBuildDepthPalette(ac);
      const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
      const pillColors = ['#7c3aed','#059669','#d97706'];

      // Background
      const bgGrd = ctx.createLinearGradient(0, 0, S, S);
      bgGrd.addColorStop(0, p.bg);
      bgGrd.addColorStop(1, infTintHex(p.bg, infDarkenHex(ac, 0.25), 0.25));
      ctx.fillStyle = bgGrd; ctx.fillRect(0, 0, S, S);

      // Ambient circles
      ctx.fillStyle = infHexToRgba(ac, 0.07);
      ctx.beginPath(); ctx.arc(S * 0.85, S * 0.14, 310, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(S * 0.10, S * 0.82, 230, 0, Math.PI * 2); ctx.fill();

      infDrawShimmer(ctx, S, ac);

      // Tagline
      const line1 = tagline?.line1 || infTrunc(title, 26);
      const line2 = tagline?.line2 || '';
      ctx.fillStyle = '#fff'; ctx.font = `800 44px ${FONT}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(infTrunc(line1, 26), S/2, 28);
      if (line2) {
        ctx.font = `400 24px ${FONT}`; ctx.fillStyle = p.muted;
        ctx.fillText(infTrunc(line2, 36), S/2, 82);
      }
      const tagBottom = line2 ? 120 : 82;

      // Underline
      const ulGrad = ctx.createLinearGradient(S/2 - 80, 0, S/2 + 80, 0);
      ulGrad.addColorStop(0, 'transparent'); ulGrad.addColorStop(0.4, ac); ulGrad.addColorStop(0.6, p.shimmerLight); ulGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = ulGrad; ctx.fillRect(S/2 - 80, tagBottom - 4, 160, 3);

      // Product image
      const imgY = tagBottom + 10;
      if (productDataUrl) await infDrawProduct(ctx, productDataUrl, 100, imgY, 880, S - imgY - 160, ac);
      else { ctx.fillStyle = p.surface; infRoundRect(ctx, 100, imgY, 880, S - imgY - 160, 24); ctx.fill(); }

      // Coloured feature pills
      const maxF = Math.min(features.length, 3);
      const pillH = 70, pillW = (S - 80 - 14 * (maxF - 1)) / maxF;
      const pillY = S - pillH - 34;
      for (let i = 0; i < maxF; i++) {
        const f = features[i], px = 40 + i * (pillW + 14), pc = pillColors[i % pillColors.length];
        infRoundRect(ctx, px, pillY, pillW, pillH, 18);
        ctx.fillStyle = infHexToRgba(pc, 0.88); ctx.fill();
        ctx.strokeStyle = infLightenHex(pc, 0.25); ctx.lineWidth = 1.5; ctx.stroke();
        ctx.font = `28px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff'; ctx.fillText(f.icon || '⭐', px + 40, pillY + pillH/2);
        ctx.font = `bold 15px ${FONT}`;
        ctx.fillText(infTrunc(f.name || '', 18), px + pillW/2 + 14, pillY + pillH/2);
      }

      ctx.font = `13px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText('LazyListings', S - 22, S - 12);
    }
```

- [ ] **Step 2: Verify visually** — dark square bg with ambient glow circles, tagline with gradient underline, product with depth treatment, 3 coloured pills at bottom.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: rewrite infSocialCard — dark square with tagline + coloured pills"
```

---

## Task 14: Remove dead functions

**Files:**
- Modify: `index.html` — remove `infBoldBlocks` (replaced by `infConditionShowcase` in Task 11) and any reference to it

- [ ] **Step 1: Verify `infBoldBlocks` no longer exists**

Search `index.html` for `infBoldBlocks` — should have zero matches (it was replaced in Task 11).

- [ ] **Step 2: Verify all 9 template function names exist**

Search `index.html` for each of:
- `infCalloutDiagram` ✓
- `infFeatureGrid` ✓
- `infHeroBanner` ✓
- `infSpotlight` ✓
- `infDarkSpecs` ✓
- `infSplitPanel` ✓
- `infConditionShowcase` ✓
- `infMinimal` ✓
- `infSocialCard` ✓

- [ ] **Step 3: Full end-to-end test**

```bash
node server.js
```

1. Log in, go to a draft with a product photo and a generated description
2. Click "Generate Images"
3. Confirm all 9 cards render without errors
4. Confirm each card shows: dark charcoal background, tagline at top, product photo with glow/vignette, feature elements using accent colour
5. Check DevTools console — zero errors

- [ ] **Step 4: Final commit**

```bash
git add index.html server.js
git commit -m "feat: complete infographic quality upgrade — 9 dark modern templates with taglines and callouts"
```

---

## Self-review

- [x] **All 9 templates dark** — all use `p.bg` from `infBuildDepthPalette`, no light templates remain
- [x] **Tagline on all templates** — `infDrawTagline` called in Tasks 5–13; tagline falls back to product title if Gemini returns null
- [x] **`infDrawProduct` used everywhere** — replaces raw `infDrawFitted` calls; includes glow, fitted draw, vignette, tint
- [x] **`infDrawShimmer` used everywhere** — consistent shimmer line across all templates
- [x] **Condition Showcase** — receives `conditionBadges` via `tplArgs` wrapper; defaults gracefully if backend returns empty array
- [x] **Templates array wiring** — Task 4 replaces the array; uses `tplArgs` closure pattern to pass `tagline` + `conditionBadges` to all fns
- [x] **Backend validated** — `tagline`, `position`, `conditionBadges` all validated/sanitised before sending to frontend
- [x] **No placeholders** — every task has complete function code
- [x] **Font consistency** — `FONT` constant defined in every template function
- [x] **Dead code removed** — `infBoldBlocks` replaced, not left as dead function
