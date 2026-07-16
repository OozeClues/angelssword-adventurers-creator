/**
 * ⚔️ AS Adventurer — Video Preparation Module
 * Angel's Sword Studios
 *
 * Ported from Fugi Maker EX Loop Builder with new video
 * concatenation / crossfade feature.
 *
 * DOM dependencies (in #tab-video-prep):
 *   Upload:    vpUploadZone, vpFileInput
 *   Canvas:    vpCanvas, vpCanvasContainer
 *   Scrubber:  vpScrubber, vpFrameInfo, vpPrevFrame, vpPlayBtn, vpNextFrame
 *   Onion:     vpOnionSkin
 *   Loop:      vpSetLoopBtn, vpClearLoopBtn, vpPreviewLoopBtn, vpLoopInfo
 *   Mode:      vpLoopMode (seg-toggle: none | pingpong | reverse)
 *   Concat:    vpAddVideoBtn, vpConcatFileInput, vpConcatInfo, vpConcatText, vpRemoveConcat
 *   Crossfade: vpCrossfade, vpCrossfadeDuration, vpCrossfadeDurationVal
 *   Handoff:   vpHandoffBtn, vpFromVideoGen
 *   Info:      vpVideoInfo
 *   Stages:    vpStage1, vpStage2, vpStage3
 */

(function () {
    'use strict';

    // ================================================================
    // STATE
    // ================================================================
    const state = {
        // Primary video
        video: null,           // <video> element (hidden, created dynamically)
        videoLoaded: false,
        duration: 0,
        videoWidth: 0,
        videoHeight: 0,
        fps: 30,
        totalFrames: 0,
        currentFrame: 0,
        frame0Image: null,     // offscreen canvas of frame 0 for onion skin

        // Playback
        isPlaying: false,
        playRAF: null,

        // Onion skin
        onionSkin: false,

        // Loop
        loopPoint: -1,
        loopMode: 'none',      // 'none' | 'pingpong' | 'reverse'

        // Preview
        previewPlaying: false,
        previewRAF: null,
        cachedFrames: null,

        // Auto frame cache (for instant scrubbing)
        frameCache: null,         // array of offscreen canvases, one per frame
        frameCacheComplete: false, // true when all frames are cached

        // Concatenation
        concatVideo: null,     // <video> element for 2nd video
        concatLoaded: false,
        concatDuration: 0,
        concatWidth: 0,
        concatHeight: 0,
        concatFps: 30,

        // Source tracking
        fromVideoGen: false,
    };

    // ================================================================
    // HELPERS
    // ================================================================

    /** Seek a video element and wait for 'seeked' event */
    function seekVideoAsync(videoEl, time, maxDuration) {
        return new Promise((resolve) => {
            const dur = maxDuration || videoEl.duration || 1;
            const targetTime = Math.min(Math.max(0, time), dur - 0.001);
            if (Math.abs(videoEl.currentTime - targetTime) < 0.001) {
                resolve();
                return;
            }
            const timeout = setTimeout(resolve, 2000);
            videoEl.addEventListener('seeked', () => {
                clearTimeout(timeout);
                resolve();
            }, { once: true });
            videoEl.currentTime = targetTime;
        });
    }

    /** Create hidden <video> element */
    function createVideoElement() {
        const v = document.createElement('video');
        v.crossOrigin = 'anonymous';
        v.playsInline = true;
        v.preload = 'auto';
        v.muted = true;
        v.style.display = 'none';
        document.body.appendChild(v);
        return v;
    }

    /** Update the sidebar video info display */
    function updateVideoInfo() {
        const el = document.getElementById('vpVideoInfo');
        if (!el) return;

        if (!state.videoLoaded) {
            el.innerHTML = '<div>No video loaded</div>';
            return;
        }

        let html = `
            <div><strong>Resolution:</strong> ${state.videoWidth} × ${state.videoHeight}</div>
            <div><strong>Duration:</strong> ${state.duration.toFixed(2)}s</div>
            <div><strong>FPS:</strong> ${state.fps}</div>
            <div><strong>Frames:</strong> ${state.totalFrames}</div>
        `;

        if (state.loopPoint >= 2) {
            const modeLabels = {
                none: 'No Loop (forward only)',
                pingpong: 'Ping-Pong (0→N→0)',
                reverse: 'Reverse (N→0)',
            };
            const outputFrames = getOutputFrameCount();
            html += `
                <hr style="border-color:rgba(255,255,255,0.1);margin:0.4rem 0">
                <div><strong>Loop Point:</strong> Frame ${state.loopPoint}</div>
                <div><strong>Mode:</strong> ${modeLabels[state.loopMode]}</div>
                <div><strong>Output Frames:</strong> ${outputFrames}</div>
            `;
        }

        if (state.concatLoaded) {
            const crossfade = document.getElementById('vpCrossfade');
            const cfDur = document.getElementById('vpCrossfadeDuration');
            html += `
                <hr style="border-color:rgba(255,255,255,0.1);margin:0.4rem 0">
                <div><strong>2nd Video:</strong> ${state.concatWidth}×${state.concatHeight}</div>
                <div><strong>2nd Duration:</strong> ${state.concatDuration.toFixed(2)}s</div>
                <div><strong>2nd FPS:</strong> ${state.concatFps}</div>
                <div><strong>Crossfade:</strong> ${crossfade?.checked ? cfDur?.value + 'ms' : 'Off'}</div>
            `;
        }

        el.innerHTML = html;
    }

    /** Get output frame count based on loop mode and loop point */
    function getOutputFrameCount() {
        if (state.loopPoint < 2) return state.totalFrames;
        const n = state.loopPoint + 1; // frames 0..loopPoint
        switch (state.loopMode) {
            case 'pingpong': return n + Math.max(0, n - 2); // 0→N→0 (no duplicate of endpoints)
            case 'reverse':  return n;                       // N→0
            case 'none':
            default:         return n;                       // 0→N
        }
    }

    // ================================================================
    // CORE: LOAD VIDEO
    // ================================================================

    async function loadVideo(file) {
        // Clean up previous
        stopPreview();
        pauseVideo();
        state.frameCache = null;
        state.frameCacheComplete = false;

        // Create or reuse video element
        if (state.video) {
            URL.revokeObjectURL(state.video.src);
            state.video.remove();
        }
        const video = createVideoElement();
        video.src = URL.createObjectURL(file);

        // Wait for metadata
        await new Promise((resolve, reject) => {
            video.onloadedmetadata = resolve;
            video.onerror = () => reject(new Error('Failed to load video'));
        });

        state.video = video;
        state.duration = video.duration;
        state.videoWidth = video.videoWidth;
        state.videoHeight = video.videoHeight;

        // ── FPS Detection ──
        let fps = 30;
        if (typeof video.getVideoPlaybackQuality === 'function') {
            video.playbackRate = 4;
            video.play();
            await new Promise(r => setTimeout(r, 500));
            const q = video.getVideoPlaybackQuality();
            if (q.totalVideoFrames > 0) {
                fps = Math.round(q.totalVideoFrames / (video.currentTime || 0.5));
            }
            video.pause();
            video.playbackRate = 1;
            video.currentTime = 0;
        }
        // Validate
        if (fps < 10 || fps > 120) fps = 30;
        state.fps = fps;
        state.totalFrames = Math.round(state.duration * fps);

        // ── Setup canvas ──
        const canvas = document.getElementById('vpCanvas');
        canvas.width = state.videoWidth;
        canvas.height = state.videoHeight;

        // ── Setup persistent seeked listener ──
        video.addEventListener('seeked', () => {
            if (state.isPlaying) return; // don't interfere with native playback
            const cvs = document.getElementById('vpCanvas');
            const ctx = cvs.getContext('2d');
            ctx.drawImage(video, 0, 0, cvs.width, cvs.height);
            // Onion skin: overlay frame 0 at 50% opacity
            if (state.onionSkin && state.frame0Image && state.currentFrame > 0) {
                ctx.globalAlpha = 0.5;
                ctx.drawImage(state.frame0Image, 0, 0, cvs.width, cvs.height);
                ctx.globalAlpha = 1.0;
            }
        });

        // ── Setup scrubber ──
        const scrubber = document.getElementById('vpScrubber');
        scrubber.max = state.totalFrames - 1;
        scrubber.value = 0;

        // ── Enable Stage 2 ──
        document.getElementById('vpStage2').classList.remove('disabled');
        state.videoLoaded = true;

        // ── Show first frame ──
        await seekVideoAsync(video, 0);
        // Explicitly draw frame 0 to canvas (seekToFrame may no-op if
        // video is already at 0 and no cache exists yet)
        {
            const cvs = document.getElementById('vpCanvas');
            const ctx = cvs.getContext('2d');
            ctx.drawImage(video, 0, 0, cvs.width, cvs.height);
        }
        seekToFrame(0);

        // ── Capture frame 0 for onion skin ──
        await new Promise(r => requestAnimationFrame(r));
        {
            const srcCanvas = document.getElementById('vpCanvas');
            const captureCanvas = document.createElement('canvas');
            captureCanvas.width = state.videoWidth;
            captureCanvas.height = state.videoHeight;
            captureCanvas.getContext('2d').drawImage(srcCanvas, 0, 0, state.videoWidth, state.videoHeight);
            state.frame0Image = captureCanvas;
        }

        // ── Default loop point to full video ──
        state.currentFrame = state.totalFrames - 1;
        setLoopPoint();
        state.currentFrame = 0;
        seekToFrame(0);

        // ── Enable Stage 3 ──
        document.getElementById('vpStage3').classList.remove('disabled');

        updateVideoInfo();
        window.showToast(`Video loaded: ${state.totalFrames} frames @ ${fps}fps`, 'success');

        // ── Auto-cache frames for instant scrubbing ──
        autoCacheFrames();
    }

    /** Load from handoff blob (Generate Video tab) */
    async function loadFromHandoff() {
        const handoff = window.ASAdventurer.handoff;
        if (!handoff.videoBlob && !handoff.videoUrl) return;

        const file = handoff.videoBlob
            ? new File([handoff.videoBlob], 'generated.mp4', { type: handoff.videoBlob.type || 'video/mp4' })
            : null;

        if (file) {
            state.fromVideoGen = true;
            document.getElementById('vpFromVideoGen').classList.remove('hidden');
            await loadVideo(file);
        } else if (handoff.videoUrl) {
            // Fetch from URL → Blob → File
            try {
                const resp = await fetch(handoff.videoUrl);
                const blob = await resp.blob();
                const f = new File([blob], 'generated.mp4', { type: blob.type || 'video/mp4' });
                state.fromVideoGen = true;
                document.getElementById('vpFromVideoGen').classList.remove('hidden');
                await loadVideo(f);
            } catch (err) {
                window.showToast('Failed to load video from Generate tab: ' + err.message, 'error');
            }
        }
    }

    // ================================================================
    // CORE: AUTO-CACHE FRAMES (for instant scrubbing)
    // ================================================================

    async function autoCacheFrames() {
        if (!state.videoLoaded || state.totalFrames < 2) return;

        const video = state.video;
        const cw = state.videoWidth, ch = state.videoHeight;
        const total = state.totalFrames;
        state.frameCache = new Array(total).fill(null);
        state.frameCacheComplete = false;

        const infoEl = document.getElementById('vpFrameInfo');
        const origText = infoEl.textContent;

        // Cache frame by frame via seeking
        for (let i = 0; i < total; i++) {
            if (!state.videoLoaded) break; // Video changed, abort

            const time = Math.min(i / state.fps, state.duration - 0.001);
            video.currentTime = time;
            await new Promise(r => video.addEventListener('seeked', r, { once: true }));

            const fc = document.createElement('canvas');
            fc.width = cw; fc.height = ch;
            fc.getContext('2d').drawImage(video, 0, 0, cw, ch);
            state.frameCache[i] = fc;

            // Progress update every 5 frames
            if (i % 5 === 0 || i === total - 1) {
                infoEl.textContent = `Caching: ${i + 1} / ${total}`;
            }
        }

        state.frameCacheComplete = true;
        infoEl.textContent = origText;
        // Restore current frame display
        seekToFrame(state.currentFrame);
        window.showToast(`${total} frames cached — scrubbing is now instant`, 'success');
    }

    // ================================================================
    // CORE: SEEK & FRAME NAVIGATION
    // ================================================================

    function seekToFrame(frameIdx) {
        if (!state.videoLoaded) return;
        const time = Math.min(frameIdx / state.fps, state.duration - 0.001);

        // Update scrubber and info
        const info = document.getElementById('vpFrameInfo');
        info.textContent = `Frame ${frameIdx} / ${state.totalFrames - 1} (${time.toFixed(2)}s)`;
        document.getElementById('vpScrubber').value = frameIdx;

        // Use cached frame if available (instant, no video seek needed)
        if (state.frameCache && state.frameCache[frameIdx]) {
            const cvs = document.getElementById('vpCanvas');
            const ctx = cvs.getContext('2d');
            ctx.drawImage(state.frameCache[frameIdx], 0, 0, cvs.width, cvs.height);
            // Onion skin overlay
            if (state.onionSkin && state.frame0Image && frameIdx > 0) {
                ctx.globalAlpha = 0.5;
                ctx.drawImage(state.frame0Image, 0, 0, cvs.width, cvs.height);
                ctx.globalAlpha = 1.0;
            }
            return;
        }

        // Fallback: seek video (slower, used before cache is ready)
        state.video.currentTime = time;
    }

    function prevFrame() {
        pauseVideo();
        stopPreview();
        if (state.currentFrame > 0) {
            state.currentFrame--;
            seekToFrame(state.currentFrame);
        }
    }

    function nextFrame() {
        pauseVideo();
        stopPreview();
        if (state.currentFrame < state.totalFrames - 1) {
            state.currentFrame++;
            seekToFrame(state.currentFrame);
        }
    }

    // ================================================================
    // CORE: PLAY / PAUSE
    // ================================================================

    function playVideo() {
        if (!state.videoLoaded) return;
        const video = state.video;
        state.isPlaying = true;
        document.getElementById('vpPlayBtn').textContent = '⏸';
        document.getElementById('vpPlayBtn').title = 'Pause video';

        video.play();

        const renderFrame = () => {
            if (!state.isPlaying) return;

            const canvas = document.getElementById('vpCanvas');
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            // Update timeline and frame counter
            const frame = Math.round(video.currentTime * state.fps);
            state.currentFrame = Math.min(frame, state.totalFrames - 1);
            document.getElementById('vpScrubber').value = state.currentFrame;
            document.getElementById('vpFrameInfo').textContent =
                `Frame ${state.currentFrame} / ${state.totalFrames - 1} (${video.currentTime.toFixed(2)}s)`;

            // Stop at end
            if (video.ended || video.paused) {
                pauseVideo();
                return;
            }

            state.playRAF = requestAnimationFrame(renderFrame);
        };
        state.playRAF = requestAnimationFrame(renderFrame);
    }

    function pauseVideo() {
        if (!state.videoLoaded) return;
        state.isPlaying = false;
        if (state.video && !state.video.paused) state.video.pause();
        if (state.playRAF) {
            cancelAnimationFrame(state.playRAF);
            state.playRAF = null;
        }
        const btn = document.getElementById('vpPlayBtn');
        if (btn) {
            btn.textContent = '▶️';
            btn.title = 'Play video';
        }
    }

    // ================================================================
    // CORE: LOOP POINT
    // ================================================================

    function setLoopPoint() {
        if (!state.videoLoaded || state.currentFrame < 2) {
            window.showToast('Move to at least frame 2 to set a loop point', 'error');
            return;
        }
        state.loopPoint = state.currentFrame;

        let totalOutput, loopLabel;
        switch (state.loopMode) {
            case 'reverse':
                totalOutput = state.loopPoint + 1;
                loopLabel = `Reverse: ${state.loopPoint} → 0`;
                break;
            case 'pingpong':
                totalOutput = state.loopPoint * 2;
                loopLabel = `Ping-Pong: 0 → ${state.loopPoint} → 0`;
                break;
            case 'none':
            default:
                totalOutput = state.loopPoint + 1;
                loopLabel = `Forward: 0 → ${state.loopPoint}`;
                break;
        }

        const loopInfo = document.getElementById('vpLoopInfo');
        loopInfo.textContent = `${loopLabel} · ${totalOutput} output frames`;

        document.getElementById('vpPreviewLoopBtn').disabled = false;
        document.getElementById('vpClearLoopBtn').disabled = false;

        updateVideoInfo();
        window.showToast(`Loop set at frame ${state.loopPoint}! Preview it, then send to Model Exporter.`, 'success');
    }

    function clearLoop() {
        stopPreview();
        state.loopPoint = -1;

        const loopInfo = document.getElementById('vpLoopInfo');
        loopInfo.textContent = '';

        document.getElementById('vpPreviewLoopBtn').disabled = true;
        document.getElementById('vpClearLoopBtn').disabled = true;

        updateVideoInfo();
        window.showToast('Loop point cleared', 'info');
    }

    // ================================================================
    // CORE: PREVIEW LOOP
    // ================================================================

    async function previewLoop() {
        if (state.loopPoint < 2) return;
        state.previewPlaying = true;
        pauseVideo();
        document.getElementById('vpPreviewLoopBtn').textContent = '⏸ Stop Preview';

        const video = state.video;
        const canvas = document.getElementById('vpCanvas');
        const ctx = canvas.getContext('2d');
        const loopPoint = state.loopPoint;
        const loopTime = loopPoint / state.fps;
        const cw = canvas.width, ch = canvas.height;
        const minGap = 0.8 / state.fps;

        // ── Phase 1: Cache frames at 3× speed ──
        document.getElementById('vpFrameInfo').textContent = 'Caching frames...';
        state.cachedFrames = [];
        let lastCaptureTime = -1;

        video.currentTime = 0;
        await new Promise(r => video.addEventListener('seeked', r, { once: true }));
        video.playbackRate = 3;
        video.play();

        await new Promise((resolve) => {
            const captureFrame = () => {
                if (!state.previewPlaying) {
                    video.pause(); video.playbackRate = 1; resolve(); return;
                }
                if (video.currentTime >= loopTime || video.ended || video.paused) {
                    video.pause(); video.playbackRate = 1; resolve(); return;
                }

                // Only capture if enough video time has passed
                if (video.currentTime - lastCaptureTime >= minGap) {
                    lastCaptureTime = video.currentTime;
                    const fc = document.createElement('canvas');
                    fc.width = cw; fc.height = ch;
                    fc.getContext('2d').drawImage(video, 0, 0, cw, ch);
                    state.cachedFrames.push(fc);
                    // Show live preview during caching
                    ctx.drawImage(video, 0, 0, cw, ch);
                    document.getElementById('vpFrameInfo').textContent =
                        `Caching frame ${state.cachedFrames.length}...`;
                }
                requestAnimationFrame(captureFrame);
            };
            requestAnimationFrame(captureFrame);
        });

        video.playbackRate = 1;
        const frames = state.cachedFrames;

        if (!state.previewPlaying || frames.length < 3) {
            stopPreview();
            return;
        }

        // ── Phase 2: Build playback sequence based on mode ──
        const sequence = [];
        switch (state.loopMode) {
            case 'pingpong':
                // 0 → N → 0
                for (let i = 0; i < frames.length; i++) sequence.push(i);
                for (let i = frames.length - 2; i >= 1; i--) sequence.push(i);
                break;
            case 'reverse':
                // N → 0
                for (let i = frames.length - 1; i >= 0; i--) sequence.push(i);
                break;
            case 'none':
            default:
                // 0 → N
                for (let i = 0; i < frames.length; i++) sequence.push(i);
                break;
        }

        let idx = 0;
        const frameDelay = (loopTime * 1000) / frames.length;
        let lastFrameTime = performance.now();

        const playSequence = (now) => {
            if (!state.previewPlaying) return;

            const elapsed = now - lastFrameTime;
            if (elapsed >= frameDelay) {
                lastFrameTime = now - (elapsed % frameDelay);

                ctx.drawImage(frames[sequence[idx]], 0, 0);

                // Map index back to video frame for UI
                const videoFrame = Math.round((sequence[idx] / (frames.length - 1)) * loopPoint);
                const dirLabel = state.loopMode === 'reverse' ? '←' :
                    (state.loopMode === 'pingpong' && idx >= frames.length) ? '←' : '→';
                document.getElementById('vpFrameInfo').textContent =
                    `Preview ${dirLabel} frame ${videoFrame} / ${loopPoint}`;
                document.getElementById('vpScrubber').value = videoFrame;

                idx = (idx + 1) % sequence.length;
            }

            state.previewRAF = requestAnimationFrame(playSequence);
        };
        state.previewRAF = requestAnimationFrame(playSequence);
    }

    function stopPreview() {
        state.previewPlaying = false;
        if (state.previewRAF) {
            cancelAnimationFrame(state.previewRAF);
            state.previewRAF = null;
        }
        // Clean up cached canvases
        state.cachedFrames = null;
        if (state.video && !state.video.paused) state.video.pause();
        const btn = document.getElementById('vpPreviewLoopBtn');
        if (btn) btn.textContent = '▶ Preview Loop';
    }

    // ================================================================
    // NEW: VIDEO CONCATENATION
    // ================================================================

    async function loadConcatVideo(file) {
        // Remove previous
        removeConcatVideo(true);

        const video = createVideoElement();
        video.src = URL.createObjectURL(file);

        await new Promise((resolve, reject) => {
            video.onloadedmetadata = resolve;
            video.onerror = () => reject(new Error('Failed to load second video'));
        });

        state.concatVideo = video;
        state.concatLoaded = true;
        state.concatDuration = video.duration;
        state.concatWidth = video.videoWidth;
        state.concatHeight = video.videoHeight;

        // Detect FPS for 2nd video
        let fps = 30;
        if (typeof video.getVideoPlaybackQuality === 'function') {
            video.playbackRate = 4;
            video.play();
            await new Promise(r => setTimeout(r, 500));
            const q = video.getVideoPlaybackQuality();
            if (q.totalVideoFrames > 0) {
                fps = Math.round(q.totalVideoFrames / (video.currentTime || 0.5));
            }
            video.pause();
            video.playbackRate = 1;
            video.currentTime = 0;
        }
        if (fps < 10 || fps > 120) fps = 30;
        state.concatFps = fps;

        // Update UI
        document.getElementById('vpConcatText').textContent =
            `2nd video: ${state.concatWidth}×${state.concatHeight}, ${state.concatDuration.toFixed(2)}s @ ${fps}fps`;
        document.getElementById('vpConcatInfo').classList.remove('hidden');

        updateVideoInfo();
        window.showToast(`2nd video loaded: ${state.concatDuration.toFixed(2)}s @ ${fps}fps`, 'success');
    }

    function removeConcatVideo(silent) {
        if (state.concatVideo) {
            URL.revokeObjectURL(state.concatVideo.src);
            state.concatVideo.remove();
            state.concatVideo = null;
        }
        state.concatLoaded = false;
        state.concatDuration = 0;
        state.concatWidth = 0;
        state.concatHeight = 0;

        document.getElementById('vpConcatInfo').classList.add('hidden');
        document.getElementById('vpCrossfade').checked = false;

        updateVideoInfo();
        if (!silent) window.showToast('2nd video removed', 'info');
    }

    // ================================================================
    // NEW: CROSSFADE PREVIEW HELPERS
    // ================================================================

    /**
     * Build a crossfade sequence between the cached frames of
     * video 1 (tail) and video 2 (head).
     * Returns an array of canvases blending from v1→v2.
     *
     * @param {HTMLCanvasElement[]} v1Frames - last N frames of video 1
     * @param {HTMLCanvasElement[]} v2Frames - first N frames of video 2
     * @param {number} w - canvas width
     * @param {number} h - canvas height
     */
    function buildCrossfadeFrames(v1Frames, v2Frames, w, h) {
        const count = Math.min(v1Frames.length, v2Frames.length);
        const result = [];
        for (let i = 0; i < count; i++) {
            const t = i / (count - 1); // 0 → 1
            const fc = document.createElement('canvas');
            fc.width = w; fc.height = h;
            const ctx = fc.getContext('2d');
            // Draw video 1 frame
            ctx.globalAlpha = 1 - t;
            ctx.drawImage(v1Frames[i], 0, 0, w, h);
            // Draw video 2 frame on top
            ctx.globalAlpha = t;
            ctx.drawImage(v2Frames[i], 0, 0, w, h);
            ctx.globalAlpha = 1.0;
            result.push(fc);
        }
        return result;
    }

    // ================================================================
    // HANDOFF: SEND TO MODEL EXPORTER
    // ================================================================

    function sendToExporter() {
        if (!state.videoLoaded) {
            window.showToast('Load a video first', 'error');
            return;
        }

        stopPreview();
        pauseVideo();

        const crossfadeEnabled = state.concatLoaded &&
            document.getElementById('vpCrossfade')?.checked;
        const crossfadeDuration = crossfadeEnabled
            ? parseInt(document.getElementById('vpCrossfadeDuration')?.value || '300')
            : 0;

        // Pack handoff data
        window.ASAdventurer.handoff.videoPrepData = {
            // Primary video
            videoSrc: state.video.src,
            videoWidth: state.videoWidth,
            videoHeight: state.videoHeight,
            duration: state.duration,
            fps: state.fps,
            totalFrames: state.totalFrames,

            // Loop config
            loopMode: state.loopMode,
            loopPoint: state.loopPoint,
            outputFrameCount: getOutputFrameCount(),

            // Concatenation
            concat: state.concatLoaded ? {
                videoSrc: state.concatVideo.src,
                videoWidth: state.concatWidth,
                videoHeight: state.concatHeight,
                duration: state.concatDuration,
                fps: state.concatFps,
                crossfade: crossfadeEnabled,
                crossfadeDuration: crossfadeDuration,
            } : null,
        };

        window.showToast('Video data sent to Model Exporter!', 'success');
        window.switchTab('tab-exporter');
    }

    // ================================================================
    // CLEAR / RESET
    // ================================================================

    function clearAll() {
        stopPreview();
        pauseVideo();
        removeConcatVideo(true);

        state.videoLoaded = false;
        state.loopPoint = -1;
        state.currentFrame = 0;
        state.onionSkin = false;
        state.fromVideoGen = false;

        if (state.video) {
            URL.revokeObjectURL(state.video.src);
            state.video.remove();
            state.video = null;
        }
        state.frame0Image = null;

        // Reset UI
        document.getElementById('vpFileInput').value = '';
        document.getElementById('vpFromVideoGen').classList.add('hidden');
        document.getElementById('vpStage2').classList.add('disabled');
        document.getElementById('vpStage3').classList.add('disabled');
        document.getElementById('vpLoopInfo').textContent = '';
        document.getElementById('vpPreviewLoopBtn').disabled = true;
        document.getElementById('vpClearLoopBtn').disabled = true;
        document.getElementById('vpHandoffBtn').disabled = true;
        document.getElementById('vpFrameInfo').textContent = '0 / 0';
        document.getElementById('vpScrubber').value = 0;
        document.getElementById('vpScrubber').max = 100;
        document.getElementById('vpOnionSkin').checked = false;

        // Clear canvas
        const canvas = document.getElementById('vpCanvas');
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        updateVideoInfo();
        window.showToast('Video cleared', 'info');
    }

    // ================================================================
    // INIT — BIND ALL EVENTS
    // ================================================================

    function init() {
        // ── Upload Zone ──
        window.initUploadZone('vpUploadZone', 'vpFileInput', (files) => {
            const f = files[0];
            if (f && f.type.startsWith('video/')) {
                loadVideo(f);
            } else {
                window.showToast('Please select a video file (MP4, WebM, MOV)', 'error');
            }
        });

        // ── Scrubber ──
        document.getElementById('vpScrubber').addEventListener('input', (e) => {
            pauseVideo();
            state.currentFrame = parseInt(e.target.value);
            seekToFrame(state.currentFrame);
        });

        // ── Frame Navigation ──
        document.getElementById('vpPrevFrame').addEventListener('click', prevFrame);
        document.getElementById('vpNextFrame').addEventListener('click', nextFrame);

        // ── Play / Pause ──
        document.getElementById('vpPlayBtn').addEventListener('click', () => {
            if (state.isPlaying) pauseVideo();
            else playVideo();
        });

        // ── Onion Skin ──
        document.getElementById('vpOnionSkin').addEventListener('change', (e) => {
            state.onionSkin = e.target.checked;
            if (state.videoLoaded) seekToFrame(state.currentFrame);
        });

        // ── Loop Point ──
        document.getElementById('vpSetLoopBtn').addEventListener('click', setLoopPoint);
        document.getElementById('vpClearLoopBtn').addEventListener('click', clearLoop);
        document.getElementById('vpPreviewLoopBtn').addEventListener('click', () => {
            if (state.previewPlaying) stopPreview();
            else previewLoop();
        });

        // Disable loop buttons initially
        document.getElementById('vpPreviewLoopBtn').disabled = true;
        document.getElementById('vpClearLoopBtn').disabled = true;

        // ── Loop Mode (seg-toggle) ──
        window.initModeSelector('vpLoopMode', (mode) => {
            state.loopMode = mode;
            // Re-calculate loop info if we have a point set
            if (state.loopPoint >= 2) {
                // Temporarily set currentFrame to loopPoint to recalculate
                const saved = state.currentFrame;
                state.currentFrame = state.loopPoint;
                setLoopPoint();
                state.currentFrame = saved;
            }
            updateVideoInfo();
        });

        // ── Concatenation ──
        document.getElementById('vpAddVideoBtn').addEventListener('click', () => {
            document.getElementById('vpConcatFileInput').click();
        });

        document.getElementById('vpConcatFileInput').addEventListener('change', (e) => {
            const f = e.target.files[0];
            if (f && f.type.startsWith('video/')) {
                loadConcatVideo(f);
            } else if (f) {
                window.showToast('Please select a video file', 'error');
            }
            e.target.value = ''; // reset so same file can be re-selected
        });

        document.getElementById('vpRemoveConcat').addEventListener('click', () => {
            removeConcatVideo(false);
        });

        // ── Crossfade controls ──
        document.getElementById('vpCrossfade').addEventListener('change', () => {
            updateVideoInfo();
        });

        window.initRange('vpCrossfadeDuration', 'vpCrossfadeDurationVal', 'ms');

        document.getElementById('vpCrossfadeDuration').addEventListener('input', () => {
            updateVideoInfo();
        });

        // ── Handoff Button ──
        document.getElementById('vpHandoffBtn').addEventListener('click', sendToExporter);

        // ── Check for incoming handoff ──
        // If another tab set videoBlob/videoUrl before we loaded, pick it up
        const handoff = window.ASAdventurer.handoff;
        if (handoff.videoBlob || handoff.videoUrl) {
            loadFromHandoff();
        }

        // Also listen for future handoffs (e.g., if Generate Video sets data after this init)
        // We use a setter on the handoff object to detect changes
        let _videoBlob = handoff.videoBlob;
        Object.defineProperty(handoff, 'videoBlob', {
            get() { return _videoBlob; },
            set(val) {
                _videoBlob = val;
                if (val) {
                    // Auto-switch to Video Prep and load
                    window.switchTab('tab-video-prep');
                    loadFromHandoff();
                }
            },
            configurable: true,
        });

        console.log('🎬 Video Prep module initialized');
    }

    // ── Bootstrap ──
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
