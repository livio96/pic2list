// ═══════════════════════════════════════
//  Shared Image Editor
// ═══════════════════════════════════════

let editorState = null;

function initImageEditor() {
  const editorOverlay = document.getElementById('editorOverlay');
  document.getElementById('editorClose').addEventListener('click', closeEditor);
  editorOverlay.addEventListener('click', (e) => { if (e.target === editorOverlay) closeEditor(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && editorOverlay.classList.contains('open')) {
      closeEditor();
      e.stopPropagation();
    }
  });
}

function closeEditor() {
  document.getElementById('editorOverlay').classList.remove('open');
  editorState = null;
}

/**
 * Open the image editor.
 * @param {string} imageSrc - data URL or image URL to edit
 * @param {Function} onSave - called with { dataUrl, base64, blob } when user saves
 */
function openImageEditor(imageSrc, onSave) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const maxW = 600, maxH = 500;
    let dw = img.naturalWidth, dh = img.naturalHeight;
    const scale = Math.min(maxW / dw, maxH / dh, 1);
    dw = Math.round(dw * scale);
    dh = Math.round(dh * scale);

    editorState = {
      sourceImg: img,
      naturalW: img.naturalWidth, naturalH: img.naturalHeight,
      displayW: dw, displayH: dh, scale,
      mode: null,
      crop: null,
      bgColor: '#ffffff',
      brightness: 100, contrast: 100,
      onSave,
    };

    renderEditor();
    document.getElementById('editorOverlay').classList.add('open');
  };
  img.src = imageSrc;
}

function renderEditor() {
  const s = editorState;
  const toolbar = document.getElementById('editorToolbar');
  const canvasWrap = document.getElementById('editorCanvasWrap');
  const options = document.getElementById('editorOptions');
  const footer = document.getElementById('editorFooter');

  toolbar.className = 'editor-toolbar';
  toolbar.innerHTML = `
    <button id="edModeCrop" class="${s.mode === 'crop' ? 'active' : ''}">&#9986; Crop</button>
    <button id="edModeSquare" class="${s.mode === 'square' ? 'active' : ''}">&#9632; Make Square</button>
    <button id="edModeAdjust" class="${s.mode === 'adjust' ? 'active' : ''}">&#9788; Adjust</button>
    <button id="edRotate">&#8635; Rotate 90&deg;</button>
  `;

  canvasWrap.className = 'editor-canvas-wrap';
  canvasWrap.innerHTML = '';
  const canvas = document.createElement('canvas');
  canvas.id = 'editorCanvas';
  canvas.width = s.displayW;
  canvas.height = s.displayH;
  canvasWrap.appendChild(canvas);

  drawEditorCanvas();

  options.className = 'editor-options';
  if (s.mode === 'crop') {
    options.innerHTML = `
      <button class="btn btn-primary btn-xs" id="edApplyCrop">Apply Crop</button>
      <span style="font-size:11px;color:#8b8fa3;">Drag on image to select region</span>
    `;
  } else if (s.mode === 'square') {
    options.innerHTML = `
      <label>Background: <input type="color" id="edBgColor" value="${s.bgColor}"></label>
      <button class="btn btn-primary btn-xs" id="edApplySquare">Pad to Square</button>
      <button class="btn btn-secondary btn-xs" id="edCropSquare">Crop to Square</button>
    `;
  } else if (s.mode === 'adjust') {
    options.innerHTML = `
      <label>Brightness: <input type="range" id="edBrightness" min="50" max="200" value="${s.brightness}"> <span id="edBrVal">${s.brightness}%</span></label>
      <label>Contrast: <input type="range" id="edContrast" min="50" max="200" value="${s.contrast}"> <span id="edCVal">${s.contrast}%</span></label>
    `;
  } else {
    options.innerHTML = '';
  }

  footer.innerHTML = `
    <button class="btn btn-green btn-sm" id="edSave">Save Changes</button>
    <button class="btn btn-secondary btn-sm" id="edCancel">Cancel</button>
    <span class="spacer"></span>
    <span style="font-size:11px;color:#8b8fa3;">${s.naturalW} &times; ${s.naturalH}px</span>
  `;

  attachEditorEvents();
}

function drawEditorCanvas() {
  const s = editorState;
  const canvas = document.getElementById('editorCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  ctx.filter = `brightness(${s.brightness}%) contrast(${s.contrast}%)`;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(s.sourceImg, 0, 0, s.displayW, s.displayH);
  ctx.filter = 'none';

  if (s.mode === 'crop' && s.crop) {
    const c = s.crop;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, 0, canvas.width, c.y);
    ctx.fillRect(0, c.y + c.h, canvas.width, canvas.height - c.y - c.h);
    ctx.fillRect(0, c.y, c.x, c.h);
    ctx.fillRect(c.x + c.w, c.y, canvas.width - c.x - c.w, c.h);

    ctx.strokeStyle = '#4f6ef7';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(c.x, c.y, c.w, c.h);
    ctx.setLineDash([]);

    const hs = 6;
    ctx.fillStyle = '#4f6ef7';
    [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h],
     [c.x + c.w / 2, c.y], [c.x + c.w / 2, c.y + c.h],
     [c.x, c.y + c.h / 2], [c.x + c.w, c.y + c.h / 2]
    ].forEach(([cx, cy]) => ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs));
  }
}

function normalizeCrop() {
  const c = editorState.crop;
  if (!c) return;
  if (c.w < 0) { c.x += c.w; c.w = Math.abs(c.w); }
  if (c.h < 0) { c.y += c.h; c.h = Math.abs(c.h); }
  c.x = Math.max(0, c.x);
  c.y = Math.max(0, c.y);
  c.w = Math.min(c.w, editorState.displayW - c.x);
  c.h = Math.min(c.h, editorState.displayH - c.y);
}

function attachEditorEvents() {
  const s = editorState;

  document.getElementById('edModeCrop')?.addEventListener('click', () => {
    s.mode = s.mode === 'crop' ? null : 'crop';
    s.crop = null;
    renderEditor();
  });
  document.getElementById('edModeSquare')?.addEventListener('click', () => {
    s.mode = s.mode === 'square' ? null : 'square';
    renderEditor();
  });
  document.getElementById('edModeAdjust')?.addEventListener('click', () => {
    s.mode = s.mode === 'adjust' ? null : 'adjust';
    renderEditor();
  });
  document.getElementById('edRotate')?.addEventListener('click', () => editorApplyRotation());

  // Crop drag
  if (s.mode === 'crop') {
    const canvas = document.getElementById('editorCanvas');
    let dragging = false, startX, startY;

    const getPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = canvas.width / rect.width;
      const sy = canvas.height / rect.height;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
    };

    const onStart = (e) => {
      e.preventDefault();
      const pos = getPos(e);
      startX = pos.x; startY = pos.y;
      dragging = true;
      s.crop = { x: startX, y: startY, w: 0, h: 0 };
    };
    const onMove = (e) => {
      if (!dragging) return;
      e.preventDefault();
      const pos = getPos(e);
      s.crop.w = pos.x - startX;
      s.crop.h = pos.y - startY;
      drawEditorCanvas();
    };
    const onEnd = () => { dragging = false; normalizeCrop(); };

    canvas.addEventListener('mousedown', onStart);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseup', onEnd);
    canvas.addEventListener('mouseleave', onEnd);
    canvas.addEventListener('touchstart', onStart, { passive: false });
    canvas.addEventListener('touchmove', onMove, { passive: false });
    canvas.addEventListener('touchend', onEnd);
  }

  document.getElementById('edApplyCrop')?.addEventListener('click', () => {
    if (!s.crop || s.crop.w < 10 || s.crop.h < 10) { alert('Draw a crop region first.'); return; }
    editorApplyCrop();
  });

  document.getElementById('edBgColor')?.addEventListener('input', (e) => { s.bgColor = e.target.value; });
  document.getElementById('edApplySquare')?.addEventListener('click', () => editorApplyMakeSquare('pad'));
  document.getElementById('edCropSquare')?.addEventListener('click', () => editorApplyMakeSquare('crop'));

  document.getElementById('edBrightness')?.addEventListener('input', (e) => {
    s.brightness = parseInt(e.target.value);
    document.getElementById('edBrVal').textContent = s.brightness + '%';
    drawEditorCanvas();
  });
  document.getElementById('edContrast')?.addEventListener('input', (e) => {
    s.contrast = parseInt(e.target.value);
    document.getElementById('edCVal').textContent = s.contrast + '%';
    drawEditorCanvas();
  });

  document.getElementById('edSave')?.addEventListener('click', editorSaveChanges);
  document.getElementById('edCancel')?.addEventListener('click', closeEditor);
}

function editorReplaceSource(dataUrl) {
  const s = editorState;
  const newImg = new Image();
  newImg.onload = () => {
    s.sourceImg = newImg;
    s.naturalW = newImg.naturalWidth;
    s.naturalH = newImg.naturalHeight;
    const maxW = 600, maxH = 500;
    const scale = Math.min(maxW / s.naturalW, maxH / s.naturalH, 1);
    s.displayW = Math.round(s.naturalW * scale);
    s.displayH = Math.round(s.naturalH * scale);
    s.scale = scale;
    s.crop = null;
    s.mode = null;
    renderEditor();
  };
  newImg.src = dataUrl;
}

function editorApplyCrop() {
  const s = editorState;
  const c = s.crop;
  const sx = c.x / s.scale, sy = c.y / s.scale;
  const sw = c.w / s.scale, sh = c.h / s.scale;

  const tmp = document.createElement('canvas');
  tmp.width = Math.round(sw);
  tmp.height = Math.round(sh);
  const ctx = tmp.getContext('2d');
  ctx.drawImage(s.sourceImg, sx, sy, sw, sh, 0, 0, tmp.width, tmp.height);
  editorReplaceSource(tmp.toDataURL('image/png'));
}

function editorApplyMakeSquare(mode) {
  const s = editorState;
  const tmp = document.createElement('canvas');
  const ctx = tmp.getContext('2d');

  if (mode === 'pad') {
    const side = Math.max(s.naturalW, s.naturalH);
    tmp.width = side; tmp.height = side;
    ctx.fillStyle = s.bgColor;
    ctx.fillRect(0, 0, side, side);
    const ox = Math.round((side - s.naturalW) / 2);
    const oy = Math.round((side - s.naturalH) / 2);
    ctx.drawImage(s.sourceImg, ox, oy, s.naturalW, s.naturalH);
  } else {
    const side = Math.min(s.naturalW, s.naturalH);
    tmp.width = side; tmp.height = side;
    const sx = Math.round((s.naturalW - side) / 2);
    const sy = Math.round((s.naturalH - side) / 2);
    ctx.drawImage(s.sourceImg, sx, sy, side, side, 0, 0, side, side);
  }
  editorReplaceSource(tmp.toDataURL('image/png'));
}

function editorApplyRotation() {
  const s = editorState;
  const tmp = document.createElement('canvas');
  tmp.width = s.naturalH;
  tmp.height = s.naturalW;
  const ctx = tmp.getContext('2d');
  ctx.translate(tmp.width / 2, tmp.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(s.sourceImg, -s.naturalW / 2, -s.naturalH / 2);
  editorReplaceSource(tmp.toDataURL('image/png'));
}

function editorSaveChanges() {
  const s = editorState;
  const finalCanvas = document.createElement('canvas');
  finalCanvas.width = s.naturalW;
  finalCanvas.height = s.naturalH;
  const ctx = finalCanvas.getContext('2d');
  ctx.filter = `brightness(${s.brightness}%) contrast(${s.contrast}%)`;
  ctx.drawImage(s.sourceImg, 0, 0, s.naturalW, s.naturalH);
  ctx.filter = 'none';

  const mimeType = 'image/jpeg';
  const dataUrl = finalCanvas.toDataURL(mimeType, 0.92);
  const base64 = dataUrl.split(',')[1];

  const byteString = atob(base64);
  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);
  for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
  const blob = new Blob([ab], { type: mimeType });

  if (s.onSave) s.onSave({ dataUrl, base64, blob });
  closeEditor();
}
