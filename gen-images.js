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

    const { features, featureGroups, accentColor, conditionBadges, headline } = data;

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
    const mkTpl = (fn, grpIdx) => (c, img, t, _f, ac) =>
      fn(c, img, t, groups[grpIdx % groups.length], ac, headline || '', conditionBadges);

    const templates = [
      { id: 'cleanshot',         label: 'Clean Product Shot',      fn: mkTpl(infCleanShot, 0) },
      { id: 'valueprop',         label: 'Value Proposition',       fn: mkTpl(infValueProp, 1) },
      { id: 'featurecallout',    label: 'Feature Highlight',       fn: mkTpl(infFeatureCallout, 0) },
      { id: 'specslist',         label: 'Key Specifications',      fn: mkTpl(infSpecsList, 0) },
      { id: 'comparison',        label: 'Comparison Table',        fn: mkTpl(infComparison, 0) },
      { id: 'whatsincluded',     label: "What's Included",         fn: mkTpl(infWhatsIncluded, 2) },
      { id: 'splitfeatures',     label: 'Split Features',          fn: mkTpl(infSplitFeatures, 1) },
      { id: 'conditionshowcase', label: 'Condition Showcase',      fn: mkTpl(infConditionShowcase, 2) },
      { id: 'bulletpoints',      label: 'Bullet Points',           fn: mkTpl(infBulletPoints, 2) },
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

// ── Constants ────────────────────────────────────────────────────────────────
const S = 2400; // Square canvas size — high-res for eBay
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const DARK = '#1a2332';
const MUTED = '#5a6577';

// ── Template 1: Clean Product Shot ────────────────────────────────────────
async function infCleanShot(canvas, productDataUrl, title) {
  const ctx = canvas.getContext('2d');
  canvas.width = S; canvas.height = S;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, S, S);
  if (productDataUrl) {
    await infDrawProductClean(ctx, productDataUrl, 100, 100, S - 200, S - 200);
  }
}

// ── Template 2: Value Proposition ─────────────────────────────────────────
async function infValueProp(canvas, productDataUrl, title, features, accentColor, headline) {
  const ctx = canvas.getContext('2d');
  canvas.width = S; canvas.height = S;
  ctx.fillStyle = '#f5f5f7'; ctx.fillRect(0, 0, S, S);

  const headText = headline || title;
  ctx.fillStyle = DARK; ctx.font = `800 110px ${FONT}`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const headLines = _wrapText(ctx, headText, S - 240);
  let hy = 90;
  for (const line of headLines.slice(0, 3)) {
    ctx.fillText(line, 120, hy);
    hy += 130;
  }

  // Product image
  const prodTop = hy + 30, prodH = S - hy - 460;
  if (productDataUrl) {
    await infDrawProductClean(ctx, productDataUrl, 180, prodTop, S - 360, prodH);
  }

  // Bullet points at bottom
  const bulletY = S - 380;
  const maxBullets = Math.min(features.length, 3);
  for (let i = 0; i < maxBullets; i++) {
    const f = features[i];
    const by = bulletY + i * 100;
    ctx.fillStyle = MUTED; ctx.font = `400 52px ${FONT}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const text = f.detail || f.name || '';
    ctx.fillText(`-  ${text}`, 120, by);
  }
}

// ── Template 3: Feature Callout / Highlight ──────────────────────────────
// Uses AI hx/hy to place labels pointing at actual product features
async function infFeatureCallout(canvas, productDataUrl, title, features, accentColor, headline) {
  const ctx = canvas.getContext('2d');
  canvas.width = S; canvas.height = S;
  const ac = infValidHex(accentColor);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, S, S);

  // Headline
  const headText = headline || title;
  ctx.fillStyle = DARK; ctx.font = `700 84px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const headLines = _wrapText(ctx, headText, S - 300);
  let hy = 70;
  for (const line of headLines.slice(0, 2)) {
    ctx.fillText(line, S / 2, hy);
    hy += 100;
  }

  // Product area
  const prodX = 240, prodY = hy + 20, prodW = S - 480, prodH = S - hy - 220;
  if (productDataUrl) {
    await infDrawProductClean(ctx, productDataUrl, prodX, prodY, prodW, prodH);
  }

  // Use hx/hy from AI to place labels — max 2 clear annotations
  const annotations = features.slice(0, 2);
  const labelColors = [ac, '#22c55e'];

  for (let i = 0; i < annotations.length; i++) {
    const f = annotations[i];
    const bc = labelColors[i];
    // Product hotspot from AI
    const hx = Math.max(0.1, Math.min(0.9, f.hx ?? 0.5));
    const hy2 = Math.max(0.1, Math.min(0.9, f.hy ?? 0.5));
    const dotX = prodX + hx * prodW;
    const dotY = prodY + hy2 * prodH;

    // Label position — left side or right side based on hx
    const isLeft = hx < 0.5;
    const labelX = isLeft ? 80 : S - 80;
    const labelAlign = isLeft ? 'left' : 'right';
    const labelY = prodY + 80 + i * (prodH * 0.5);

    // Line from label to hotspot
    ctx.strokeStyle = bc; ctx.lineWidth = 3; ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(isLeft ? labelX + 20 : labelX - 20, labelY + 30);
    ctx.lineTo(dotX, dotY);
    ctx.stroke();

    // Dot on product
    ctx.fillStyle = bc;
    ctx.beginPath(); ctx.arc(dotX, dotY, 10, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(dotX, dotY, 5, 0, Math.PI * 2); ctx.fill();

    // Label text
    ctx.fillStyle = DARK; ctx.font = `700 48px ${FONT}`;
    ctx.textAlign = labelAlign; ctx.textBaseline = 'bottom';
    ctx.fillText(f.name || '', labelX, labelY);
    ctx.fillStyle = MUTED; ctx.font = `400 38px ${FONT}`;
    ctx.textBaseline = 'top';
    const detailLines = _wrapText(ctx, f.detail || '', isLeft ? prodX - 100 : S - prodX - prodW - 100);
    for (let j = 0; j < Math.min(detailLines.length, 2); j++) {
      ctx.fillText(detailLines[j], labelX, labelY + 8 + j * 46);
    }
  }

  // Bottom banner
  const bannerY = S - 140;
  ctx.fillStyle = ac;
  _roundRect(ctx, 120, bannerY, S - 240, 100, 20);
  ctx.fill();
  ctx.fillStyle = '#ffffff'; ctx.font = `700 44px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const bannerText = features.length > 2 ? (features[2].detail || features[2].name || '') : '';
  ctx.fillText(bannerText.toUpperCase(), S / 2, bannerY + 50);
}

// ── Template 4: Key Specifications ───────────────────────────────────────
async function infSpecsList(canvas, productDataUrl, title, features, accentColor) {
  const ctx = canvas.getContext('2d');
  canvas.width = S; canvas.height = S;
  const ac = infValidHex(accentColor);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, S, S);

  // Title on right — wrapped
  const specX = S * 0.48;
  const specW = S * 0.48;
  ctx.fillStyle = DARK; ctx.font = `700 66px ${FONT}`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const titleLines = _wrapText(ctx, title, specW);
  let ty = 80;
  for (const line of titleLines.slice(0, 3)) {
    ctx.fillText(line, specX, ty);
    ty += 78;
  }
  ctx.fillStyle = ac; ctx.fillRect(specX, ty + 6, 120, 6);

  // Product on left
  if (productDataUrl) {
    await infDrawProductClean(ctx, productDataUrl, 40, 80, S * 0.44, S - 160);
  }

  // Specs
  const maxF = Math.min(features.length, 6);
  const specStartY = ty + 40;
  const rowH = Math.min(220, (S - specStartY - 60) / maxF);

  for (let i = 0; i < maxF; i++) {
    const f = features[i];
    const ry = specStartY + i * rowH;

    ctx.fillStyle = DARK; ctx.font = `700 44px ${FONT}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(f.name || '', specX, ry + 14);

    ctx.fillStyle = MUTED; ctx.font = `400 38px ${FONT}`;
    const detailLines = _wrapText(ctx, f.detail || '', specW);
    for (let j = 0; j < Math.min(detailLines.length, 2); j++) {
      ctx.fillText(detailLines[j], specX, ry + 68 + j * 46);
    }

    if (i < maxF - 1) {
      ctx.fillStyle = '#e5e7eb'; ctx.fillRect(specX, ry + rowH - 2, specW, 2);
    }
  }
}

// ── Template 5: Comparison Table ─────────────────────────────────────────
async function infComparison(canvas, productDataUrl, title, features, accentColor) {
  const ctx = canvas.getContext('2d');
  canvas.width = S; canvas.height = S;
  const ac = infValidHex(accentColor);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, S, S);

  // Title — wrapped
  ctx.fillStyle = DARK; ctx.font = `700 66px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const titleLines = _wrapText(ctx, title, S - 300);
  let ty = 70;
  for (const line of titleLines.slice(0, 2)) {
    ctx.fillText(line, S / 2, ty);
    ty += 80;
  }

  // Table
  const tableX = 120, tableY = ty + 30;
  const tableW = S - 240, rowH = 170;
  const col1W = tableW * 0.36, col2W = tableW * 0.64;
  const maxRows = Math.min(features.length, 6);
  const tableH = (maxRows + 1) * rowH;

  // Header
  ctx.fillStyle = '#f8f9fa'; ctx.fillRect(tableX, tableY, tableW, rowH);
  ctx.fillStyle = '#e5e7eb'; ctx.fillRect(tableX, tableY + rowH - 2, tableW, 3);

  ctx.fillStyle = MUTED; ctx.font = `600 42px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('Feature', tableX + col1W / 2, tableY + rowH / 2);
  ctx.fillStyle = ac; ctx.font = `700 42px ${FONT}`;
  ctx.fillText('Specification', tableX + col1W + col2W / 2, tableY + rowH / 2);

  ctx.fillStyle = '#e5e7eb'; ctx.fillRect(tableX + col1W - 1, tableY, 3, tableH);

  for (let i = 0; i < maxRows; i++) {
    const f = features[i];
    const ry = tableY + (i + 1) * rowH;
    if (i % 2 === 0) { ctx.fillStyle = '#fafbfc'; ctx.fillRect(tableX, ry, tableW, rowH); }
    ctx.fillStyle = '#e5e7eb'; ctx.fillRect(tableX, ry + rowH - 2, tableW, 2);

    ctx.fillStyle = DARK; ctx.font = `500 42px ${FONT}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(f.name || '', tableX + 36, ry + rowH / 2);

    ctx.fillStyle = MUTED; ctx.font = `400 38px ${FONT}`;
    ctx.textAlign = 'left';
    const detailLines = _wrapText(ctx, f.detail || '', col2W - 60);
    const dlStartY = ry + rowH / 2 - (detailLines.length - 1) * 24;
    for (let j = 0; j < Math.min(detailLines.length, 2); j++) {
      ctx.fillText(detailLines[j], tableX + col1W + 30, dlStartY + j * 48);
    }
  }

  ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 3;
  ctx.strokeRect(tableX, tableY, tableW, tableH);
}

// ── Template 6: What's Included ──────────────────────────────────────────
async function infWhatsIncluded(canvas, productDataUrl, title, features, accentColor) {
  const ctx = canvas.getContext('2d');
  canvas.width = S; canvas.height = S;
  ctx.fillStyle = '#f5f5f7'; ctx.fillRect(0, 0, S, S);

  ctx.fillStyle = DARK; ctx.font = `700 96px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('Everything you need.', S / 2, 70);

  // Product name
  ctx.fillStyle = MUTED; ctx.font = `400 40px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const titleLines = _wrapText(ctx, title, S - 500);
  for (let i = 0; i < Math.min(titleLines.length, 2); i++) {
    ctx.fillText(titleLines[i], S / 2, 190 + i * 50);
  }

  // Product centered
  if (productDataUrl) {
    await infDrawProductClean(ctx, productDataUrl, 280, 310, S - 560, S - 820);
  }

  // Bottom: included items — 2x2 grid
  const itemY = S - 440;
  const maxItems = Math.min(features.length, 4);
  const colW = (S - 240) / 2;

  for (let i = 0; i < maxItems; i++) {
    const f = features[i];
    const col = i % 2, row = Math.floor(i / 2);
    const ix = 120 + col * colW, iy = itemY + row * 150;

    ctx.fillStyle = '#22c55e'; ctx.font = `700 46px ${FONT}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('✓', ix, iy);

    ctx.fillStyle = DARK; ctx.font = `600 40px ${FONT}`;
    ctx.fillText(f.name || '', ix + 60, iy);
    ctx.fillStyle = MUTED; ctx.font = `400 34px ${FONT}`;
    const detailLines = _wrapText(ctx, f.detail || '', colW - 80);
    ctx.fillText(detailLines[0] || '', ix + 60, iy + 52);
  }

  ctx.fillStyle = MUTED; ctx.font = `italic 36px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText('See listing for complete details', S / 2, S - 40);
}

// ── Template 7: Split Features ───────────────────────────────────────────
async function infSplitFeatures(canvas, productDataUrl, title, features, accentColor) {
  const ctx = canvas.getContext('2d');
  canvas.width = S; canvas.height = S;
  const ac = infValidHex(accentColor);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, S, S);

  const split = S * 0.44;
  if (productDataUrl) {
    await infDrawProductClean(ctx, productDataUrl, 40, 40, split - 60, S - 80);
  }

  ctx.fillStyle = ac; ctx.fillRect(split, 70, 5, S - 140);

  const rx = split + 60;
  const maxTextW = S - rx - 70;
  ctx.fillStyle = DARK; ctx.font = `800 60px ${FONT}`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const titleLines = _wrapText(ctx, title, maxTextW);
  let ty = 70;
  for (const line of titleLines.slice(0, 3)) {
    ctx.fillText(line, rx, ty);
    ty += 72;
  }
  ctx.fillStyle = ac; ctx.fillRect(rx, ty + 10, 120, 5);

  const maxF = Math.min(features.length, 6);
  const featureStartY = ty + 50;
  const rowH = Math.min(210, (S - featureStartY - 40) / maxF);

  for (let i = 0; i < maxF; i++) {
    const f = features[i];
    const fy = featureStartY + i * rowH;

    ctx.fillStyle = ac;
    ctx.beginPath(); ctx.arc(rx + 32, fy + 40, 32, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `700 32px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), rx + 32, fy + 40);

    ctx.textAlign = 'left';
    ctx.fillStyle = DARK; ctx.font = `600 40px ${FONT}`;
    ctx.textBaseline = 'top';
    ctx.fillText(f.name || '', rx + 82, fy + 8);

    ctx.fillStyle = MUTED; ctx.font = `400 34px ${FONT}`;
    const detailLines = _wrapText(ctx, f.detail || '', maxTextW - 90);
    for (let j = 0; j < Math.min(detailLines.length, 2); j++) {
      ctx.fillText(detailLines[j], rx + 82, fy + 58 + j * 42);
    }

    if (i < maxF - 1) {
      ctx.fillStyle = '#e5e7eb'; ctx.fillRect(rx, fy + rowH - 2, maxTextW, 2);
    }
  }
}

// ── Template 8: Condition Showcase ───────────────────────────────────────
async function infConditionShowcase(canvas, productDataUrl, title, features, accentColor, headline, conditionBadges) {
  const ctx = canvas.getContext('2d');
  canvas.width = S; canvas.height = S;
  const ac = infValidHex(accentColor);

  const badgeStyles = {
    green: { bg: '#f0fdf4', border: '#22c55e', text: '#16a34a' },
    blue:  { bg: '#eff6ff', border: '#3b82f6', text: '#2563eb' },
    amber: { bg: '#fffbeb', border: '#f59e0b', text: '#d97706' },
    red:   { bg: '#fef2f2', border: '#ef4444', text: '#dc2626' },
  };
  const defaultBadges = [
    { label: 'Condition Verified', colorKey: 'green' },
    { label: 'All Accessories Included', colorKey: 'blue' },
    { label: 'Fully Tested', colorKey: 'amber' },
    { label: 'Ready to Ship', colorKey: 'green' },
  ];
  const badges = ((conditionBadges && conditionBadges.length > 0) ? conditionBadges : defaultBadges).slice(0, 4);

  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, S, S);

  // Title wrapped
  ctx.fillStyle = DARK; ctx.font = `700 60px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const titleLines = _wrapText(ctx, title, S - 240);
  let ty = 60;
  for (const line of titleLines.slice(0, 2)) {
    ctx.fillText(line, S / 2, ty);
    ty += 74;
  }

  // Product
  if (productDataUrl) {
    await infDrawProductClean(ctx, productDataUrl, 240, ty + 16, S - 480, S - ty - 340);
  }

  // Condition badges — 2x2 grid
  const badgeCols = 2, badgeGap = 30;
  const badgeW = (S - 240 - badgeGap) / badgeCols;
  const badgeH = 110;
  const badgeStartY = S - badgeH * 2 - badgeGap - 60;

  badges.forEach((badge, i) => {
    const col = i % badgeCols, row = Math.floor(i / badgeCols);
    const bx = 120 + col * (badgeW + badgeGap);
    const by = badgeStartY + row * (badgeH + badgeGap);
    const bs = badgeStyles[badge.colorKey] || badgeStyles.green;

    _roundRect(ctx, bx, by, badgeW, badgeH, 20);
    ctx.fillStyle = bs.bg; ctx.fill();
    ctx.strokeStyle = bs.border; ctx.lineWidth = 3; ctx.stroke();

    ctx.fillStyle = bs.text; ctx.font = `700 38px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(badge.label, bx + badgeW / 2, by + badgeH / 2);
  });
}

// ── Template 9: Bullet Points ────────────────────────────────────────────
async function infBulletPoints(canvas, productDataUrl, title, features, accentColor, headline) {
  const ctx = canvas.getContext('2d');
  canvas.width = S; canvas.height = S;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, S, S);

  const headText = headline || title;
  ctx.fillStyle = DARK; ctx.font = `800 100px ${FONT}`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const headLines = _wrapText(ctx, headText, S - 240);
  let hy = 80;
  for (const line of headLines.slice(0, 3)) {
    ctx.fillText(line, 120, hy);
    hy += 120;
  }

  // Bullet points
  const bulletStartY = hy + 16;
  const maxBullets = Math.min(features.length, 3);
  for (let i = 0; i < maxBullets; i++) {
    const f = features[i];
    const by = bulletStartY + i * 82;
    ctx.fillStyle = DARK; ctx.font = `400 48px ${FONT}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const text = f.detail ? `${f.name}: ${f.detail}` : (f.name || '');
    ctx.fillText(`•  ${text}`, 120, by);
  }

  // Product — rest of space
  const prodTop = bulletStartY + maxBullets * 82 + 30;
  const prodH = S - prodTop - 40;
  if (productDataUrl) {
    await infDrawProductClean(ctx, productDataUrl, 120, prodTop, S - 240, prodH);
  }
}


// ── Drawing helpers ─────────────────────────────────────────────────────────

// Draw product image clean — no vignette, no glow, no tint, with padding
async function infDrawProductClean(ctx, src, x, y, w, h) {
  await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const pad = Math.min(w, h) * 0.04;
      const iw = w - pad * 2, ih = h - pad * 2;
      const aspect = img.width / img.height, boxAspect = iw / ih;
      let dw, dh, dx, dy;
      if (aspect > boxAspect) { dw = iw; dh = iw / aspect; dx = x + pad; dy = y + pad + (ih - dh) / 2; }
      else { dh = ih; dw = ih * aspect; dy = y + pad; dx = x + pad + (iw - dw) / 2; }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, dx, dy, dw, dh);
      resolve();
    };
    img.onerror = resolve;
    img.src = src;
  });
}

// Keep old infDrawProduct for compatibility — now just calls clean version
async function infDrawProduct(ctx, src, x, y, w, h, accentColor) {
  await infDrawProductClean(ctx, src, x, y, w, h);
}

function infValidHex(hex) {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : '#4f6ef7';
}

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// Keep old name for compatibility
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
    bg:           '#ffffff',
    surface:      infHexToRgba(ac, 0.06),
    border:       infHexToRgba(ac, 0.14),
    glow:         infHexToRgba(ac, 0.08),
    shimmer:      ac,
    shimmerLight: infLightenHex(ac, 0.30),
    text:         '#111111',
    muted:        'rgba(0,0,0,0.50)',
  };
}

function infDrawShimmer(ctx, W, ac) {
  // Intentionally minimal — just a thin accent line at top
  ctx.fillStyle = ac; ctx.fillRect(0, 0, W, 3);
}

function infDrawTagline(ctx, W, tagline, startY, ac, FONT) {
  const line1 = tagline?.line1 || '';
  const line2 = tagline?.line2 || '';
  if (line1) {
    ctx.fillStyle = '#111111'; ctx.font = `800 50px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(infTrunc(line1, 42), W/2, startY);
  }
  if (line2) {
    ctx.fillStyle = 'rgba(0,0,0,0.50)'; ctx.font = `400 26px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(infTrunc(line2, 58), W/2, startY + 62);
  }
  return line2 ? startY + 104 : (line1 ? startY + 66 : startY);
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

function infBuildPalette(baseHex, count) {
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

// ── Text helpers ────────────────────────────────────────────────────────────

function _wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}


function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
