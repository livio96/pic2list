# Infographic Image Quality Upgrade

**Date:** 2026-04-07
**Status:** Approved (revised)

## Overview

Replace all 9 existing canvas-based infographic templates with a cohesive set of modern, dark, eBay-listing-quality images. Inspired by professional product photography infographics (e.g. Dell product listing style): dark charcoal backgrounds, bold marketing taglines, connector lines from product to labeled feature boxes, accent-colored callout elements.

---

## 1. Visual Design Language (applies to all 9 templates)

| Property | Value |
|----------|-------|
| Background | Dark charcoal: `#272829` tinted toward accent (`infTintHex('#272829', ac, 0.06)`) |
| Font | `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif` |
| Primary text | `#ffffff` |
| Secondary text | `rgba(255,255,255,0.55)` |
| Feature boxes | Accent-colored rounded rects, feature name bold inside |
| Connector lines | Thin white (`rgba(255,255,255,0.45)`) right-angle elbow lines with accent dot at product end |
| Top shimmer | 3px `linear-gradient(90deg, accent, lighten(accent,30%), transparent)` |
| Product treatment | Glow behind → fitted image → radial vignette to bg → 8% accent tint |

---

## 2. New AI Output Fields (server.js `/api/generate-images`)

Extend the Gemini prompt to return two additional fields alongside the existing `features`, `accentColor`, and `conditionBadges`:

### `tagline`
A short punchy marketing headline, split into two lines:
```json
{
  "tagline": {
    "line1": "10 Ports. Zero Compromises.",
    "line2": "The ultimate universal hub."
  }
}
```
- `line1`: Bold headline, ≤ 40 chars, punchy/marketing style
- `line2`: Descriptive subtitle, ≤ 55 chars

### `position` per feature
Each feature in the `features` array gains a `position` field used by the Callout Diagram template:
```json
{ "name": "Noise Cancel", "detail": "Industry-leading ANC", "icon": "🔇", "position": "top-left" }
```
Valid values: `top-left`, `top-right`, `bottom-left`, `bottom-right`, `left`, `right`
Gemini distributes up to 6 features across the 6 positions, choosing the most visually balanced arrangement.

### `conditionBadges`
Unchanged from original spec — 4 items with `label` and `colorKey` (`green`, `blue`, `amber`, `red`).

---

## 3. New Helper Functions

### New helpers to add
| Function | Purpose |
|----------|---------|
| `infLightenHex(hex, amount)` | Inverse of `infDarkenHex` — lightens a hex color |
| `infTintHex(base, accent, ratio)` | Blends base color toward accent at given ratio |
| `infBuildDepthPalette(accentHex)` | Returns `{ bg, surface, border, glow, shimmer, shimmerLight, text, muted }` |
| `infDrawProduct(ctx, src, x, y, w, h, accentColor)` | Glow → fitted image → radial vignette → accent tint |
| `infDrawTagline(ctx, W, tagline, startY, ac, FONT)` | Draws `line1` (bold large) + `line2` (regular smaller), returns total height used |
| `infDrawShimmer(ctx, W, ac)` | Draws the 3px shimmer line at y=0 |

### `infBuildDepthPalette` tokens
| Token | Value |
|-------|-------|
| `bg` | `infTintHex('#272829', ac, 0.06)` |
| `surface` | `rgba(ac, 0.08)` |
| `border` | `rgba(ac, 0.25)` |
| `glow` | `rgba(ac, 0.28)` |
| `shimmer` | `ac` |
| `shimmerLight` | `infLightenHex(ac, 0.30)` |
| `text` | `'#ffffff'` |
| `muted` | `'rgba(255,255,255,0.55)'` |

---

## 4. The 9 Templates

All templates: 1200×900px except Social Card (1080×1080).

| # | ID | Label | Layout |
|---|-----|-------|--------|
| 1 | `callout` | Callout Diagram | Tagline top, product center, connector lines to 6 feature boxes around perimeter |
| 2 | `featgrid` | Feature Grid | Tagline top, product below center-top, dark 2×3 feature card grid |
| 3 | `herobanner` | Hero Banner | Full-bleed product, dark gradients, tagline top, coloured feature pills bottom |
| 4 | `spotlight` | Spotlight | Tagline top, large product left, feature boxes right with connector dots |
| 5 | `darkspecs` | Dark Specs | Tagline top, product center, spec cards row below |
| 6 | `splitpanel` | Split Panel | Product dark left panel, feature list dark right panel, tagline on right |
| 7 | `conditionshowcase` | Condition Showcase | Tagline top, product center, 4 coloured condition badges around product |
| 8 | `minimal` | Minimal | Tagline top, large product center, minimal callout annotations on sides |
| 9 | `socialcard` | Social Card | 1:1 square, tagline + product + coloured feature pills |

---

## 5. Callout Diagram — Detail

This is the primary template, closest to the reference image.

**Product area:** `x=220, y=tagH+20, w=760, h=H-tagH-50`

**6 box positions** (fixed, independent of product content):
| Key | Box x | Box y |
|-----|-------|-------|
| `top-left` | 14 | tagH + 30 |
| `top-right` | W − boxW − 14 | tagH + 30 |
| `left` | 14 | tagH + prodH/2 − boxH/2 |
| `right` | W − boxW − 14 | tagH + prodH/2 − boxH/2 |
| `bottom-left` | 14 | H − boxH − 30 |
| `bottom-right` | W − boxW − 14 | H − boxH − 30 |

Box size: `190 × 76px`, radius 10px, accent-color fill.

**Connector line algorithm:**
1. Determine which side the box is on (left of center or right)
2. `connProdX` = left edge or right edge of product bounding box
3. `connProdY` = `by + BOX_H/2` (mid-height of the box)
4. Draw: box edge → horizontal to midpoint → vertical to `connProdY` → horizontal to `connProdX`
5. Accent-colored dot (r=4) at `connProdX, connProdY`

Gemini assigns positions; if a feature has no valid position or a position is reused, fall back to `defaultPositions[i]` (`top-left`, `top-right`, `bottom-left`, `bottom-right`, `left`, `right` in order).

---

## 6. Template Function Signature

All 9 templates share the same signature:
```javascript
async function inf<Name>(canvas, productDataUrl, title, features, accentColor, tagline, conditionBadges)
```
`tagline` and `conditionBadges` are used only by the templates that need them; others ignore them.

---

## 7. `generateImages` wiring

```javascript
const { features, accentColor, conditionBadges, tagline } = data;
// tagline = { line1, line2 } or undefined
// Each template fn is a closure: (c, img, t, f, ac) => inf*(c, img, t, f, ac, tagline, conditionBadges)
```

---

## 8. Files Changed

| File | Change |
|------|--------|
| `index.html` | Add 6 helper functions; replace all 9 template functions; update `generateImages` to destructure `tagline` and `conditionBadges` and pass to templates |
| `server.js` | Extend Gemini prompt for `tagline`, `position` per feature, `conditionBadges`; parse + validate all three |
