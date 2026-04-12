// ── Shared Generate Images functionality ──

function genImgDataUrlToBlob(dataUrl) {
  const [header, data] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)[1];
  const binary = atob(data);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/**
 * Generate infographic images for a listing.
 * @param {Object} opts
 * @param {string} opts.title - Product title
 * @param {string} opts.description - HTML description
 * @param {string[]} opts.imageUrls - Existing image URLs
 * @param {Function} opts.onAdd - Called with { dataUrl, filename } when user clicks Add to Listing
 * @param {HTMLElement} [opts.triggerBtn] - Button that triggered this (for loading state)
 */
async function generateImagesOverlay(opts) {
  const { title, description, imageUrls, onAdd, triggerBtn } = opts;

  const overlay = document.getElementById('genImgOverlay');
  const container = document.getElementById('genImgCanvases');

  if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = 'Analyzing...'; }
  container.innerHTML = '<div class="gen-img-loading" style="grid-column:1/-1"><span class="spinner"></span> Analyzing product features...</div>';
  overlay.classList.add('open');

  try {
    // Convert image URLs to base64
    const imageBase64List = [];
    for (const url of imageUrls.slice(0, 4)) {
      try {
        const resp = await fetch(url);
        const blob = await resp.blob();
        const b64 = await new Promise(resolve => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(blob);
        });
        imageBase64List.push(b64);
      } catch { /* skip failed images */ }
    }

    const resp = await fetch('/api/generate-images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: imageBase64List, title, description: (description || '').replace(/<[^>]*>/g, ' ').substring(0, 2000) }),
    });
    const data = await resp.json();
    if (!data.success) throw new Error(data.error || 'Feature extraction failed');

    const { features, featureGroups, accentColor, conditionBadges } = data;

    // Build image pool from URLs (as data URLs for canvas)
    let imagePool = [];
    for (const url of imageUrls.slice(0, 6)) {
      try {
        const r = await fetch(url);
        const blob = await r.blob();
        const dataUrl = await new Promise(resolve => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
        imagePool.push(dataUrl);
      } catch { /* skip */ }
    }

    if (imagePool.length === 0) imagePool = [null];

    // Supplement with web images if pool is small
    if (imagePool.length < 4 && imageBase64List.length > 0) {
      try {
        const imgResp = await fetch('/api/find-product-images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64: imageBase64List[0] }),
        });
        const imgData = await imgResp.json();
        if (imgData.success && imgData.images?.length) {
          imagePool = [...imagePool, ...imgData.images];
        }
      } catch { /* use existing images only */ }
    }

    container.innerHTML = '';

    const groups = (featureGroups?.length >= 3)
      ? featureGroups.map(g => g.features)
      : [features, features, features];
    const emptyTagline = { line1: '', line2: '' };
    const mkTpl = (fn, grpIdx) => (c, img, t, _f, ac) =>
      fn(c, img, t, groups[grpIdx % groups.length], ac, emptyTagline, conditionBadges);

    const templates = [
      { id: 'callout',           label: 'Callout Diagram',    fn: mkTpl(infCalloutDiagram, 0) },
      { id: 'featgrid',          label: 'Feature Grid',       fn: mkTpl(infFeatureGrid, 0) },
      { id: 'darkspecs',         label: 'Dark Specs',         fn: mkTpl(infDarkSpecs, 0) },
      { id: 'herobanner',        label: 'Hero Banner',        fn: mkTpl(infHeroBanner, 1) },
      { id: 'spotlight',         label: 'Spotlight',          fn: mkTpl(infSpotlight, 1) },
      { id: 'splitpanel',        label: 'Split Panel',        fn: mkTpl(infSplitPanel, 1) },
      { id: 'conditionshowcase', label: 'Condition Showcase',  fn: mkTpl(infConditionShowcase, 2) },
      { id: 'minimal',           label: 'Minimal',            fn: mkTpl(infMinimal, 2) },
      { id: 'socialcard',        label: 'Social Card',        fn: mkTpl(infSocialCard, 2) },
    ];

    for (const tpl of templates) {
      const wrapper = document.createElement('div');
      wrapper.className = 'gen-img-card';

      const label = document.createElement('div');
      label.className = 'gen-img-label';
      label.textContent = tpl.label;

      const canvasWrap = document.createElement('div');
      canvasWrap.className = 'gen-img-canvas-wrap';
      const zoomHint = document.createElement('div');
      zoomHint.className = 'gen-img-zoom-hint';
      zoomHint.textContent = '\uD83D\uDD0D';
      canvasWrap.addEventListener('click', () => {
        document.getElementById('infLightboxImg').src = canvas.toDataURL('image/png');
        document.getElementById('infLightbox').classList.add('open');
      });

      const canvas = document.createElement('canvas');
      canvas.className = 'gen-img-canvas';
      canvasWrap.appendChild(canvas);
      canvasWrap.appendChild(zoomHint);

      const btnRow = document.createElement('div');
      btnRow.className = 'gen-img-btn-row';

      const filename = `${title.substring(0, 30).replace(/[^a-z0-9]/gi, '-')}-${tpl.id}.png`;

      const dlBtn = document.createElement('button');
      dlBtn.className = 'btn btn-secondary btn-sm';
      dlBtn.textContent = 'Download';
      dlBtn.addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = filename;
        a.click();
      });

      const addBtn = document.createElement('button');
      addBtn.className = 'btn btn-primary btn-sm';
      addBtn.textContent = '+ Add to Listing';
      addBtn.addEventListener('click', async () => {
        addBtn.disabled = true;
        addBtn.textContent = 'Uploading...';
        try {
          const dataUrl = canvas.toDataURL('image/png');
          await onAdd({ dataUrl, filename });
          addBtn.textContent = '\u2713 Added';
          addBtn.style.background = '#22c55e';
        } catch (err) {
          addBtn.textContent = 'Failed';
          addBtn.style.background = '#ef4444';
          setTimeout(() => { addBtn.disabled = false; addBtn.textContent = '+ Add to Listing'; addBtn.style.background = ''; }, 2000);
        }
      });

      btnRow.appendChild(dlBtn);
      btnRow.appendChild(addBtn);
      wrapper.appendChild(label);
      wrapper.appendChild(canvasWrap);
      wrapper.appendChild(btnRow);
      container.appendChild(wrapper);

      const tplImg = imagePool[templates.indexOf(tpl) % imagePool.length];
      await tpl.fn(canvas, tplImg, title, features, accentColor);
    }
  } catch (err) {
    container.innerHTML = '<div class="gen-img-error" style="grid-column:1/-1">Error: ' + (err.message || err) + '</div>';
  }

  if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = 'Generate Images'; }
}

// ── Canvas templates ────────────────────────────────────────────────────────

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
    const connBoxX  = isLeft ? bx + BOX_W : bx;
    const connProdX = prodX + Math.max(0.05, Math.min(0.95, f.hx ?? (isLeft ? 0.15 : 0.85))) * prodW;
    const connProdY = prodY + Math.max(0.05, Math.min(0.95, f.hy ?? 0.5)) * prodH;
    const boxMidY   = by + BOX_H / 2;

    // Right-angle elbow connector line
    ctx.strokeStyle = 'rgba(0,0,0,0.30)'; ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(connBoxX, boxMidY);
    const midX = connBoxX + (connProdX - connBoxX) * 0.55;
    ctx.lineTo(midX, boxMidY);      // horizontal from box
    ctx.lineTo(midX, connProdY);    // vertical elbow
    ctx.lineTo(connProdX, connProdY); // horizontal to hotspot
    ctx.stroke();

    // Accent dot at product hotspot
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

  ctx.font = `11px ${FONT}`; ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  ctx.fillText('LazyListings', W - 16, H - 10);
}

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

  ctx.font = `11px ${FONT}`; ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  ctx.fillText('LazyListings', W - 16, H - 10);
}

// ── Template 5: Dark Specs ───────────────────────────────────────────────
async function infDarkSpecs(canvas, productDataUrl, title, features, accentColor, tagline) {
  const W = 1200, H = 900, ctx = canvas.getContext('2d');
  canvas.width = W; canvas.height = H;
  const ac = infValidHex(accentColor);
  const p = infBuildDepthPalette(ac);
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

  ctx.fillStyle = p.bg; ctx.fillRect(0, 0, W, H);
  const bgGlow = ctx.createRadialGradient(W/2, 360, 30, W/2, 360, 420);
  bgGlow.addColorStop(0, infHexToRgba(ac, 0.09)); bgGlow.addColorStop(1, 'transparent');
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

  ctx.font = `11px ${FONT}`; ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText('LazyListings', W/2, H - 10);
}

// ── Template 3: Feature Grid ──────────────────────────────────────────────
// White bg, product top-center, 2-row icon grid below
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

  ctx.font = `11px ${FONT}`; ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  ctx.fillText('LazyListings', W - 16, H - 10);
}

// ── Template 4: Hero Banner ───────────────────────────────────────────────
// Product image full area, dark gradient overlay, feature pills at bottom
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

  // Light gradient overlays for pill readability
  const topGrad = ctx.createLinearGradient(0, 0, 0, 180);
  topGrad.addColorStop(0, 'rgba(255,255,255,0.70)'); topGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = topGrad; ctx.fillRect(0, 0, W, 180);
  const botGrad = ctx.createLinearGradient(0, H - 260, 0, H);
  botGrad.addColorStop(0, 'transparent'); botGrad.addColorStop(1, 'rgba(255,255,255,0.88)');
  ctx.fillStyle = botGrad; ctx.fillRect(0, H - 260, W, 260);

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

  ctx.font = `11px ${FONT}`; ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  ctx.fillText('LazyListings', W - 18, H - 10);
}

// ── Template 5: Split Panel ───────────────────────────────────────────────
// Dark left panel with product, white right panel with numbered feature list
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

  // Right panel slightly tinted
  ctx.fillStyle = infTintHex('#f4f4f6', ac, 0.05); ctx.fillRect(split, 0, W - split, H);

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
  ctx.fillStyle = infTintHex('#f4f4f6', ac, 0.05); ctx.fillRect(split, 0, W - split, tagY + 10);
  const rW = W - split, rX = split;
  ctx.fillStyle = p.text; ctx.font = `800 32px ${FONT}`;
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

// ── Template 6: Bold Blocks ───────────────────────────────────────────────
// White, product top half, colorful feature blocks in row below
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
  bgGlow.addColorStop(0, infHexToRgba(ac, 0.09)); bgGlow.addColorStop(1, 'transparent');
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
  ctx.fillStyle = 'rgba(255,255,255,0.88)'; ctx.fillRect(0, H - 56, W, 56);
  ctx.fillStyle = p.text; ctx.font = `bold 24px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(infTrunc(title, 54), W/2, H - 28);

  ctx.font = `11px ${FONT}`; ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  ctx.fillText('LazyListings', W - 16, H - 10);
}

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

  ctx.font = `11px ${FONT}`; ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText('LazyListings', W/2, H - 20);
}

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

  ctx.font = `13px ${FONT}`; ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  ctx.fillText('LazyListings', S - 22, S - 12);
}

// ── Canvas helpers ──────────────────────────────────────────────────────────

function infValidHex(hex) {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : '#4f6ef7';
}

function infRoundRect(ctx, x, y, w, h, r, tl, tr, br, bl) {
  const _tl = tl ?? r, _tr = tr ?? r, _br = br ?? r, _bl = bl ?? r;
  ctx.beginPath();
  ctx.moveTo(x + _tl, y);
  ctx.lineTo(x + w - _tr, y); ctx.arcTo(x + w, y, x + w, y + _tr, _tr);
  ctx.lineTo(x + w, y + h - _br); ctx.arcTo(x + w, y + h, x + w - _br, y + h, _br);
  ctx.lineTo(x + _bl, y + h); ctx.arcTo(x, y + h, x, y + h - _bl, _bl);
  ctx.lineTo(x, y + _tl); ctx.arcTo(x, y, x + _tl, y, _tl);
  ctx.closePath();
}

function infTrunc(str, max) {
  if (!str) return '';
  return str.length > max ? str.substring(0, max - 1) + '…' : str;
}

function infHexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.substring(0,2),16)},${parseInt(h.substring(2,4),16)},${parseInt(h.substring(4,6),16)},${alpha})`;
}

function infDarkenHex(hex, amount) {
  const h = hex.replace('#', '');
  const r = Math.max(0, Math.round(parseInt(h.substring(0,2),16) * (1 - amount)));
  const g = Math.max(0, Math.round(parseInt(h.substring(2,4),16) * (1 - amount)));
  const b = Math.max(0, Math.round(parseInt(h.substring(4,6),16) * (1 - amount)));
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

function infLightenHex(hex, amount) {
  const h = hex.replace('#', '');
  const r = Math.max(0, Math.min(255, Math.round(parseInt(h.substring(0,2),16) + (255 - parseInt(h.substring(0,2),16)) * amount)));
  const g = Math.max(0, Math.min(255, Math.round(parseInt(h.substring(2,4),16) + (255 - parseInt(h.substring(2,4),16)) * amount)));
  const b = Math.max(0, Math.min(255, Math.round(parseInt(h.substring(4,6),16) + (255 - parseInt(h.substring(4,6),16)) * amount)));
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

function infTintHex(base, accent, ratio) {
  const bh = base.replace('#', ''), ah = accent.replace('#', '');
  const br = parseInt(bh.substring(0,2),16), bg2 = parseInt(bh.substring(2,4),16), bb = parseInt(bh.substring(4,6),16);
  const ar = parseInt(ah.substring(0,2),16), ag = parseInt(ah.substring(2,4),16), ab = parseInt(ah.substring(4,6),16);
  const r = Math.max(0, Math.min(255, Math.round(br + (ar - br) * ratio)));
  const g = Math.max(0, Math.min(255, Math.round(bg2 + (ag - bg2) * ratio)));
  const b = Math.max(0, Math.min(255, Math.round(bb + (ab - bb) * ratio)));
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

function infBuildDepthPalette(accentHex) {
  const ac = infValidHex(accentHex);
  return {
    bg:           infTintHex('#ffffff', ac, 0.04),
    surface:      infHexToRgba(ac, 0.07),
    border:       infHexToRgba(ac, 0.18),
    glow:         infHexToRgba(ac, 0.12),
    shimmer:      ac,
    shimmerLight: infLightenHex(ac, 0.30),
    text:         '#111111',
    muted:        'rgba(0,0,0,0.42)',
  };
}

async function infDrawProduct(ctx, src, x, y, w, h, accentColor) {
  const ac = infValidHex(accentColor);
  // 1. Radial glow behind product
  const glow = ctx.createRadialGradient(x + w/2, y + h/2, 0, x + w/2, y + h/2, Math.max(w, h) * 0.65);
  glow.addColorStop(0, infHexToRgba(ac, 0.12));
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
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, dx, dy, dw, dh);
      resolve();
    };
    img.onerror = resolve;
    img.src = src;
  });
  // 3. Radial vignette (edges fade to white)
  const vig = ctx.createRadialGradient(x + w/2, y + h/2, Math.min(w, h) * 0.30, x + w/2, y + h/2, Math.max(w, h) * 0.78);
  vig.addColorStop(0, 'transparent');
  vig.addColorStop(1, 'rgba(255,255,255,0.72)');
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

function infBuildPalette(baseHex, count) {
  // Generate palette variations from accent color
  const h = baseHex.replace('#', '');
  const r = parseInt(h.substring(0,2),16);
  const g = parseInt(h.substring(2,4),16);
  const b = parseInt(h.substring(4,6),16);
  const shifts = [0, -40, 40, -80, 80];
  return Array.from({ length: count }, (_, i) => {
    const s = shifts[i] || 0;
    const nr = Math.min(255, Math.max(0, r + s));
    const ng = Math.min(255, Math.max(0, g + Math.round(s * 0.6)));
    const nb = Math.min(255, Math.max(0, b - Math.round(s * 0.3)));
    return `#${nr.toString(16).padStart(2,'0')}${ng.toString(16).padStart(2,'0')}${nb.toString(16).padStart(2,'0')}`;
  });
}

function infLoadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function infDrawFitted(ctx, src, x, y, w, h) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const aspect = img.width / img.height, boxAspect = w / h;
      let dw, dh, dx, dy;
      if (aspect > boxAspect) { dw = w; dh = w / aspect; dx = x; dy = y + (h - dh) / 2; }
      else { dh = h; dw = h * aspect; dy = y; dx = x + (w - dw) / 2; }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, dx, dy, dw, dh);
      resolve();
    };
    img.onerror = resolve;
    img.src = src;
  });
}

function infPlaceholder(ctx, x, y, w, h) {
  ctx.fillStyle = '#e9ecef'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#8b8fa3'; ctx.font = '16px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('Product Image', x + w/2, y + h/2);
}

function infPlaceholderDark(ctx, x, y, w, h) {
  ctx.fillStyle = '#1f2937'; infRoundRect(ctx, x, y, w, h, 12); ctx.fill();
  ctx.fillStyle = '#4b5563'; ctx.font = '16px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('Product Image', x + w/2, y + h/2);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
