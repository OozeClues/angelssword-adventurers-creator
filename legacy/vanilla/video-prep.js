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
        cacheGeneration: 0,       // bumps on load so in-flight cache aborts

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

    /**
     * Seek and wait until the decoder has actually presented the new frame.
     * @param {boolean} [force] When true, always perform a real seek even if
     *   currentTime is already near the target. Firefox often updates
     *   currentTime to 0 before the painted frame has changed after playback.
     */
    async function seekVideoAsync(videoEl, time, maxDuration, force) {
        const dur = maxDuration || videoEl.duration || 1;
        const targetTime = Math.min(Math.max(0, time), Math.max(dur - 0.001, 0));

        const waitSeeked = () => new Promise((resolve) => {
            const timeout = setTimeout(resolve, 2000);
            videoEl.addEventListener('seeked', () => {
                clearTimeout(timeout);
                resolve();
            }, { once: true });
        });

        if (!force && Math.abs(videoEl.currentTime - targetTime) < 0.001 && !videoEl.seeking) {
            return;
        }

        // Nudge away first so seeked is guaranteed for the real target (Firefox).
        if (force && Math.abs(videoEl.currentTime - targetTime) < 0.001) {
            const eps = Math.min(0.05, Math.max(dur * 0.25, 0.001));
            const alt = targetTime + eps <= dur - 0.001
                ? targetTime + eps
                : Math.max(0, targetTime - eps);
            if (Math.abs(alt - targetTime) >= 0.0005) {
                const nudged = waitSeeked();
                videoEl.currentTime = alt;
                await nudged;
            }
        }

        const done = waitSeeked();
        videoEl.currentTime = targetTime;
        await done;
    }

    /** Snapshot the currently decoded video frame into an offscreen canvas. */
    function snapshotVideoFrame(videoEl, width, height) {
        const capture = document.createElement('canvas');
        capture.width = width;
        capture.height = height;
        const ctx = capture.getContext('2d', { alpha: false });
        if (ctx) ctx.drawImage(videoEl, 0, 0, width, height);
        return capture;
    }

    const FPS_CANDIDATES = [12, 15, 18, 20, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];

    function snapFps(raw) {
        if (!Number.isFinite(raw) || raw < 5 || raw > 120) return 30;
        let best = raw;
        let bestRel = Infinity;
        for (const c of FPS_CANDIDATES) {
            const rel = Math.abs(raw - c) / c;
            if (rel < bestRel) { bestRel = rel; best = c; }
        }
        const snapped = bestRel <= 0.06 ? best : Math.round(raw);
        if (Math.abs(snapped - Math.round(snapped)) < 0.02) return Math.round(snapped);
        return Math.round(snapped * 1000) / 1000;
    }

    /**
     * Measure fps via requestVideoFrameCallback frame intervals (not a short 4×
     * playbackQuality sample, which drops frames and mis-detects 24 vs 25).
     */
    async function detectVideoTiming(video) {
        const duration = video.duration > 0 && Number.isFinite(video.duration) ? video.duration : 0;

        if (video.readyState < 3) {
            await new Promise((resolve) => {
                const done = () => { video.removeEventListener('canplay', done); resolve(); };
                video.addEventListener('canplay', done);
                setTimeout(done, 4000);
            });
        }

        const intervals = [];
        let lastMediaTime = -1;

        if (typeof video.requestVideoFrameCallback === 'function' && duration > 0) {
            await seekVideoAsync(video, 0, duration, true);
            await new Promise((resolve) => {
                const maxSamples = 60;
                const maxWallMs = 2800;
                const startWall = performance.now();
                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    video.pause();
                    video.playbackRate = 1;
                    resolve();
                };
                const onFrame = (_now, meta) => {
                    if (settled) return;
                    const t = (meta && meta.mediaTime != null) ? meta.mediaTime : video.currentTime;
                    if (lastMediaTime >= 0 && t > lastMediaTime + 1e-5) intervals.push(t - lastMediaTime);
                    if (t >= lastMediaTime) lastMediaTime = t;
                    if (intervals.length >= maxSamples || performance.now() - startWall > maxWallMs ||
                        t >= duration - 0.04 || video.ended) {
                        finish();
                        return;
                    }
                    video.requestVideoFrameCallback(onFrame);
                };
                video.playbackRate = 1;
                video.requestVideoFrameCallback(onFrame);
                video.play().catch(() => finish());
                setTimeout(finish, maxWallMs + 500);
            });
        }

        if (intervals.length < 6 && typeof video.getVideoPlaybackQuality === 'function' && duration > 0) {
            await seekVideoAsync(video, 0, duration, true);
            const q0 = video.getVideoPlaybackQuality();
            const t0 = video.currentTime;
            video.playbackRate = 1;
            video.play();
            await new Promise((r) => setTimeout(r, 1500));
            video.pause();
            const q1 = video.getVideoPlaybackQuality();
            const t1 = video.currentTime;
            const dt = Math.max(1e-3, t1 - t0);
            const df = (q1.totalVideoFrames || 0) - (q0.totalVideoFrames || 0);
            if (df >= 4) intervals.push(dt / df);
        }

        video.pause();
        video.playbackRate = 1;

        let fps = 30;
        if (intervals.length >= 3) {
            const sorted = intervals.slice().sort((a, b) => a - b);
            const mid = sorted[Math.floor(sorted.length / 2)];
            fps = snapFps(mid > 1e-6 ? 1 / mid : 30);
        } else if (intervals.length > 0) {
            const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
            fps = snapFps(avg > 1e-6 ? 1 / avg : 30);
        }
        if (fps < 8 || fps > 120) fps = 30;

        let totalFrames = 1;
        if (duration > 0 && fps > 0) {
            totalFrames = Math.max(1, Math.round(duration * fps));
            const maxByDuration = Math.max(1, Math.floor(duration * fps - 1e-6) + 1);
            totalFrames = Math.max(totalFrames, maxByDuration);
            while (totalFrames > 1 && (totalFrames - 1) / fps >= duration - 0.0005) {
                totalFrames--;
            }
        }
        return { fps, totalFrames, duration };
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
        state.cacheGeneration++;
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
        state.videoWidth = video.videoWidth;
        state.videoHeight = video.videoHeight;

        // Robust fps / frame-count (rvfc intervals + snap). Avoids 4× quality sample.
        const timing = await detectVideoTiming(video);
        state.duration = timing.duration || video.duration;
        state.fps = timing.fps;
        state.totalFrames = timing.totalFrames;
        const fps = timing.fps;

        // ── Setup canvas ──
        const canvas = document.getElementById('vpCanvas');
        canvas.width = state.videoWidth;
        canvas.height = state.videoHeight;

        // ── Setup persistent seeked listener ──
        video.addEventListener('seeked', () => {
            if (state.isPlaying || state.frameCache && !state.frameCacheComplete) return;
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

        // ── Force a real decode of frame 0 (critical after FPS-detection play) ──
        await seekVideoAsync(video, 0, state.duration, true);
        {
            const cvs = document.getElementById('vpCanvas');
            const ctx = cvs.getContext('2d');
            ctx.drawImage(video, 0, 0, cvs.width, cvs.height);
        }
        seekToFrame(0);

        // Capture onion-skin ghost directly from the video after seeked.
        state.frame0Image = snapshotVideoFrame(video, state.videoWidth, state.videoHeight);

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

    /**
     * Cache every frame for instant scrubbing.
     *
     * Play-through + requestVideoFrameCallback (rAF fallback). Uses stall-based
     * timeouts, multi-pass resume from first missing frame, then seek only for
     * leftover holes. Nearest-fill is a last touch for tiny residual gaps.
     */
    async function autoCacheFrames() {
        if (!state.videoLoaded || state.totalFrames < 2 || !state.video) return;

        const gen = ++state.cacheGeneration;
        const video = state.video;
        const cw = state.videoWidth, ch = state.videoHeight;
        const total = state.totalFrames;
        const fps = state.fps;
        const duration = state.duration;
        state.frameCache = new Array(total).fill(null);
        state.frameCacheComplete = false;

        const infoEl = document.getElementById('vpFrameInfo');
        const origText = infoEl ? infoEl.textContent : '';
        let uniqueCaptured = 0;

        const captureToCache = (idx) => {
            if (!state.frameCache || state.frameCache[idx]) return false;
            const fc = snapshotVideoFrame(video, cw, ch);
            state.frameCache[idx] = fc;
            if (idx === 0) state.frame0Image = fc;
            uniqueCaptured++;
            return true;
        };

        const stillActive = () =>
            gen === state.cacheGeneration && state.videoLoaded && state.video === video;

        const reportProgress = (hintIdx) => {
            if (!infoEl) return;
            const n = hintIdx != null ? Math.max(hintIdx + 1, uniqueCaptured) : uniqueCaptured;
            infoEl.textContent = `Caching: ${Math.min(n, total)} / ${total}`;
        };

        const firstMissing = () => {
            if (!state.frameCache) return total;
            for (let i = 0; i < total; i++) {
                if (!state.frameCache[i]) return i;
            }
            return total;
        };

        const playThroughFrom = (startIdx, rate) => new Promise((resolve) => {
            let settled = false;
            let lastProgressAt = performance.now();
            let lastMediaTime = -1;

            const finish = () => {
                if (settled) return;
                settled = true;
                video.pause();
                video.playbackRate = 1;
                video.removeEventListener('ended', onEnded);
                clearInterval(stallWatch);
                resolve();
            };

            const onEnded = () => finish();
            video.addEventListener('ended', onEnded);

            const hardDeadline = performance.now() + duration * 1000 + 15000;
            const stallWatch = setInterval(() => {
                if (!stillActive()) { finish(); return; }
                const now = performance.now();
                if (now - lastProgressAt > 3000 || now > hardDeadline) finish();
            }, 500);

            const onFrame = (_now, meta) => {
                if (settled || !stillActive()) { finish(); return; }

                const t = (meta && meta.mediaTime != null) ? meta.mediaTime : video.currentTime;
                if (t > lastMediaTime + 0.0005) {
                    lastMediaTime = t;
                    lastProgressAt = performance.now();
                }

                const idx = Math.min(total - 1, Math.max(0, Math.round(t * fps)));
                if (captureToCache(idx)) reportProgress(idx);
                else if (idx % 10 === 0) reportProgress(idx);

                const canvas = document.getElementById('vpCanvas');
                if (canvas) {
                    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                }

                if (video.ended || t >= duration - 1 / fps || idx >= total - 1) {
                    finish();
                    return;
                }

                scheduleNext();
            };

            const scheduleNext = () => {
                if (settled || !stillActive()) return;
                if (typeof video.requestVideoFrameCallback === 'function') {
                    video.requestVideoFrameCallback(onFrame);
                } else {
                    requestAnimationFrame((now) => onFrame(now));
                }
            };

            video.playbackRate = rate;
            scheduleNext();
            video.play().catch(() => finish());
        });

        // Multi-pass play-through from each remaining hole
        let pass = 0;
        while (stillActive() && firstMissing() < total && pass < 6) {
            const startIdx = firstMissing();
            const startTime = Math.min(startIdx / fps, duration - 0.001);
            await seekVideoAsync(video, startTime, duration);
            if (!stillActive()) return;

            const rate = pass === 0 ? 1 : Math.min(2, Math.max(1, 60 / Math.max(fps, 1)));
            const before = uniqueCaptured;
            await playThroughFrom(startIdx, rate);
            if (!stillActive()) return;
            if (uniqueCaptured === before) break;
            pass++;
        }

        // Seek any leftover holes individually
        if (stillActive()) {
            for (let i = firstMissing(); i < total; i++) {
                if (!stillActive()) return;
                if (state.frameCache[i]) continue;
                const time = Math.min(i / fps, duration - 0.001);
                await seekVideoAsync(video, time, duration);
                if (!stillActive()) return;
                captureToCache(i);
                if (i % 3 === 0 || i === total - 1) reportProgress(i);

                const canvas = document.getElementById('vpCanvas');
                if (canvas) {
                    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                }
            }
        }

        if (!stillActive()) return;

        // Tiny residual holes
        let last = null;
        for (let i = 0; i < total; i++) {
            if (state.frameCache[i]) last = state.frameCache[i];
            else if (last) state.frameCache[i] = last;
        }
        let next = null;
        for (let i = total - 1; i >= 0; i--) {
            if (state.frameCache[i]) next = state.frameCache[i];
            else if (next) state.frameCache[i] = next;
        }

        if (!stillActive()) return;

        state.frameCacheComplete = true;
        if (infoEl) infoEl.textContent = origText;
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
