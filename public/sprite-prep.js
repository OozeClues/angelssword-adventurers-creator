/**
 * ⚔️ AS Adventurer — Sprite Prep Module
 * Angel's Sword Studios
 * 
 * Tab 1: Create or prepare a 1280×720 sprite image with chroma key background.
 * Two modes: Manual Upload and AI Generate.
 */

(function() {
    'use strict';

    // ============================================
    // KEY COLORS
    // ============================================
    const KEY_COLORS = [
        { hex: '#00FF00', name: 'Green',   r: 0,   g: 255, b: 0   },
        { hex: '#FF00FF', name: 'Magenta', r: 255, g: 0,   b: 255 },
        { hex: '#0000FF', name: 'Blue',    r: 0,   g: 0,   b: 255 },
        { hex: '#FFFF00', name: 'Yellow',  r: 255, g: 255, b: 0   },
        { hex: '#00FFFF', name: 'Cyan',    r: 0,   g: 255, b: 255 }
    ];

    // ============================================
    // STATE
    // ============================================
    let spriteImage = null;
    let spriteFileName = '';
    let selectedKeyColor = '#00FF00';
    let offset = parseInt(localStorage.getItem('sp-offset')) || 0;
    let zoom = parseInt(localStorage.getItem('sp-zoom')) || 100;

    // Generative mode state
    let generating = false;
    let genCancelled = false;
    let genResults = [];
    let selectedResult = null;
    let charRefBase64 = null;
    let styleRefBase64 = null;
    let raceMode = 'normal'; // 'normal', 'kanolith', or 'zoalith'

    // ============================================
    // MANUAL MODE — CANVAS SYSTEM
    // ============================================

    function renderCanvas() {
        if (!spriteImage) return;

        const canvas = document.getElementById('spCanvas');
        const ctx = canvas.getContext('2d');
        const CW = 1280, CH = 720;

        // Fill with key color
        ctx.fillStyle = selectedKeyColor;
        ctx.fillRect(0, 0, CW, CH);

        const img = spriteImage;
        const sw = img.naturalWidth, sh = img.naturalHeight;

        // Find bottom-most visible row
        const tc = document.createElement('canvas');
        tc.width = sw; tc.height = sh;
        const tctx = tc.getContext('2d', { willReadFrequently: true });
        tctx.drawImage(img, 0, 0);
        const data = tctx.getImageData(0, 0, sw, sh).data;

        let bottomRow = sh - 1;
        for (let y = sh - 1; y >= 0; y--) {
            for (let x = 0; x < sw; x++) {
                if (data[(y * sw + x) * 4 + 3] > 30) {
                    bottomRow = y;
                    y = -1; break;
                }
            }
        }

        // Position: bottom-anchored + offset
        const spriteY = CH - bottomRow - 1 + offset;
        const spriteX = Math.round((CW - sw) / 2);

        // Apply zoom, anchored to bottom-center
        const scale = zoom / 100;
        const drawW = Math.round(sw * scale);
        const drawH = Math.round(sh * scale);
        const zoomX = spriteX + Math.round((sw - drawW) / 2);
        const zoomY = spriteY + (sh - drawH);
        ctx.drawImage(img, zoomX, zoomY, drawW, drawH);
    }

    const debouncedRender = debounce(renderCanvas, 50);

    /** Auto-detect optimal key color for the loaded sprite (Fugi Maker algorithm) */
    function autoDetectKeyColor(image, swatchContainerId) {
        if (!image) return;

        const w = image.naturalWidth, h = image.naturalHeight;
        const tc = document.createElement('canvas');
        tc.width = w; tc.height = h;
        const tctx = tc.getContext('2d', { willReadFrequently: true });
        tctx.drawImage(image, 0, 0);
        const data = tctx.getImageData(0, 0, w, h).data;

        const minDist = new Float64Array(KEY_COLORS.length).fill(Infinity);

        for (let i = 0; i < w * h; i++) {
            const idx = i * 4;
            if (data[idx + 3] < 128) continue; // skip transparent
            const r = data[idx], g = data[idx + 1], b = data[idx + 2];
            for (let c = 0; c < KEY_COLORS.length; c++) {
                const dr = r - KEY_COLORS[c].r;
                const dg = g - KEY_COLORS[c].g;
                const db = b - KEY_COLORS[c].b;
                const dist = Math.sqrt(dr * dr + dg * dg + db * db);
                if (dist < minDist[c]) minDist[c] = dist;
            }
        }

        let bestIdx = 0, bestSep = -1;
        for (let c = 0; c < KEY_COLORS.length; c++) {
            if (minDist[c] > bestSep) { bestSep = minDist[c]; bestIdx = c; }
        }

        // Update badges
        const container = document.getElementById(swatchContainerId);
        if (container) {
            container.querySelectorAll('.color-swatch').forEach(swatch => {
                const hex = swatch.dataset.color;
                const badge = swatch.querySelector('.swatch-badge');
                const idx = KEY_COLORS.findIndex(k => k.hex === hex);
                swatch.classList.remove('selected');

                if (idx === bestIdx) {
                    swatch.classList.add('selected');
                    if (badge) { badge.textContent = '⭐ Best'; badge.className = 'swatch-badge best'; }
                } else if (idx >= 0 && minDist[idx] < 80) {
                    if (badge) { badge.textContent = '⚠ Avoid'; badge.className = 'swatch-badge avoid'; }
                } else {
                    if (badge) { badge.textContent = colorName(hex); badge.className = 'swatch-badge'; }
                }
            });
        }

        selectedKeyColor = KEY_COLORS[bestIdx].hex;
        window.ASAdventurer.handoff.keyColor = selectedKeyColor;
        return selectedKeyColor;
    }

    /**
     * Advanced key color analysis using corner-sampling to ignore background
     * (Ported from ASArtTool sprite-generator.js _analyzeReferenceForKeyColor)
     */
    function analyzeReferenceForKeyColor(dataUrl, swatchContainerId) {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            ctx.drawImage(img, 0, 0);

            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const { data, width, height } = imageData;

            // Sample 5×5 corner pixels to detect background color
            const cornerSamples = [];
            const s = 5;
            for (let y = 0; y < s; y++) {
                for (let x = 0; x < s; x++) {
                    const idx = (y * width + x) * 4;
                    cornerSamples.push({ r: data[idx], g: data[idx + 1], b: data[idx + 2] });
                }
            }

            // Median corner color as estimated background
            const bgR = cornerSamples.map(c => c.r).sort((a, b) => a - b)[Math.floor(cornerSamples.length / 2)];
            const bgG = cornerSamples.map(c => c.g).sort((a, b) => a - b)[Math.floor(cornerSamples.length / 2)];
            const bgB = cornerSamples.map(c => c.b).sort((a, b) => a - b)[Math.floor(cornerSamples.length / 2)];

            // Collect foreground pixels (skip transparent + near-background)
            const fgPixels = [];
            const step = 3;
            for (let y = 0; y < height; y += step) {
                for (let x = 0; x < width; x += step) {
                    const idx = (y * width + x) * 4;
                    const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
                    if (a < 128) continue;
                    const bgDist = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
                    if (bgDist < 40) continue;
                    fgPixels.push({ r, g, b });
                }
            }

            if (fgPixels.length < 10) return;

            // Score each key color
            const scores = KEY_COLORS.map(key => {
                let minD = Infinity;
                for (const px of fgPixels) {
                    const dist = Math.abs(px.r - key.r) + Math.abs(px.g - key.g) + Math.abs(px.b - key.b);
                    if (dist < minD) minD = dist;
                }
                return { key, minDist: minD };
            });

            scores.sort((a, b) => b.minDist - a.minDist);

            // Update UI badges
            const container = document.getElementById(swatchContainerId);
            if (container) {
                container.querySelectorAll('.color-swatch').forEach(swatch => {
                    const hex = swatch.dataset.color;
                    const badge = swatch.querySelector('.swatch-badge');
                    const score = scores.find(s => s.key.hex === hex);
                    swatch.classList.remove('selected');

                    if (score && score === scores[0]) {
                        swatch.classList.add('selected');
                        if (badge) { badge.textContent = '⭐ Best'; badge.className = 'swatch-badge best'; }
                    } else if (score && score.minDist < 80) {
                        if (badge) { badge.textContent = '⚠ Avoid'; badge.className = 'swatch-badge avoid'; }
                    } else {
                        if (badge) { badge.textContent = colorName(hex); badge.className = 'swatch-badge'; }
                    }
                });
            }

            selectedKeyColor = scores[0].key.hex;
            window.ASAdventurer.handoff.keyColor = selectedKeyColor;
        };
        img.src = dataUrl;
    }

    function loadSprite(file) {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            spriteImage = img;
            spriteFileName = file.name.replace(/\.\w+$/i, '');

            // Enable stages
            document.getElementById('spManualStage2').classList.remove('disabled');
            document.getElementById('spManualStage3').classList.remove('disabled');

            // Auto-detect best key color
            autoDetectKeyColor(img, 'spColorSwatches');

            // Restore persisted values
            const offsetSlider = document.getElementById('spOffset');
            const zoomSlider = document.getElementById('spZoom');
            if (offsetSlider) offsetSlider.value = offset;
            if (zoomSlider) zoomSlider.value = zoom;

            renderCanvas();
            showToast(`Sprite loaded: ${img.naturalWidth}×${img.naturalHeight}`, 'success');
        };
        img.onerror = () => {
            showToast('Failed to load image', 'error');
            URL.revokeObjectURL(url);
        };
        img.src = url;
    }

    function downloadPNG() {
        const canvas = document.getElementById('spCanvas');
        canvas.toBlob(blob => {
            const name = window.ASAdventurer.characterName || spriteFileName || 'sprite';
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${name}_1280x720.png`;
            a.click();
            URL.revokeObjectURL(a.href);
        }, 'image/png');
    }

    function handoffToVideoGen() {
        const canvas = document.getElementById('spCanvas');
        canvas.toBlob(async (blob) => {
            window.ASAdventurer.handoff.spriteBlob = blob;
            window.ASAdventurer.handoff.spriteCanvas = canvas;
            const b64 = await blobToBase64(blob);
            window.ASAdventurer.handoff.spriteBase64 = b64;
            // Save character name
            localStorage.setItem('as_char_name', window.ASAdventurer.characterName || '');
            showToast('Sprite sent to Generate Video', 'success');
            switchTab('tab-video-gen');
        }, 'image/png');
    }

    // ============================================
    // GENERATIVE MODE — AI CREATE
    // ============================================

    function buildPrompt() {
        const name = document.getElementById('sgCharName')?.value?.trim() || 'Character';
        const desc = document.getElementById('sgCharDesc')?.value?.trim() || '';
        const action = document.getElementById('sgCharAction')?.value?.trim() || '';

        const keyHex = selectedKeyColor;
        const keyName = colorName(keyHex);
        const actionText = action || 'standing in a neutral idle position';

        // Race mode prompt directives
        let raceDirective = '';
        if (raceMode === 'kanolith') {
            raceDirective = '\nCRITICAL - KEMONOMIMI STYLE:\nThis character is a kemonomimi (moe anthropomorphism). They must have a FULLY HUMAN face - human nose, human mouth, human skin, human facial structure. They have animal ears on top of their head and an animal tail, but NO human ears (the sides of the head where human ears would be must be covered by hair or simply absent). NO snout, NO fur on face, NO whiskers, NO muzzle, NO animal nose. The face must be 100% anime-human in appearance. Only the ears and tail are animal-like.\n';
        } else if (raceMode === 'zoalith') {
            raceDirective = '\nCRITICAL - FULL ANTHROPOMORPHIC STYLE:\nThis character is a full anthropomorphic beastfolk (furry/kemono style). They should have pronounced animal facial features: a visible snout or muzzle, fur covering the face and body, animal nose, whiskers if applicable, digitigrade legs if applicable. The body structure is humanoid but the head and skin are distinctly animal. Think classic RPG beastfolk like Breath of Fire or Final Fantasy Bangaa/Moogle.\n';
        }

        return [
            `A single ${name}${desc ? ', ' + desc : ''}, ${actionText}.`,
            raceDirective,
            `Character shown from the waist up (upper body, chest, shoulders, head). The character is positioned in the lower portion of the canvas, centered horizontally, with plenty of solid background space above the character's head.`,
            `The entire background must be a solid, uniform ${keyName.toUpperCase()} (${keyHex}) with absolutely no gradients, shadows, or variations.`,
            `Every pixel of background must be the exact same shade of ${keyName.toLowerCase()} — a single uniform matte color.`,
            `The character should be drawn in a high-quality anime/JRPG art style with clean linework and cel-shading.`,
            `The image must be exactly 1280×720 pixels.`,
            `The character has crisp, clean edges with bold dark outlines and a well-defined silhouette against the flat colored background.`,
            `Waist-up portrait composition with flat studio lighting. The character's lower body is cut off at approximately the waist or hip level by the bottom edge of the canvas. No ground, no floor, no feet visible.`
        ].filter(Boolean).join('\n');
    }

    function buildPromptWithRefs(promptText) {
        if (charRefBase64 && styleRefBase64) {
            return 'Two reference images are provided. The FIRST image (character_reference.png) is the CHARACTER REFERENCE — the generated character must look exactly like this character. The SECOND image (style_reference.png) is the STYLE REFERENCE — match its art style only. ' + promptText +
                '\n\nCRITICAL: The character must look like the one in character_reference.png.';
        } else if (charRefBase64) {
            return promptText + '\n\nThe character should look exactly like the one in the provided reference image.';
        } else if (styleRefBase64) {
            return 'Match the exact art style shown in the provided style reference image. ' + promptText;
        }
        return promptText;
    }

    async function imageFileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    async function generate() {
        if (generating) return;

        const name = document.getElementById('sgCharName')?.value?.trim();
        if (!name) {
            showToast('Please enter a character name', 'warning');
            document.getElementById('sgCharName')?.focus();
            return;
        }

        const apiKey = localStorage.getItem('openai_api_key');
        if (!apiKey) {
            showToast('No OpenAI API key. Go to Settings to add one.', 'error');
            return;
        }

        // Get generation count
        const genCountContainer = document.getElementById('sgGenCount');
        const activeCountBtn = genCountContainer?.querySelector('.gen-count-btn.active');
        const genCount = activeCountBtn ? parseInt(activeCountBtn.dataset.count) : 1;

        generating = true;
        genCancelled = false;

        // Show progress
        document.getElementById('sgProgress').classList.add('active');
        document.getElementById('sgGenerateBtn').disabled = true;

        const status = document.getElementById('sgStatus');
        status.innerHTML = '<div class="status-msg info"><span class="spinner"></span> Generating sprite — this may take up to a minute…</div>';

        try {
            let promptText = buildPrompt();
            promptText = buildPromptWithRefs(promptText);

            const images = [];
            if (charRefBase64) images.push({ label: 'character_reference', data: charRefBase64 });
            if (styleRefBase64) images.push({ label: 'style_reference', data: styleRefBase64 });

            // Launch parallel generations
            const promises = [];
            for (let i = 0; i < genCount; i++) {
                if (genCancelled) break;
                promises.push(generateOne(apiKey, promptText, images));
            }

            const results = await Promise.allSettled(promises);
            genResults = [];

            for (const result of results) {
                if (result.status === 'fulfilled' && result.value) {
                    genResults.push(result.value);
                }
            }

            if (genResults.length > 0) {
                displayResults();
                window.notificationSound?.play();
                status.innerHTML = `<div class="status-msg success">✅ Generated ${genResults.length} sprite(s)!</div>`;
            } else if (!genCancelled) {
                status.innerHTML = '<div class="status-msg error">❌ All generations failed. Check your API key and try again.</div>';
            }
        } catch (err) {
            status.innerHTML = `<div class="status-msg error">❌ ${err.message}</div>`;
        } finally {
            generating = false;
            document.getElementById('sgProgress').classList.remove('active');
            document.getElementById('sgGenerateBtn').disabled = false;
        }
    }

    async function generateOne(apiKey, prompt, images) {
        const hasImages = images.length > 0;
        const endpoint = hasImages ? '/api/edits' : '/api/generate';

        const body = {
            model: 'gpt-image-2',
            prompt: prompt,
            n: 1,
            size: '1536x1024', // Closest to 1280x720 that the API supports (landscape)
            quality: 'high'
        };

        if (hasImages) body.images = images;

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err?.error?.message || `API error: ${response.status}`);
        }

        const data = await response.json();
        const b64 = data?.data?.[0]?.b64_json;
        if (!b64) throw new Error('No image in API response');

        return `data:image/png;base64,${b64}`;
    }

    function displayResults() {
        const grid = document.getElementById('sgResultsGrid');
        const section = document.getElementById('sgResultsSection');
        grid.innerHTML = '';
        section.classList.remove('hidden');

        genResults.forEach((dataUrl, idx) => {
            const card = document.createElement('div');
            card.className = 'result-card' + (idx === 0 ? ' selected' : '');
            card.innerHTML = `
                <img src="${dataUrl}" alt="Generated sprite ${idx + 1}">
                <div class="card-actions">
                    <button class="btn btn-sm btn-secondary" data-action="download" data-idx="${idx}" title="Download this sprite">💾 Save</button>
                    <button class="btn btn-sm btn-primary" data-action="select" data-idx="${idx}" title="Select this sprite for the pipeline">✓ Select</button>
                </div>
            `;
            grid.appendChild(card);
        });

        if (genResults.length > 0) {
            selectedResult = genResults[0];
            updateGenPreview(genResults[0]);
        }

        // Card action handlers
        grid.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const idx = parseInt(btn.dataset.idx);
            const dataUrl = genResults[idx];

            if (btn.dataset.action === 'download') {
                const a = document.createElement('a');
                a.href = dataUrl;
                a.download = `${window.ASAdventurer.characterName || 'sprite'}_gen_${idx + 1}.png`;
                a.click();
            } else if (btn.dataset.action === 'select') {
                grid.querySelectorAll('.result-card').forEach(c => c.classList.remove('selected'));
                btn.closest('.result-card').classList.add('selected');
                selectedResult = dataUrl;
                updateGenPreview(dataUrl);
            }
        });
    }

    function updateGenPreview(dataUrl) {
        const canvas = document.getElementById('sgCanvas');
        const ctx = canvas.getContext('2d');
        const img = new Image();
        img.onload = () => {
            ctx.clearRect(0, 0, 1280, 720);
            // Scale to fit 1280x720 while maintaining aspect
            const scale = Math.min(1280 / img.width, 720 / img.height);
            const w = img.width * scale;
            const h = img.height * scale;
            ctx.drawImage(img, (1280 - w) / 2, (720 - h) / 2, w, h);
        };
        img.src = dataUrl;
    }

    function genHandoffToVideoGen() {
        if (!selectedResult) {
            showToast('Select a sprite first', 'warning');
            return;
        }

        const blob = base64ToBlob(selectedResult);
        window.ASAdventurer.handoff.spriteBlob = blob;
        window.ASAdventurer.handoff.spriteBase64 = selectedResult;
        localStorage.setItem('as_char_name', window.ASAdventurer.characterName || '');
        showToast('Sprite sent to Generate Video', 'success');
        switchTab('tab-video-gen');
    }

    function genHandoffToManual() {
        if (!selectedResult) {
            showToast('Select a sprite first', 'warning');
            return;
        }

        // Load the selected AI result as an Image into the manual mode
        const img = new Image();
        img.onload = () => {
            spriteImage = img;
            spriteFileName = (window.ASAdventurer.characterName || 'sprite') + '_gen';

            // Enable manual mode stages
            document.getElementById('spManualStage2').classList.remove('disabled');
            document.getElementById('spManualStage3').classList.remove('disabled');

            // Auto-detect key color for the generated image
            autoDetectKeyColor(img, 'spColorSwatches');

            // Reset offset/zoom to defaults for fresh positioning
            offset = 0;
            zoom = 100;
            const offsetSlider = document.getElementById('spOffset');
            const zoomSlider = document.getElementById('spZoom');
            if (offsetSlider) { offsetSlider.value = 0; document.getElementById('spOffsetVal').textContent = '0px'; }
            if (zoomSlider) { zoomSlider.value = 100; document.getElementById('spZoomVal').textContent = '100%'; }

            renderCanvas();

            // Switch to Manual Upload mode
            const modeSelector = document.getElementById('spritePrepMode');
            modeSelector.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
            modeSelector.querySelector('[data-mode="manual"]').classList.add('active');
            document.getElementById('spriteManualMode').classList.remove('hidden');
            document.getElementById('spriteGenerateMode').classList.add('hidden');

            showToast('Sprite loaded into Manual Upload — adjust offset & zoom', 'success');
        };
        img.src = selectedResult;
    }

    // ============================================
    // INITIALIZATION
    // ============================================
    function initSpritePrep() {
        // --- Mode Switching ---
        const modeSelector = document.getElementById('spritePrepMode');
        const manualMode = document.getElementById('spriteManualMode');
        const generateMode = document.getElementById('spriteGenerateMode');

        modeSelector.addEventListener('click', (e) => {
            const btn = e.target.closest('.mode-btn');
            if (!btn) return;
            modeSelector.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            if (btn.dataset.mode === 'manual') {
                manualMode.classList.remove('hidden');
                generateMode.classList.add('hidden');
            } else {
                manualMode.classList.add('hidden');
                generateMode.classList.remove('hidden');
            }
        });

        // --- Manual Mode ---
        // Upload zone
        initUploadZone('spUploadZone', 'spFileInput', (files) => {
            if (files[0]) loadSprite(files[0]);
        }, () => {
            // Clear sprite
            spriteImage = null;
            spriteFileName = '';
            const canvas = document.getElementById('spCanvas');
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            document.getElementById('spDownloadBtn').disabled = true;
            document.getElementById('spHandoffBtn').disabled = true;
            showToast('Sprite cleared', 'info');
        });

        // Color swatches
        initColorSwatches('spColorSwatches', (color) => {
            selectedKeyColor = color;
            window.ASAdventurer.handoff.keyColor = color;
            renderCanvas();
        });

        // Offset slider
        const offsetSlider = document.getElementById('spOffset');
        const offsetVal = document.getElementById('spOffsetVal');
        if (offsetSlider) {
            offsetSlider.value = offset;
            offsetVal.textContent = offset + 'px';
            offsetSlider.addEventListener('input', () => {
                offset = parseInt(offsetSlider.value);
                offsetVal.textContent = offset + 'px';
                localStorage.setItem('sp-offset', offset);
                debouncedRender();
            });
        }

        // Zoom slider
        const zoomSlider = document.getElementById('spZoom');
        const zoomVal = document.getElementById('spZoomVal');
        if (zoomSlider) {
            zoomSlider.value = zoom;
            zoomVal.textContent = zoom + '%';
            zoomSlider.addEventListener('input', () => {
                zoom = parseInt(zoomSlider.value);
                zoomVal.textContent = zoom + '%';
                localStorage.setItem('sp-zoom', zoom);
                debouncedRender();
            });
        }

        // Download & Handoff buttons
        document.getElementById('spDownloadBtn')?.addEventListener('click', downloadPNG);
        document.getElementById('spHandoffBtn')?.addEventListener('click', handoffToVideoGen);

        // --- Generative Mode ---
        // Color swatches (generative)
        initColorSwatches('sgColorSwatches', (color) => {
            selectedKeyColor = color;
            window.ASAdventurer.handoff.keyColor = color;
        });

        // Generation count
        initGenCount('sgGenCount');

        // Style reference upload
        initUploadZone('sgStyleRefZone', 'sgStyleRefInput', async (files) => {
            if (files[0]) {
                styleRefBase64 = await imageFileToBase64(files[0]);
                const preview = document.getElementById('sgStyleRefPreview');
                preview.innerHTML = `<img src="${styleRefBase64}" style="max-width:100%;border-radius:var(--radius);border:1px solid var(--border)">`;
                preview.classList.remove('hidden');
                showToast('Style reference loaded', 'info');
            }
        }, () => {
            styleRefBase64 = null;
            const preview = document.getElementById('sgStyleRefPreview');
            preview.innerHTML = '';
            preview.classList.add('hidden');
            showToast('Style reference cleared', 'info');
        });

        // Character reference upload
        initUploadZone('sgCharRefZone', 'sgCharRefInput', async (files) => {
            if (files[0]) {
                charRefBase64 = await imageFileToBase64(files[0]);
                const preview = document.getElementById('sgCharRefPreview');
                preview.innerHTML = `<img src="${charRefBase64}" style="max-width:100%;border-radius:var(--radius);border:1px solid var(--border)">`;
                preview.classList.remove('hidden');
                // Auto-detect key color from character reference
                analyzeReferenceForKeyColor(charRefBase64, 'sgColorSwatches');
                showToast('Character reference loaded — key color auto-detected', 'info');
            }
        }, () => {
            charRefBase64 = null;
            const preview = document.getElementById('sgCharRefPreview');
            preview.innerHTML = '';
            preview.classList.add('hidden');
            showToast('Character reference cleared', 'info');
        });

        // Race mode selector
        initModeSelector('sgRaceMode', (mode) => {
            raceMode = mode;
        });

        // Generate button
        document.getElementById('sgGenerateBtn')?.addEventListener('click', generate);

        // Cancel button
        document.getElementById('sgCancelBtn')?.addEventListener('click', () => {
            genCancelled = true;
            showToast('Generation cancelled', 'warning');
        });

        // Handoff from generative mode
        document.getElementById('sgHandoffBtn')?.addEventListener('click', genHandoffToVideoGen);
        document.getElementById('sgToManualBtn')?.addEventListener('click', genHandoffToManual);

        // Advanced Key Color button
        document.getElementById('sgAdvancedKeyBtn')?.addEventListener('click', openAdvancedKeyModal);
        document.getElementById('advKeyClose')?.addEventListener('click', closeAdvancedKeyModal);
        document.getElementById('advKeyClearBtn')?.addEventListener('click', clearAdvKeySelection);
        document.getElementById('advKeyAnalyzeBtn')?.addEventListener('click', runAdvKeyAnalysis);

        // Close modal on overlay click
        document.getElementById('advKeyModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) closeAdvancedKeyModal();
        });

        // Rectangle selection on canvas
        initAdvKeyRectSelection();
    }

    // ============================================
    // ADVANCED KEY COLOR ANALYSIS
    // ============================================
    let advKeyRect = null;     // { x, y, w, h } in canvas coords
    let advKeyImg = null;      // Image element for the reference
    let advKeyDrawing = false;
    let advKeyStartX = 0, advKeyStartY = 0;

    function openAdvancedKeyModal() {
        if (!charRefBase64) {
            showToast('Upload a Character Reference first', 'warning');
            return;
        }

        const modal = document.getElementById('advKeyModal');
        const canvas = document.getElementById('advKeyCanvas');
        const ctx = canvas.getContext('2d');

        modal.classList.remove('hidden');
        document.getElementById('advKeyResults').classList.add('hidden');
        clearAdvKeySelection();

        // Load the reference image onto canvas
        const img = new Image();
        img.onload = () => {
            advKeyImg = img;
            // Fit image into canvas keeping aspect ratio
            const maxW = 760, maxH = 500;
            const scale = Math.min(maxW / img.width, maxH / img.height, 1);
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        };
        img.src = charRefBase64;
    }

    function closeAdvancedKeyModal() {
        document.getElementById('advKeyModal').classList.add('hidden');
    }

    function clearAdvKeySelection() {
        advKeyRect = null;
        const sel = document.getElementById('advKeySelection');
        sel.style.display = 'none';
        document.getElementById('advKeyAnalyzeBtn').disabled = true;
        document.getElementById('advKeyResults').classList.add('hidden');
    }

    function initAdvKeyRectSelection() {
        const wrap = document.getElementById('advKeyCanvasWrap');
        const canvas = document.getElementById('advKeyCanvas');
        const sel = document.getElementById('advKeySelection');
        if (!wrap || !canvas) return;

        wrap.addEventListener('mousedown', (e) => {
            const rect = canvas.getBoundingClientRect();
            advKeyStartX = e.clientX - rect.left;
            advKeyStartY = e.clientY - rect.top;
            advKeyDrawing = true;
            sel.style.display = 'block';
            sel.style.left = advKeyStartX + 'px';
            sel.style.top = advKeyStartY + 'px';
            sel.style.width = '0px';
            sel.style.height = '0px';
        });

        wrap.addEventListener('mousemove', (e) => {
            if (!advKeyDrawing) return;
            const rect = canvas.getBoundingClientRect();
            const curX = e.clientX - rect.left;
            const curY = e.clientY - rect.top;

            const x = Math.min(advKeyStartX, curX);
            const y = Math.min(advKeyStartY, curY);
            const w = Math.abs(curX - advKeyStartX);
            const h = Math.abs(curY - advKeyStartY);

            sel.style.left = x + 'px';
            sel.style.top = y + 'px';
            sel.style.width = w + 'px';
            sel.style.height = h + 'px';
        });

        const finishDraw = (e) => {
            if (!advKeyDrawing) return;
            advKeyDrawing = false;

            const rect = canvas.getBoundingClientRect();
            const curX = e.clientX - rect.left;
            const curY = e.clientY - rect.top;

            const x = Math.max(0, Math.min(advKeyStartX, curX));
            const y = Math.max(0, Math.min(advKeyStartY, curY));
            const w = Math.min(Math.abs(curX - advKeyStartX), canvas.width - x);
            const h = Math.min(Math.abs(curY - advKeyStartY), canvas.height - y);

            if (w > 10 && h > 10) {
                advKeyRect = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
                document.getElementById('advKeyAnalyzeBtn').disabled = false;
            } else {
                clearAdvKeySelection();
            }
        };

        wrap.addEventListener('mouseup', finishDraw);
        wrap.addEventListener('mouseleave', (e) => {
            if (advKeyDrawing) finishDraw(e);
        });
    }

    function runAdvKeyAnalysis() {
        if (!advKeyRect || !advKeyImg) return;

        const canvas = document.getElementById('advKeyCanvas');
        const ctx = canvas.getContext('2d');
        const { x, y, w, h } = advKeyRect;

        // Extract pixel data from the selection region
        const imageData = ctx.getImageData(x, y, w, h);
        const pixels = imageData.data;

        // Build a histogram of unique colors (quantized to 6-bit per channel for speed)
        const colorMap = new Map();
        let totalPixels = 0;

        for (let i = 0; i < pixels.length; i += 4) {
            const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
            if (a < 128) continue; // Skip transparent pixels

            // Quantize to reduce noise
            const qr = r >> 2, qg = g >> 2, qb = b >> 2;
            const key = (qr << 12) | (qg << 6) | qb;
            colorMap.set(key, (colorMap.get(key) || 0) + 1);
            totalPixels++;
        }

        if (totalPixels < 100) {
            showToast('Selection too small or mostly transparent', 'warning');
            return;
        }

        // For each key color, calculate its minimum distance to any character pixel
        // Use CIE76 deltaE in Lab space for perceptual accuracy
        const results = KEY_COLORS.map(keyCol => {
            const keyLab = rgbToLab(keyCol.r, keyCol.g, keyCol.b);

            let minDist = Infinity;
            let avgDist = 0;
            let dangerPixels = 0;
            const threshold = 30; // Pixels closer than this are "dangerous"

            for (const [quantKey, count] of colorMap) {
                const qr = ((quantKey >> 12) & 0x3F) << 2;
                const qg = ((quantKey >> 6) & 0x3F) << 2;
                const qb = (quantKey & 0x3F) << 2;
                const pixLab = rgbToLab(qr, qg, qb);

                const dist = Math.sqrt(
                    (keyLab.L - pixLab.L) ** 2 +
                    (keyLab.a - pixLab.a) ** 2 +
                    (keyLab.b - pixLab.b) ** 2
                );

                if (dist < minDist) minDist = dist;
                avgDist += dist * count;
                if (dist < threshold) dangerPixels += count;
            }

            avgDist /= totalPixels;
            const dangerPercent = (dangerPixels / totalPixels) * 100;

            // Score = weighted combination: mostly minimum distance, some average
            const score = minDist * 0.6 + avgDist * 0.4;

            return {
                ...keyCol,
                minDist: Math.round(minDist * 10) / 10,
                avgDist: Math.round(avgDist * 10) / 10,
                dangerPercent: Math.round(dangerPercent * 10) / 10,
                score: Math.round(score * 10) / 10
            };
        });

        // Sort by score descending (higher = better separation)
        results.sort((a, b) => b.score - a.score);

        // Display results
        displayAdvKeyResults(results);
    }

    function displayAdvKeyResults(results) {
        const container = document.getElementById('advKeyResultsList');
        const wrapper = document.getElementById('advKeyResults');
        wrapper.classList.remove('hidden');

        const maxScore = results[0].score;

        container.innerHTML = results.map((r, i) => {
            const pct = (r.score / maxScore * 100).toFixed(0);
            const barColor = i === 0 ? 'var(--accent-gold)' :
                             i === 1 ? 'var(--accent-teal)' : 'rgba(255,255,255,0.2)';
            const dangerLabel = r.dangerPercent > 5 ? `⚠️ ${r.dangerPercent}% conflict` :
                                r.dangerPercent > 0 ? `${r.dangerPercent}% near` : '✅ Clean';

            return `
                <div class="adv-key-result ${i === 0 ? 'best' : ''}" data-color="${r.hex}">
                    <div class="adv-key-swatch" style="background:${r.hex}"></div>
                    <div class="adv-key-name">${r.name}</div>
                    <div class="adv-key-bar-wrap">
                        <div class="adv-key-bar" style="width:${pct}%;background:${barColor}"></div>
                    </div>
                    <div class="adv-key-score">${r.score}</div>
                    <div class="adv-key-score" style="min-width:100px;font-size:0.7rem">${dangerLabel}</div>
                    ${i === 0 ? '<span class="adv-key-badge">BEST</span>' : ''}
                </div>
            `;
        }).join('');

        // Click to select
        container.querySelectorAll('.adv-key-result').forEach(el => {
            el.addEventListener('click', () => {
                const color = el.dataset.color;
                selectedKeyColor = color;
                window.ASAdventurer.handoff.keyColor = color;

                // Update the swatches UI
                document.querySelectorAll('#sgColorSwatches .color-swatch').forEach(s => {
                    s.classList.toggle('selected', s.dataset.color === color);
                });

                showToast(`Key color set to ${color}`, 'success');
                closeAdvancedKeyModal();
            });
        });
    }

    // --- Color Science Helpers ---
    function rgbToLab(r, g, b) {
        // sRGB → XYZ → Lab
        let rr = r / 255, gg = g / 255, bb = b / 255;
        rr = rr > 0.04045 ? Math.pow((rr + 0.055) / 1.055, 2.4) : rr / 12.92;
        gg = gg > 0.04045 ? Math.pow((gg + 0.055) / 1.055, 2.4) : gg / 12.92;
        bb = bb > 0.04045 ? Math.pow((bb + 0.055) / 1.055, 2.4) : bb / 12.92;

        let x = (rr * 0.4124 + gg * 0.3576 + bb * 0.1805) / 0.95047;
        let y = (rr * 0.2126 + gg * 0.7152 + bb * 0.0722) / 1.00000;
        let z = (rr * 0.0193 + gg * 0.1192 + bb * 0.9505) / 1.08883;

        x = x > 0.008856 ? Math.cbrt(x) : (7.787 * x) + 16 / 116;
        y = y > 0.008856 ? Math.cbrt(y) : (7.787 * y) + 16 / 116;
        z = z > 0.008856 ? Math.cbrt(z) : (7.787 * z) + 16 / 116;

        return {
            L: (116 * y) - 16,
            a: 500 * (x - y),
            b: 200 * (y - z)
        };
    }

    // Init on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initSpritePrep);
    } else {
        initSpritePrep();
    }

})();
