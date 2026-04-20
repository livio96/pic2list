// ── Shared Generate Images functionality ──
// Uses AI image generation (GPT-5 Image / Gemini Flash Image) via OpenRouter

function genImgDataUrlToBlob(dataUrl) {
  const [header, data] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)[1];
  const binary = atob(data);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/**
 * Generate infographic images for a listing using AI image generation.
 */
async function generateImagesOverlay(opts) {
  const { title, description, imageUrls, onAdd, triggerBtn } = opts;

  const overlay = document.getElementById('genImgOverlay');
  const container = document.getElementById('genImgCanvases');

  if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = 'Analyzing...'; }
  container.innerHTML = '<div class="gen-img-loading" style="grid-column:1/-1"><span class="spinner"></span> Analyzing product features...</div>';
  overlay.classList.add('open');

  try {
    // Convert first image to base64 for AI
    let productBase64 = null;
    for (const url of imageUrls.slice(0, 1)) {
      try {
        const resp = await fetch(url);
        const blob = await resp.blob();
        productBase64 = await new Promise(resolve => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(blob);
        });
      } catch { /* skip */ }
    }

    // Convert all images to base64 for feature extraction
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
      } catch { /* skip */ }
    }

    // Step 1: Extract features via Gemini
    const resp = await fetch('/api/generate-images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: imageBase64List, title, description: (description || '').replace(/<[^>]*>/g, ' ').substring(0, 2000) }),
    });
    const data = await resp.json();
    if (!data.success) throw new Error(data.error || 'Feature extraction failed');

    const { features, featureGroups, accentColor, conditionBadges, headline } = data;
    const groups = (featureGroups?.length >= 3) ? featureGroups.map(g => g.features) : [features, features, features];
    const headlineText = headline || title;

    // Step 2: Build prompts for AI image generation
    const templates = _buildImagePrompts(title, headlineText, groups, features, accentColor, conditionBadges);

    container.innerHTML = '';

    // Step 3: Generate each image via AI
    for (let tIdx = 0; tIdx < templates.length; tIdx++) {
      const tpl = templates[tIdx];

      const wrapper = document.createElement('div');
      wrapper.className = 'gen-img-card';

      const label = document.createElement('div');
      label.className = 'gen-img-label';
      label.textContent = tpl.label;

      const canvasWrap = document.createElement('div');
      canvasWrap.className = 'gen-img-canvas-wrap';

      // Show loading state per card
      const loadingDiv = document.createElement('div');
      loadingDiv.className = 'gen-img-card-loading';
      loadingDiv.innerHTML = '<span class="spinner"></span> Generating...';
      canvasWrap.appendChild(loadingDiv);

      const btnRow = document.createElement('div');
      btnRow.className = 'gen-img-btn-row';

      wrapper.appendChild(label);
      wrapper.appendChild(canvasWrap);
      wrapper.appendChild(btnRow);
      container.appendChild(wrapper);

      // Generate image async
      _generateSingleImage(tpl, productBase64, canvasWrap, btnRow, title, onAdd).catch(err => {
        canvasWrap.innerHTML = `<div class="gen-img-card-error">Failed: ${err.message}</div>`;
      });
    }
  } catch (err) {
    container.innerHTML = '<div class="gen-img-error" style="grid-column:1/-1">Error: ' + (err.message || err) + '</div>';
  }

  if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = 'Generate Images'; }
}

async function _generateSingleImage(tpl, productBase64, canvasWrap, btnRow, title, onAdd) {
  const resp = await fetch('/api/generate-ai-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: tpl.prompt, productImageBase64: productBase64 }),
  });
  const data = await resp.json();
  if (!data.success) throw new Error(data.error || 'Image generation failed');

  // Display the generated image
  canvasWrap.innerHTML = '';
  const img = document.createElement('img');
  img.className = 'gen-img-canvas';
  img.src = data.imageDataUrl;
  canvasWrap.appendChild(img);

  const zoomHint = document.createElement('div');
  zoomHint.className = 'gen-img-zoom-hint';
  zoomHint.textContent = '\uD83D\uDD0D';
  canvasWrap.appendChild(zoomHint);
  canvasWrap.addEventListener('click', () => {
    document.getElementById('infLightboxImg').src = data.imageDataUrl;
    document.getElementById('infLightbox').classList.add('open');
  });

  const filename = `${title.substring(0, 30).replace(/[^a-z0-9]/gi, '-')}-${tpl.id}.png`;

  const dlBtn = document.createElement('button');
  dlBtn.className = 'btn btn-secondary btn-sm';
  dlBtn.textContent = 'Download';
  dlBtn.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = data.imageDataUrl;
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
      await onAdd({ dataUrl: data.imageDataUrl, filename });
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
}

function _buildImagePrompts(title, headline, groups, features, accentColor, conditionBadges, marketingText) {
  const specsGroup = groups[0] || features;
  const designGroup = groups[1] || features;
  const valueGroup = groups[2] || features;

  const specsText = specsGroup.map(f => `- ${f.name}: ${f.detail || ''}`).join('\n');
  const designText = designGroup.map(f => `- ${f.name}: ${f.detail || ''}`).join('\n');
  const valueText = valueGroup.map(f => `- ${f.name}: ${f.detail || ''}`).join('\n');
  const badgesText = (conditionBadges || []).map(b => b.label).join(', ');
  const mktContext = marketingText ? `\n\nAdditional product context and marketing copy to draw from:\n${marketingText.substring(0, 2000)}` : '';

  const baseInstruction = `You are creating a professional eBay product listing image. The image must be square (1:1 aspect ratio), high resolution, clean, and look like a professionally designed Amazon/eBay A+ content image. The product is "${title}". Use the attached product photo as reference for the product appearance. Do NOT add any text that isn't specified — every word must be exactly as provided. Use clean, modern typography. No watermarks, no stock photo feel.${mktContext}`;

  return [
    {
      id: 'hero',
      label: 'Hero / Lifestyle',
      prompt: `${baseInstruction}

Create a hero product image with a clean white or very light gray background. Show the product prominently centered, taking up about 60% of the image. The product should look crisp and professional, like a studio product shot. No text overlays — just the product beautifully presented on a clean background. Make it look like an Amazon main product image.`
    },
    {
      id: 'valueprop',
      label: 'Value Proposition',
      prompt: `${baseInstruction}

Create a marketing image with this layout:
- Top area: Large bold headline text "${headline}" in dark navy/black color
- Middle: The product shown at a slight angle, professionally lit
- Bottom: 3 bullet points in smaller text:
${specsGroup.slice(0, 3).map(f => `  "- ${f.detail || f.name}"`).join('\n')}

Use a subtle light gray (#f5f5f7) background. The headline should be large and impactful. Typography should be clean sans-serif. This should look like a premium brand marketing slide.`
    },
    {
      id: 'features',
      label: 'Feature Highlight',
      prompt: `${baseInstruction}

Create a technical feature callout image. Show the product in the center. Around the product, place 2-3 labeled callout annotations pointing to specific parts of the product with thin lines and small text labels:
${specsGroup.slice(0, 3).map(f => `- "${f.name}" pointing to the ${f.position || 'relevant'} area`).join('\n')}

Use a white background. The callout labels should have small text with the feature name in bold and the detail below in lighter text. Lines should be thin and clean (blue or teal color). At the bottom, add a colored banner bar with text "${specsGroup[3]?.detail || specsGroup[0]?.detail || ''}". This should look like a professional product diagram.`
    },
    {
      id: 'specs',
      label: 'Key Specifications',
      prompt: `${baseInstruction}

Create a split-layout specifications image:
- Left side (40%): Dark navy/charcoal (#1a2332) background with the product image displayed cleanly
- Right side (60%): White background with a clean specifications list

On the right side, show these specs in a clean vertical list with bold names and regular-weight details:
${specsText}

Add a thin accent-colored vertical line separating the two sides. The title "${title}" should appear at the top of the right side in bold. This should look like a professional tech spec sheet.`
    },
    {
      id: 'comparison',
      label: 'Specs Table',
      prompt: `${baseInstruction}

Create a clean specifications table image. Layout:
- Top: Dark header bar with the product title "${title}" in white text
- Below: A clean table with two columns — "Feature" and "Specification"
- The table header row should have a blue/accent colored background with white text
- Alternating light gray and white row backgrounds

Table data:
${specsGroup.map(f => `| ${f.name} | ${f.detail || ''} |`).join('\n')}

The table should be well-padded with clear borders. Clean, professional look like a product datasheet.`
    },
    {
      id: 'whatsincluded',
      label: "What's Included",
      prompt: `${baseInstruction}

Create a "What's Included" / "Everything You Need" style image:
- Top: Bold headline "Everything you need." in large dark text
- Center: The product shown cleanly on a light background
- Bottom: A 2x2 grid of 4 feature cards, each with a colored checkmark icon and text:
${valueGroup.slice(0, 4).map(f => `  ✓ "${f.name}" — ${f.detail || ''}`).join('\n')}

Use a very light gray background (#f5f5f7). The feature cards should have white backgrounds with subtle borders. This should look like an Amazon A+ content module.`
    },
    {
      id: 'condition',
      label: 'Condition / Trust',
      prompt: `${baseInstruction}

Create a condition/trust image showing the product is verified and ready. Layout:
- Top: Product title in clean text
- Center: The product displayed cleanly
- Bottom: 4 colored trust badges in a 2x2 grid:
${(conditionBadges || []).map(b => {
  const colors = { green: 'green', blue: 'blue', amber: 'amber/yellow', red: 'red' };
  return `  - "${b.label}" with a ${colors[b.colorKey] || 'green'} accent`;
}).join('\n')}

Each badge should be a rounded rectangle card with a colored left border or top bar and a checkmark icon. White background, professional and clean.`
    },
    {
      id: 'bullets',
      label: 'Key Benefits',
      prompt: `${baseInstruction}

Create a key benefits image with this layout:
- Top half: Dark navy/charcoal (#1a2332) background section with:
  - Large bold white headline: "${headline}"
  - Below the headline, 3 bullet points in white/light text:
${valueGroup.slice(0, 3).map(f => `    "- ${f.detail || f.name}"`).join('\n')}
- Bottom half: White/light background with the product displayed prominently

Add a thin accent-colored line separating the dark and light sections. This should look like a modern marketing slide with strong visual contrast.`
    },
  ];
}

// ── Keep legacy helpers for compatibility ──
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function infTrunc(str, max) {
  if (!str) return '';
  return str.length > max ? str.substring(0, max - 1) + '…' : str;
}

function infValidHex(hex) {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : '#4f6ef7';
}
