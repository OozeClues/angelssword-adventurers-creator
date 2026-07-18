/**
 * ⚔️ AS Adventurer — Video Generation Module
 * Angel's Sword Studios
 * 
 * Tab 2: Generate animated videos from sprite images using Google's
 * Gemini Omni Flash API (gemini-omni-flash-preview via Interactions API).
 */

(function() {
    'use strict';

    // ============================================
    // STATE
    // ============================================
    let generating = false;
    let cancelled = false;
    let referenceImages = []; // Array of { dataUrl, base64 }
    let generatedVideos = [];  // Array of { blob, url }
    let selectedVideos = new Set(); // Indices of selected videos
    let fromSpritePrep = false;

    // ============================================
    // REFERENCE IMAGE HANDLING
    // ============================================

    function loadReferenceFromHandoff() {
        const handoff = window.ASAdventurer.handoff;
        if (handoff.spriteBase64) {
            referenceImages = [{ dataUrl: handoff.spriteBase64 }];
            fromSpritePrep = true;

            // Show preview
            const preview = document.getElementById('vgRefImagePreview');
            const img = document.getElementById('vgRefImage');
            img.src = handoff.spriteBase64;
            preview.classList.remove('hidden');

            // Show "from sprite prep" indicator
            document.getElementById('vgRefFromSprite').classList.remove('hidden');
            document.getElementById('vgUploadZone').classList.add('hidden');
        }
    }

    function loadReferenceFiles(files) {
        referenceImages = [];
        fromSpritePrep = false;

        document.getElementById('vgRefFromSprite').classList.add('hidden');

        const maxFiles = Math.min(files.length, 3);
        let loaded = 0;

        for (let i = 0; i < maxFiles; i++) {
            const reader = new FileReader();
            reader.onload = (e) => {
                referenceImages.push({ dataUrl: e.target.result });
                loaded++;

                if (loaded === maxFiles) {
                    // Show first image preview
                    const preview = document.getElementById('vgRefImagePreview');
                    const img = document.getElementById('vgRefImage');
                    img.src = referenceImages[0].dataUrl;
                    preview.classList.remove('hidden');
                    showToast(`${referenceImages.length} reference image(s) loaded`, 'success');
                }
            };
            reader.readAsDataURL(files[i]);
        }
    }

    // ============================================
    // VIDEO GENERATION
    // ============================================

    async function generateVideo() {
        if (generating) return;

        const apiKey = localStorage.getItem('google_api_key');
        if (!apiKey) {
            showToast('No Google API key. Go to Settings to add one.', 'error');
            return;
        }

        if (referenceImages.length === 0) {
            showToast('Upload a reference image first, or send one from Sprite Prep', 'warning');
            return;
        }

        // Get mode early so we can validate keyframes
        const modeSelector = document.getElementById('vgModeSelector');
        const activeMode = modeSelector?.querySelector('.mode-btn.active');
        const mode = activeMode?.dataset.mode || 'reference';

        if (mode === 'keyframe' && referenceImages.length < 2) {
            showToast('Keyframe mode requires both a Start Frame and End Frame', 'warning');
            return;
        }

        // Get settings
        const duration = parseInt(document.getElementById('vgDuration')?.value || '5');
        const genCountEl = document.getElementById('vgGenCount');
        const activeBtn = genCountEl?.querySelector('.gen-count-btn.active');
        const genCount = activeBtn ? parseInt(activeBtn.dataset.count) : 1;

        // Read prompt from the correct field based on mode
        const prompt = mode === 'keyframe'
            ? (document.getElementById('vgKeyframePrompt')?.value?.trim() || '')
            : (document.getElementById('vgPrompt')?.value?.trim() || '');

        generating = true;
        cancelled = false;

        // Show progress
        document.getElementById('vgProgress').classList.add('active');
        document.getElementById('vgGenerateBtn').disabled = true;
        const status = document.getElementById('vgStatus');
        status.innerHTML = '<div class="status-msg info"><span class="spinner"></span> Generating video — this may take several minutes…</div>';

        try {
            const promises = [];
            for (let i = 0; i < genCount; i++) {
                if (cancelled) break;
                promises.push(generateOneVideo(apiKey, prompt, duration, mode));
            }

            const results = await Promise.allSettled(promises);
            generatedVideos = [];

            for (const result of results) {
                if (result.status === 'fulfilled' && result.value) {
                    generatedVideos.push(result.value);
                }
            }

            if (generatedVideos.length > 0) {
                displayVideoResults();
                window.notificationSound?.play();
                status.innerHTML = `<div class="status-msg success">✅ Generated ${generatedVideos.length} video(s)!</div>`;
            } else if (!cancelled) {
                // Collect actual error messages from failed attempts
                const errors = results
                    .filter(r => r.status === 'rejected')
                    .map(r => r.reason?.message || String(r.reason));
                const errorMsg = errors.length > 0 ? errors[0] : 'Unknown error — check the server console for details.';
                status.innerHTML = `<div class="status-msg error">❌ ${errorMsg}</div>`;
                console.error('[VideoGen] All attempts failed:', errors);
            }
        } catch (err) {
            status.innerHTML = `<div class="status-msg error">❌ ${err.message}</div>`;
        } finally {
            generating = false;
            document.getElementById('vgProgress').classList.remove('active');
            document.getElementById('vgGenerateBtn').disabled = false;
        }
    }

    async function generateOneVideo(apiKey, prompt, duration, mode) {
        // Build the Gemini Omni Flash Interactions API request
        // Docs: https://ai.google.dev/gemini-api/docs/omni
        // REST: POST https://generativelanguage.googleapis.com/v1beta/interactions?key=$API_KEY
        //
        // Text-only:  { model, input: "text string" }
        // Image+text: { model, input: [{type:"image",data:"b64",mime_type:"image/png"},{type:"text",text:"prompt"}],
        //              generation_config: { video_config: { task: "image_to_video" } } }

        const textPrompt = prompt || 'Generate a gentle breathing idle animation with slight body sway. Keep the character on the same background.';

        // Omni Flash defaults to 10s when duration is omitted.
        const seconds = Math.min(10, Math.max(3, Math.round(Number(duration) || 5)));

        const requestBody = {
            model: 'gemini-omni-flash-preview',
            // Interactions API: google-duration string on response_format (e.g. "5s")
            response_format: {
                type: 'video',
                aspect_ratio: '16:9',
                duration: `${seconds}s`
            }
        };

        // Build input — either a string (text-only) or an array (image + text)
        if (mode === 'keyframe' && referenceImages.length >= 2) {
            // Keyframe mode: Gemini Omni Flash only supports 1 image.
            // Send the start frame as the image, and incorporate the end
            // frame concept into the text prompt for motion guidance.
            const startRef = referenceImages[0];
            const startRaw = startRef.dataUrl.includes(',') ? startRef.dataUrl.split(',')[1] : startRef.dataUrl;
            const startMime = startRef.dataUrl.includes('image/png') ? 'image/png' : 'image/jpeg';

            requestBody.input = [
                { type: 'image', data: startRaw, mime_type: startMime },
                { type: 'text', text: `Starting from this image (start frame), animate the character transitioning to the end pose. The video must be exactly ${seconds} seconds long. ${textPrompt}` }
            ];
            requestBody.generation_config = {
                video_config: { task: 'image_to_video' }
            };
        } else if (referenceImages.length > 0) {
            // Reference mode: single image + prompt
            const ref = referenceImages[0];
            const raw = ref.dataUrl.includes(',') ? ref.dataUrl.split(',')[1] : ref.dataUrl;
            const mimeType = ref.dataUrl.includes('image/png') ? 'image/png' : 'image/jpeg';

            requestBody.input = [
                { type: 'image', data: raw, mime_type: mimeType },
                { type: 'text', text: `The video must be exactly ${seconds} seconds long. ${textPrompt}` }
            ];
            requestBody.generation_config = {
                video_config: { task: 'image_to_video' }
            };
        } else {
            requestBody.input = `The video must be exactly ${seconds} seconds long. ${textPrompt}`;
            requestBody.generation_config = {
                video_config: { task: 'text_to_video' }
            };
        }

        // Send through proxy
        const response = await fetch('/api/video/generate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': apiKey
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            const msg = err?.error?.message || err?.message || `API error: ${response.status}`;
            throw new Error(msg);
        }

        const data = await response.json();
        console.log('[VideoGen] Response:', JSON.stringify(data).substring(0, 500));

        // Direct response — extract video from Interactions response
        return extractVideoFromResponse(data);
    }

    async function pollOperation(apiKey, operationName) {
        const maxAttempts = 120; // 10 minutes at 5s intervals
        const pollInterval = 5000;

        for (let i = 0; i < maxAttempts; i++) {
            if (cancelled) return null;

            await new Promise(r => setTimeout(r, pollInterval));

            const fillEl = document.getElementById('vgProgressFill');
            const textEl = document.getElementById('vgProgressText');
            if (fillEl) fillEl.style.width = `${Math.min(95, (i / maxAttempts) * 100)}%`;
            if (textEl) textEl.textContent = `Generating video... (${Math.floor(i * pollInterval / 1000)}s)`;

            try {
                const resp = await fetch('/api/video/poll', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-Key': apiKey
                    },
                    body: JSON.stringify({ operationName })
                });

                const data = await resp.json();

                if (data.done || data.status === 'completed') {
                    return extractVideoFromResponse(data);
                }
            } catch (e) {
                console.warn('[VideoGen] Poll error:', e.message);
            }
        }

        throw new Error('Video generation timed out after 10 minutes');
    }

    function extractVideoFromResponse(data) {
        // Interactions API response format:
        // { steps: [
        //   { type: "user_input", content: [...] },
        //   { type: "thought", content: [...] },
        //   { type: "model_output", content: [
        //     { type: "video", mime_type: "video/mp4", data: "base64..." }
        //   ]}
        // ], id: "...", status: "completed", model: "gemini-omni-flash-preview" }

        // Pattern 1: Interactions API — steps[] with model_output
        if (data.steps && Array.isArray(data.steps)) {
            for (const step of data.steps) {
                if (step.type === 'model_output' && step.content) {
                    for (const item of step.content) {
                        if (item.type === 'video' && item.data) {
                            const mimeType = item.mime_type || 'video/mp4';
                            const blob = base64ToBlob(item.data, mimeType);
                            return { blob, url: URL.createObjectURL(blob) };
                        }
                    }
                }
            }
        }

        // Pattern 2: generateContent format (candidates/parts) — fallback
        if (data.candidates) {
            for (const candidate of data.candidates) {
                if (candidate.content?.parts) {
                    for (const part of candidate.content.parts) {
                        if (part.inlineData?.mimeType?.startsWith('video/')) {
                            const blob = base64ToBlob(part.inlineData.data, part.inlineData.mimeType);
                            return { blob, url: URL.createObjectURL(blob) };
                        }
                    }
                }
            }
        }

        // Pattern 3: Nested result (from polled operation)
        if (data.result) {
            return extractVideoFromResponse(data.result);
        }

        console.warn('[VideoGen] Could not extract video from response:', JSON.stringify(data).substring(0, 1000));
        throw new Error('No video data found in API response. Check the console for details.');
    }

    // ============================================
    // RESULTS DISPLAY
    // ============================================

    function displayVideoResults() {
        const grid = document.getElementById('vgResultsGrid');
        const section = document.getElementById('vgResultsSection');

        // Revoke any old blob URLs from previous video elements
        grid.querySelectorAll('video').forEach(v => {
            if (v.src && v.src.startsWith('blob:')) {
                v.pause();
                v.removeAttribute('src');
                v.load(); // Release the video resource
            }
        });

        grid.innerHTML = '';
        section.classList.remove('hidden');
        selectedVideos = new Set([0]); // Auto-select first

        generatedVideos.forEach((video, idx) => {
            const card = document.createElement('div');
            card.className = 'result-card' + (idx === 0 ? ' selected' : '');
            card.dataset.idx = idx;

            // Create video element properly (not via innerHTML) to ensure it loads
            const videoWrap = document.createElement('div');
            videoWrap.className = 'video-preview';
            const videoEl = document.createElement('video');
            videoEl.loop = true;
            videoEl.muted = true;
            videoEl.playsInline = true;
            videoEl.src = video.url;
            videoEl.load();
            videoWrap.appendChild(videoEl);

            const actions = document.createElement('div');
            actions.className = 'card-actions';
            actions.innerHTML = `
                <button class="btn btn-sm btn-secondary" data-action="play" data-idx="${idx}" title="Play/pause this video">▶️ Play</button>
                <button class="btn btn-sm btn-secondary" data-action="download" data-idx="${idx}" title="Download this video">💾 Save</button>
                <button class="btn btn-sm ${selectedVideos.has(idx) ? 'btn-primary' : 'btn-secondary'}" data-action="select" data-idx="${idx}" title="Select this video for the pipeline">
                    ${selectedVideos.has(idx) ? '✓ Selected' : '○ Select'}
                </button>
            `;

            card.appendChild(videoWrap);
            card.appendChild(actions);
            grid.appendChild(card);
        });
    }

    // Persistent event delegation for video results (only bound once)
    function bindVideoResultEvents() {
        const grid = document.getElementById('vgResultsGrid');
        if (!grid) return;

        grid.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const idx = parseInt(btn.dataset.idx);

            if (btn.dataset.action === 'play') {
                const video = grid.querySelectorAll('video')[idx];
                if (video) {
                    if (video.paused) { video.play(); btn.textContent = '⏸ Pause'; }
                    else { video.pause(); btn.textContent = '▶️ Play'; }
                }
            } else if (btn.dataset.action === 'download') {
                if (generatedVideos[idx]?.blob) {
                    const a = document.createElement('a');
                    a.href = generatedVideos[idx].url;
                    a.download = `${window.ASAdventurer.characterName || 'video'}_gen_${idx + 1}.mp4`;
                    a.click();
                }
            } else if (btn.dataset.action === 'select') {
                if (selectedVideos.has(idx)) {
                    selectedVideos.delete(idx);
                    btn.className = 'btn btn-sm btn-secondary';
                    btn.innerHTML = '○ Select';
                    btn.closest('.result-card').classList.remove('selected');
                } else {
                    selectedVideos.add(idx);
                    btn.className = 'btn btn-sm btn-primary';
                    btn.innerHTML = '✓ Selected';
                    btn.closest('.result-card').classList.add('selected');
                }
            }
        });
    }

    // ============================================
    // HANDOFF
    // ============================================

    function handoffToVideoPrep() {
        if (selectedVideos.size === 0) {
            showToast('Select at least one video first', 'warning');
            return;
        }

        // Send the first selected video
        const idx = Array.from(selectedVideos)[0];
        const video = generatedVideos[idx];

        if (video) {
            window.ASAdventurer.handoff.videoBlob = video.blob;
            window.ASAdventurer.handoff.videoUrl = video.url;
            showToast('Video sent to Video Preparation', 'success');
            switchTab('tab-video-prep');
        }
    }

    // ============================================
    // INITIALIZATION
    // ============================================

    function initVideoGen() {
        // Mode selector (Reference / Keyframe)
        initModeSelector('vgModeSelector', (mode) => {
            document.getElementById('vgReferenceMode').classList.toggle('hidden', mode !== 'reference');
            document.getElementById('vgKeyframeMode').classList.toggle('hidden', mode !== 'keyframe');
        });

        // Upload zone
        initUploadZone('vgUploadZone', 'vgFileInput', (files) => {
            loadReferenceFiles(files);
        });

        // Keyframe uploads
        initUploadZone('vgStartFrameZone', 'vgStartFrameInput', (files) => {
            if (files[0]) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    // Ensure start frame is first in array
                    if (referenceImages.length === 0) referenceImages.push({});
                    referenceImages[0] = { dataUrl: e.target.result };

                    // Show preview
                    const preview = document.getElementById('vgStartFramePreview');
                    preview.src = e.target.result;
                    preview.classList.remove('hidden');
                    document.getElementById('vgStartFrameIcon').textContent = '✅';
                    document.getElementById('vgStartFrameText').textContent = 'Start Frame Loaded';
                    showToast('Start frame loaded', 'success');
                };
                reader.readAsDataURL(files[0]);
            }
        });

        initUploadZone('vgEndFrameZone', 'vgEndFrameInput', (files) => {
            if (files[0]) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    if (referenceImages.length < 2) referenceImages.push({});
                    referenceImages[1] = { dataUrl: e.target.result };

                    // Show preview
                    const preview = document.getElementById('vgEndFramePreview');
                    preview.src = e.target.result;
                    preview.classList.remove('hidden');
                    document.getElementById('vgEndFrameIcon').textContent = '✅';
                    document.getElementById('vgEndFrameText').textContent = 'End Frame Loaded';
                    showToast('End frame loaded', 'success');
                };
                reader.readAsDataURL(files[0]);
            }
        });

        // Duration slider
        initRange('vgDuration', 'vgDurationVal', 's');

        // Generation count
        initGenCount('vgGenCount');

        // Generate button
        document.getElementById('vgGenerateBtn')?.addEventListener('click', generateVideo);

        // Cancel button
        document.getElementById('vgCancelBtn')?.addEventListener('click', () => {
            cancelled = true;
            showToast('Generation cancelled', 'warning');
        });

        // Handoff button
        document.getElementById('vgHandoffBtn')?.addEventListener('click', handoffToVideoPrep);

        // Bind video result events once (persistent delegation)
        bindVideoResultEvents();

        // Check for handoff from Sprite Prep when tab becomes active
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.target.classList.contains('active') && m.target.id === 'tab-video-gen') {
                    loadReferenceFromHandoff();
                }
            }
        });

        const panel = document.getElementById('tab-video-gen');
        if (panel) {
            observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
        }
    }

    // Init on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initVideoGen);
    } else {
        initVideoGen();
    }

})();
