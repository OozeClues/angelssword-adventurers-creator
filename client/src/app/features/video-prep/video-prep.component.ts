import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { PipelineStateService } from '../../core/pipeline-state.service';
import { ToastService } from '../../core/toast.service';
import { UploadZoneComponent } from '../../shared/components/upload-zone.component';
import { ModeSelectorComponent } from '../../shared/components/mode-selector.component';

@Component({
  selector: 'app-video-prep',
  imports: [UploadZoneComponent, ModeSelectorComponent],
  templateUrl: './video-prep.component.html',
})
export class VideoPrepComponent implements AfterViewInit, OnDestroy {
  @ViewChild('vpCanvas') canvasRef?: ElementRef<HTMLCanvasElement>;

  private readonly pipeline = inject(PipelineStateService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  readonly videoLoaded = signal(false);
  readonly fromVideoGen = signal(false);
  readonly currentFrame = signal(0);
  readonly totalFrames = signal(0);
  readonly fps = signal(30);
  readonly duration = signal(0);
  readonly videoWidth = signal(0);
  readonly videoHeight = signal(0);
  readonly onionSkin = signal(false);
  readonly loopPoint = signal(-1);
  readonly loopMode = signal<'none' | 'pingpong' | 'reverse'>('none');
  readonly isPlaying = signal(false);
  readonly previewPlaying = signal(false);
  readonly concatLoaded = signal(false);
  readonly crossfade = signal(false);
  readonly crossfadeDuration = signal(300);
  readonly frameInfo = signal('0 / 0');
  readonly loopInfo = signal('');
  /** True while metadata / first-frame setup runs. */
  readonly loading = signal(false);
  readonly loadingStatus = signal('');
  /** True while building the low-res scrub proxy cache. */
  readonly cachingProxy = signal(false);
  readonly cacheStatus = signal('');

  readonly loopModeOptions = [
    { value: 'none', label: 'No Loop', title: 'Export frames as-is' },
    { value: 'pingpong', label: 'Ping-Pong', title: 'Forward then reverse' },
    { value: 'reverse', label: 'Reverse', title: 'Reverse order only' },
  ];

  private video: HTMLVideoElement | null = null;
  private concatVideo: HTMLVideoElement | null = null;
  /** Onion-skin ghost (full-res single frame). */
  private frame0Image: HTMLCanvasElement | null = null;
  /**
   * Low-res scrub proxy (1/2, 1/4, or 1/8). Instant scrubbing without multi-GB RAM.
   * Full-res is decoded only when scrubbing settles / on step keys.
   */
  private scrubCache: (HTMLCanvasElement | null)[] | null = null;
  private scrubCacheScale = 4;
  private scrubCacheW = 0;
  private scrubCacheH = 0;
  /** True while the user is dragging the scrubber (prefer proxy frames). */
  private scrubbing = false;
  private scrubSettleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumps on each load so in-flight seeks / previews abort cleanly. */
  private loadGeneration = 0;
  /** Monotonic token so rapid full-res seeks only paint the latest request. */
  private seekSeq = 0;
  private playRAF: number | null = null;
  private previewRAF: number | null = null;
  private concatMeta = { width: 0, height: 0, duration: 0, fps: 30 };
  /** Prevents double-load when effect + ngAfterViewInit both see the same handoff. */
  private loadedHandoffVersion = -1;
  private viewReady = false;
  private pendingHandoff = false;

  /** Target RAM budget for the proxy bank (~64 MiB of RGBA). */
  private static readonly PROXY_BUDGET_BYTES = 64 * 1024 * 1024;

  constructor() {
    effect(() => {
      const v = this.pipeline.videoHandoffVersion();
      if (v > 0) {
        if (this.viewReady) void this.loadFromHandoff();
        else this.pendingHandoff = true;
      }
    });
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    // Prefer a fresh Generate → Prep handoff, else restore sticky session source.
    const handoff = this.pipeline.video();
    if (this.pendingHandoff || handoff.blob || handoff.url) {
      this.pendingHandoff = false;
      void this.loadFromHandoff();
      return;
    }
    const source = this.pipeline.videoPrepSource();
    if (source && !this.videoLoaded()) {
      // Reuse the same Blob instance — do not wrap with new File([...]) (copies bytes).
      void this.loadVideo(source.blob, source.fileName);
    }
  }

  ngOnDestroy(): void {
    this.loadGeneration++;
    this.seekSeq++;
    this.loading.set(false);
    this.cachingProxy.set(false);
    this.clearScrubSettleTimer();
    this.clearProxyCache();
    this.stopPreview();
    this.pauseVideo();
    this.frame0Image = null;
    // Pipeline owns object URLs (videoPrepSource / concat). Never revoke here —
    // revoking on tab leave was breaking Exporter handoff and re-entry.
    if (this.video) {
      this.video.removeAttribute('src');
      this.video.load();
      this.video.remove();
      this.video = null;
    }
    if (this.concatVideo) {
      this.concatVideo.removeAttribute('src');
      this.concatVideo.load();
      this.concatVideo.remove();
      this.concatVideo = null;
    }
  }

  private clearScrubSettleTimer(): void {
    if (this.scrubSettleTimer != null) {
      clearTimeout(this.scrubSettleTimer);
      this.scrubSettleTimer = null;
    }
  }

  private clearProxyCache(): void {
    this.scrubCache = null;
    this.scrubCacheW = 0;
    this.scrubCacheH = 0;
    this.scrubCacheScale = 4;
  }

  /**
   * Pick 1/2, 1/4, or 1/8 so proxy bank stays under PROXY_BUDGET_BYTES.
   * Prefer the highest quality (smallest divisor) that fits.
   */
  private pickProxyScale(width: number, height: number, frames: number): number {
    const n = Math.max(1, frames);
    const full = Math.max(1, width) * Math.max(1, height) * 4 * n;
    for (const scale of [2, 4, 8] as const) {
      if (full / (scale * scale) <= VideoPrepComponent.PROXY_BUDGET_BYTES) {
        return scale;
      }
    }
    return 8;
  }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement)?.matches?.('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this.prevFrame();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.nextFrame();
    }
  }

  private createVideoElement(): HTMLVideoElement {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.playsInline = true;
    // metadata is enough to start; browser fetches ranges on seek (avoids
    // eagerly buffering the whole clip into disk cache when possible).
    v.preload = 'metadata';
    v.muted = true;
    v.style.display = 'none';
    document.body.appendChild(v);
    return v;
  }

  /** Common broadcast / cinema rates we snap noisy measurements onto. */
  private static readonly FPS_CANDIDATES = [
    12, 15, 18, 20, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60,
  ];

  /**
   * Snap a raw measured fps to the nearest common rate when close enough;
   * otherwise round to a sensible integer. Fixes 24↔25 flip-flops from noisy samples.
   */
  private snapFps(raw: number): number {
    if (!Number.isFinite(raw) || raw < 5 || raw > 120) return 30;
    let best = raw;
    let bestRel = Infinity;
    for (const c of VideoPrepComponent.FPS_CANDIDATES) {
      const rel = Math.abs(raw - c) / c;
      if (rel < bestRel) {
        bestRel = rel;
        best = c;
      }
    }
    // Within 6% of a known rate → trust the standard (e.g. 24.3 → 24, 24.7 → 25)
    const snapped = bestRel <= 0.06 ? best : Math.round(raw);
    // Integer-ish rates stored as int for stable frame index math
    if (Math.abs(snapped - Math.round(snapped)) < 0.02) return Math.round(snapped);
    return Math.round(snapped * 1000) / 1000;
  }

  /** Frame index for a media timestamp (stable, non-negative). */
  private frameIndexAt(time: number, fps: number, total: number): number {
    if (total < 1) return 0;
    // floor+epsilon avoids off-by-one at exact boundaries better than round for scrub maps
    return Math.min(total - 1, Math.max(0, Math.floor(time * fps + 1e-4)));
  }

  private async waitForPlaybackReady(video: HTMLVideoElement): Promise<void> {
    if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        video.removeEventListener('canplay', done);
        resolve();
      };
      video.addEventListener('canplay', done);
      setTimeout(done, 4000);
    });
  }

  /**
   * Measure fps from consecutive decoded frame mediaTimes (rvfc), not from a short
   * 4× playbackQuality sample (that drops frames and often reports 24 vs 25 wrong).
   */
  private async detectVideoTiming(
    video: HTMLVideoElement
  ): Promise<{ fps: number; totalFrames: number; duration: number }> {
    const duration = video.duration > 0 && Number.isFinite(video.duration) ? video.duration : 0;
    await this.waitForPlaybackReady(video);

    const intervals: number[] = [];
    let lastMediaTime = -1;

    // --- Primary: 1× play + requestVideoFrameCallback interval median ---
    if (typeof video.requestVideoFrameCallback === 'function' && duration > 0) {
      await this.seekVideoAsync(video, 0, duration, true);
      await new Promise<void>((resolve) => {
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

        const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
          if (settled) return;
          const t = meta?.mediaTime ?? video.currentTime;
          if (lastMediaTime >= 0 && t > lastMediaTime + 1e-5) {
            intervals.push(t - lastMediaTime);
          }
          if (t >= lastMediaTime) lastMediaTime = t;

          const enough = intervals.length >= maxSamples;
          const timedOut = performance.now() - startWall > maxWallMs;
          const nearEnd = t >= duration - 0.04 || video.ended;
          if (enough || timedOut || nearEnd) {
            finish();
            return;
          }
          video.requestVideoFrameCallback(onFrame);
        };

        video.playbackRate = 1;
        video.requestVideoFrameCallback(onFrame);
        void video.play().catch(() => finish());
        // Safety if play never delivers frames
        setTimeout(finish, maxWallMs + 500);
      });
    }

    // --- Fallback: longer 1× getVideoPlaybackQuality sample (never 4× — drops frames) ---
    if (intervals.length < 6 && typeof video.getVideoPlaybackQuality === 'function' && duration > 0) {
      await this.seekVideoAsync(video, 0, duration, true);
      const q0 = video.getVideoPlaybackQuality();
      const t0 = video.currentTime;
      video.playbackRate = 1;
      void video.play();
      await new Promise((r) => setTimeout(r, 1500));
      video.pause();
      const q1 = video.getVideoPlaybackQuality();
      const t1 = video.currentTime;
      const dt = Math.max(1e-3, t1 - t0);
      const df = (q1.totalVideoFrames || 0) - (q0.totalVideoFrames || 0);
      if (df >= 4) {
        // Average interval over the sample window
        intervals.push(dt / df);
      }
    }

    video.pause();
    video.playbackRate = 1;

    let fps = 30;
    if (intervals.length >= 3) {
      const sorted = [...intervals].sort((a, b) => a - b);
      // Use median; also trim outliers if we have many samples
      const mid = sorted[Math.floor(sorted.length / 2)];
      const rawFps = mid > 1e-6 ? 1 / mid : 30;
      fps = this.snapFps(rawFps);
    } else if (intervals.length > 0) {
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      fps = this.snapFps(avg > 1e-6 ? 1 / avg : 30);
    }

    if (fps < 8 || fps > 120) fps = 30;

    // Frame indices 0..N-1 with presentation time i/fps. Use round(duration*fps)
    // then ensure the last index still seeks inside the clip.
    let totalFrames = 1;
    if (duration > 0 && fps > 0) {
      totalFrames = Math.max(1, Math.round(duration * fps));
      // Prefer not clipping: if duration suggests another frame fits, include it
      const maxByDuration = Math.max(1, Math.floor(duration * fps - 1e-6) + 1);
      totalFrames = Math.max(totalFrames, maxByDuration);
      // Last seek time must be < duration
      while (totalFrames > 1 && (totalFrames - 1) / fps >= duration - 0.0005) {
        totalFrames--;
      }
    }

    return { fps, totalFrames, duration };
  }

  /**
   * Seek and wait until the decoder has actually presented the new frame.
   *
   * @param force When true, always perform a real seek even if currentTime is
   *   already near the target. Firefox often updates `currentTime` to 0 before
   *   the painted frame has changed after playback — without a forced seek,
   *   drawImage() can capture a mid-video frame (breaks onion-skin frame 0).
   */
  private async seekVideoAsync(
    videoEl: HTMLVideoElement,
    time: number,
    maxDuration?: number,
    force = false
  ): Promise<void> {
    const dur = maxDuration || videoEl.duration || 1;
    const targetTime = Math.min(Math.max(0, time), Math.max(dur - 0.001, 0));

    const waitSeeked = () =>
      new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 2000);
        videoEl.addEventListener(
          'seeked',
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true }
        );
      });

    // Fast path: already there and caller doesn't need a fresh decode.
    if (!force && Math.abs(videoEl.currentTime - targetTime) < 0.001 && !videoEl.seeking) {
      return;
    }

    // Nudge away first so `seeked` is guaranteed to fire for the real target.
    // Needed when currentTime already reports ~0 but the frame buffer does not.
    if (force && Math.abs(videoEl.currentTime - targetTime) < 0.001) {
      const eps = Math.min(0.05, Math.max(dur * 0.25, 0.001));
      const alt =
        targetTime + eps <= dur - 0.001
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
  private snapshotVideoFrame(
    videoEl: HTMLVideoElement,
    width: number,
    height: number
  ): HTMLCanvasElement {
    const capture = document.createElement('canvas');
    capture.width = width;
    capture.height = height;
    const ctx = capture.getContext('2d', { alpha: false });
    ctx?.drawImage(videoEl, 0, 0, width, height);
    return capture;
  }

  async onVideoFiles(files: FileList): Promise<void> {
    const f = files[0];
    if (f && f.type.startsWith('video/')) await this.loadVideo(f, f.name || 'video.mp4');
    else this.toast.show('Please select a video file (MP4, WebM, MOV)', 'error');
  }

  private async loadFromHandoff(): Promise<void> {
    const handoff = this.pipeline.video();
    if (!handoff.blob && !handoff.url) return;

    const version = this.pipeline.videoHandoffVersion();
    if (version === this.loadedHandoffVersion && this.videoLoaded()) return;
    this.loadedHandoffVersion = version;

    try {
      this.fromVideoGen.set(true);
      if (handoff.blob) {
        // Same Blob instance as Generate — no File([blob]) copy (that doubled RAM).
        await this.loadVideo(handoff.blob, 'generated.mp4');
      } else {
        // Fully materialize remote/stream URLs into a solid Blob before attaching.
        const resp = await fetch(handoff.url!);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        const mime =
          resp.headers.get('content-type')?.split(';')[0] ||
          'video/mp4';
        const blob = new Blob([buf], { type: mime });
        await this.loadVideo(blob, 'generated.mp4');
      }
    } catch (err) {
      this.toast.show('Failed to load video from Generate tab: ' + (err as Error).message, 'error');
    }
  }

  /**
   * Load a video for prep. Accepts Blob|File so handoff can share the same
   * in-memory bytes without cloning.
   */
  private async loadVideo(source: Blob, fileName = 'video.mp4'): Promise<void> {
    this.stopPreview();
    this.pauseVideo();
    const gen = ++this.loadGeneration;
    this.seekSeq++;
    this.frame0Image = null;
    this.clearProxyCache();
    this.clearScrubSettleTimer();
    this.scrubbing = false;
    this.cachingProxy.set(false);
    this.cacheStatus.set('');
    this.loading.set(true);
    this.loadingStatus.set('Loading video…');
    this.videoLoaded.set(false);

    if (this.video) {
      this.video.removeAttribute('src');
      this.video.load();
      this.video.remove();
      this.video = null;
    }

    // Stable pipeline-owned URL so tab destroy / handoff cannot invalidate it.
    const src = this.pipeline.setVideoPrepSource(source, fileName || 'video.mp4');
    const video = this.createVideoElement();
    // After we have a blob URL, allow the browser to fetch media for seeks.
    video.preload = 'auto';
    video.src = src;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Failed to load video'));
    });
    if (gen !== this.loadGeneration) return;

    this.video = video;
    this.videoWidth.set(video.videoWidth);
    this.videoHeight.set(video.videoHeight);

    this.loadingStatus.set('Detecting frame rate…');
    // Robust fps / frame-count (rvfc intervals + snap to 24/25/30…). Avoids the
    // old 4× playbackQuality sample that under-counted frames and flipped 24↔25.
    const timing = await this.detectVideoTiming(video);
    if (gen !== this.loadGeneration) return;

    this.duration.set(timing.duration || video.duration);
    this.fps.set(timing.fps);
    this.totalFrames.set(timing.totalFrames);

    const canvas = this.canvasRef?.nativeElement;
    if (canvas) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    video.addEventListener('seeked', () => {
      // Avoid clobbering proxy scrub frames or active playback.
      if (
        this.isPlaying() ||
        this.loading() ||
        this.cachingProxy() ||
        this.previewPlaying() ||
        this.scrubbing
      ) {
        return;
      }
      this.drawFrameFromVideo();
    });

    this.videoLoaded.set(true);
    video.playbackRate = 1;

    this.loadingStatus.set('Preparing first frame…');
    // Force a real decode of frame 0 (critical after FPS-detection playback).
    await this.seekVideoAsync(video, 0, this.duration(), true);
    if (gen !== this.loadGeneration) return;
    this.drawFrameFromVideo();

    // Onion-skin ghost — single full-res snapshot.
    this.frame0Image = this.snapshotVideoFrame(video, video.videoWidth, video.videoHeight);

    this.currentFrame.set(this.totalFrames() - 1);
    this.setLoopPoint();
    this.currentFrame.set(0);
    await this.seekToFrameAsync(0);
    if (gen !== this.loadGeneration) return;

    this.loading.set(false);
    this.loadingStatus.set('');
    this.toast.show(
      `Video loaded: ${this.totalFrames()} frames @ ${timing.fps}fps (${this.duration().toFixed(2)}s)`,
      'success'
    );

    // Background low-res scrub bank (smooth drag without multi-GB full-res cache).
    void this.buildProxyCache(gen);
  }

  private drawFrameFromVideo(): void {
    const video = this.video;
    const canvas = this.canvasRef?.nativeElement;
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    this.drawOnionSkin(ctx, canvas.width, canvas.height);
  }

  private drawOnionSkin(
    ctx: CanvasRenderingContext2D,
    destW: number,
    destH: number
  ): void {
    if (!this.onionSkin() || !this.frame0Image || this.currentFrame() <= 0) return;
    ctx.globalAlpha = 0.5;
    ctx.drawImage(this.frame0Image, 0, 0, destW, destH);
    ctx.globalAlpha = 1;
  }

  /** Paint a low-res proxy frame scaled up to the display canvas (instant). */
  private paintProxyFrame(frameIdx: number): boolean {
    const proxy = this.scrubCache?.[frameIdx];
    const canvas = this.canvasRef?.nativeElement;
    if (!proxy || !canvas) return false;
    const ctx = canvas.getContext('2d')!;
    // Slight blur is fine while dragging; full-res lands on scrub end.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    ctx.drawImage(proxy, 0, 0, canvas.width, canvas.height);
    this.drawOnionSkin(ctx, canvas.width, canvas.height);
    return true;
  }

  /**
   * Show a frame. During scrubbing with a ready proxy, paint instantly from cache.
   * Otherwise (or when forceFull), seek the real video for a full-res sample.
   */
  seekToFrame(frameIdx: number, opts: { full?: boolean } = {}): void {
    const total = this.totalFrames();
    const clamped = Math.min(Math.max(0, frameIdx), Math.max(total - 1, 0));
    const fps = this.fps();
    const duration = this.duration();
    const time = Math.min(Math.max(0, clamped / fps), Math.max(duration - 0.001, 0));

    this.currentFrame.set(clamped);
    this.frameInfo.set(`Frame ${clamped} / ${Math.max(total - 1, 0)} (${time.toFixed(2)}s)`);

    const preferProxy = !opts.full && this.scrubbing && !!this.scrubCache?.[clamped];
    if (preferProxy && this.paintProxyFrame(clamped)) {
      return;
    }
    // Also use proxy for instant feedback when not scrubbing but cache is warm
    // and a full-res settle is already scheduled (optional). Default: full seek.
    if (!opts.full && this.scrubbing) {
      // Cache miss mid-drag — fall through to full seek (may hitch once).
    }
    void this.seekToFrameAsync(clamped);
  }

  private async seekToFrameAsync(frameIdx: number): Promise<void> {
    if (!this.videoLoaded() || !this.video) return;
    const seq = ++this.seekSeq;
    const total = this.totalFrames();
    const clamped = Math.min(Math.max(0, frameIdx), Math.max(total - 1, 0));
    const fps = this.fps();
    const duration = this.duration();
    const time = Math.min(Math.max(0, clamped / fps), Math.max(duration - 0.001, 0));

    this.currentFrame.set(clamped);
    this.frameInfo.set(`Frame ${clamped} / ${Math.max(total - 1, 0)} (${time.toFixed(2)}s)`);

    await this.seekVideoAsync(this.video, time, duration);
    if (seq !== this.seekSeq || !this.video) return;
    // Don't overwrite a newer proxy scrub paint if user is still dragging.
    if (this.scrubbing && this.scrubCache?.[clamped]) {
      this.paintProxyFrame(clamped);
      return;
    }
    this.drawFrameFromVideo();
  }

  /** Scrubber drag — proxy frames only (smooth). */
  onScrub(e: Event): void {
    this.pauseVideo();
    this.stopPreview();
    this.scrubbing = true;
    const frame = parseInt((e.target as HTMLInputElement).value, 10);
    const total = this.totalFrames();
    const clamped = Math.min(Math.max(0, frame), Math.max(total - 1, 0));
    const fps = this.fps();
    const duration = this.duration();
    const time = Math.min(Math.max(0, clamped / fps), Math.max(duration - 0.001, 0));

    this.currentFrame.set(clamped);
    this.frameInfo.set(`Frame ${clamped} / ${Math.max(total - 1, 0)} (${time.toFixed(2)}s)`);

    if (!this.paintProxyFrame(clamped)) {
      // Proxy not ready yet — best-effort live seek (may be choppy until cache fills).
      void this.seekToFrameAsync(clamped);
    }

    // Debounced full-res settle if they pause mid-drag without firing change.
    this.clearScrubSettleTimer();
    this.scrubSettleTimer = setTimeout(() => {
      void this.settleScrubToFullRes();
    }, 140);
  }

  /** Scrubber release — decode true full-res frame. */
  onScrubEnd(): void {
    this.clearScrubSettleTimer();
    void this.settleScrubToFullRes();
  }

  private async settleScrubToFullRes(): Promise<void> {
    this.scrubbing = false;
    this.clearScrubSettleTimer();
    if (!this.videoLoaded()) return;
    await this.seekToFrameAsync(this.currentFrame());
  }

  prevFrame(): void {
    this.pauseVideo();
    this.stopPreview();
    this.scrubbing = false;
    if (this.currentFrame() > 0) {
      // Instant proxy feedback, then full-res.
      const f = this.currentFrame() - 1;
      this.currentFrame.set(f);
      if (this.scrubCache?.[f]) this.paintProxyFrame(f);
      void this.seekToFrameAsync(f);
    }
  }

  nextFrame(): void {
    this.pauseVideo();
    this.stopPreview();
    this.scrubbing = false;
    if (this.currentFrame() < this.totalFrames() - 1) {
      const f = this.currentFrame() + 1;
      this.currentFrame.set(f);
      if (this.scrubCache?.[f]) this.paintProxyFrame(f);
      void this.seekToFrameAsync(f);
    }
  }

  /**
   * Build a low-res (1/2–1/8) frame bank for smooth scrubbing.
   * Play-through first, then seek-fill holes. Full-res is only used on settle.
   */
  private async buildProxyCache(gen: number): Promise<void> {
    if (!this.video || gen !== this.loadGeneration) return;
    const video = this.video;
    const total = this.totalFrames();
    const fps = this.fps();
    const duration = this.duration();
    const vw = this.videoWidth();
    const vh = this.videoHeight();
    if (total < 2 || vw < 1 || vh < 1) return;

    const scale = this.pickProxyScale(vw, vh, total);
    const pw = Math.max(1, Math.round(vw / scale));
    const ph = Math.max(1, Math.round(vh / scale));
    this.scrubCacheScale = scale;
    this.scrubCacheW = pw;
    this.scrubCacheH = ph;
    this.scrubCache = new Array(total).fill(null);

    this.cachingProxy.set(true);
    this.cacheStatus.set(`Building scrub preview (1/${scale})…`);

    const stillActive = () =>
      gen === this.loadGeneration && this.video === video && this.videoLoaded();

    const captureProxy = (idx: number): boolean => {
      if (!this.scrubCache || idx < 0 || idx >= total || this.scrubCache[idx]) return false;
      try {
        const c = document.createElement('canvas');
        c.width = pw;
        c.height = ph;
        const ctx = c.getContext('2d', { alpha: false });
        if (!ctx) return false;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'low';
        ctx.drawImage(video, 0, 0, pw, ph);
        this.scrubCache[idx] = c;
        return true;
      } catch {
        return false;
      }
    };

    const frameIndexAt = (t: number): number =>
      Math.min(total - 1, Math.max(0, Math.floor(t * fps + 1e-4)));

    let unique = 0;
    const report = () => {
      this.cacheStatus.set(
        `Scrub preview 1/${scale}: ${unique} / ${total} frames`
      );
    };

    // ── Pass 1: 1× play-through ──
    try {
      await this.seekVideoAsync(video, 0, duration, true);
      if (!stillActive()) return;

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          try {
            video.pause();
            video.playbackRate = 1;
          } catch {
            /* ignore */
          }
          resolve();
        };

        const onPresented = (_now: number, meta?: VideoFrameCallbackMetadata) => {
          if (settled || !stillActive()) {
            finish();
            return;
          }
          const t = meta?.mediaTime ?? video.currentTime;
          const idx = frameIndexAt(t);
          if (captureProxy(idx)) {
            unique++;
            if (unique % 4 === 0 || unique === total) report();
          }
          if (unique >= total || video.ended || t >= duration - 0.5 / fps) {
            finish();
            return;
          }
          schedule();
        };

        const schedule = () => {
          if (settled) return;
          const v = video as HTMLVideoElement & {
            requestVideoFrameCallback?: (
              cb: (now: number, meta: VideoFrameCallbackMetadata) => void
            ) => number;
          };
          if (typeof v.requestVideoFrameCallback === 'function') {
            v.requestVideoFrameCallback(onPresented);
          } else {
            requestAnimationFrame((now) => onPresented(now));
          }
        };

        video.playbackRate = 1;
        schedule();
        void video.play().catch(() => finish());
        setTimeout(finish, Math.min(120000, duration * 1000 * 2.5 + 4000));
      });
    } catch {
      /* fall through to seek-fill */
    }

    if (!stillActive()) return;

    // ── Pass 2: seek-fill holes (bounded waits) ──
    this.cacheStatus.set(`Filling scrub gaps (1/${scale})…`);
    for (let i = 0; i < total; i++) {
      if (!stillActive()) return;
      if (this.scrubCache![i]) continue;
      const time = Math.min(i / fps, Math.max(duration - 0.001, 0));
      await this.seekVideoAsync(video, time, duration);
      if (!stillActive()) return;
      if (captureProxy(i)) unique++;
      if (i % 6 === 0) {
        this.cacheStatus.set(`Filling scrub gaps: ${unique} / ${total}`);
      }
    }

    if (!stillActive()) return;

    // Propagate nearest neighbor into any remaining nulls (tiny residual gaps).
    let last: HTMLCanvasElement | null = null;
    for (let i = 0; i < total; i++) {
      if (this.scrubCache![i]) last = this.scrubCache![i];
      else if (last) this.scrubCache![i] = last;
    }
    let next: HTMLCanvasElement | null = null;
    for (let i = total - 1; i >= 0; i--) {
      if (this.scrubCache![i]) next = this.scrubCache![i];
      else if (next) this.scrubCache![i] = next;
    }

    // Restore display frame (full-res).
    try {
      video.pause();
      video.playbackRate = 1;
    } catch {
      /* ignore */
    }
    await this.seekToFrameAsync(this.currentFrame());
    if (!stillActive()) return;

    this.cachingProxy.set(false);
    this.cacheStatus.set('');
    const mb = ((pw * ph * 4 * total) / (1024 * 1024)).toFixed(1);
    this.toast.show(
      `Scrub preview ready (1/${scale}, ~${mb} MB) — full quality on release`,
      'success'
    );
  }

  togglePlay(): void {
    if (this.loading()) return;
    if (this.isPlaying()) this.pauseVideo();
    else this.playVideo();
  }

  /**
   * Play at the **source video timeline** (native decode @ playbackRate 1).
   * The browser's own clock is the ground truth for preview speed.
   */
  private playVideo(): void {
    if (!this.videoLoaded() || !this.video || this.loading()) return;
    this.stopPreview();
    this.isPlaying.set(true);

    const video = this.video;
    // Never inherit rate from FPS detect / cache play-through
    video.playbackRate = 1;

    const fps = Math.max(1, this.fps());
    const duration = this.duration();
    let startFrame = this.currentFrame();
    if (startFrame >= this.totalFrames() - 1) startFrame = 0;

    const startTime = Math.min(Math.max(0, startFrame / fps), Math.max(duration - 0.001, 0));

    const beginPlay = () => {
      if (!this.isPlaying() || !this.video) return;
      void this.video.play().catch(() => this.pauseVideo());

      const render = () => {
        if (!this.isPlaying() || !this.video) return;
        const canvas = this.canvasRef?.nativeElement;
        if (canvas) {
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
          if (this.onionSkin() && this.frame0Image && this.currentFrame() > 0) {
            ctx.globalAlpha = 0.5;
            ctx.drawImage(this.frame0Image, 0, 0, canvas.width, canvas.height);
            ctx.globalAlpha = 1;
          }
        }
        const frame = this.frameIndexAt(this.video.currentTime, fps, this.totalFrames());
        this.currentFrame.set(frame);
        this.frameInfo.set(
          `Frame ${frame} / ${this.totalFrames() - 1} (${this.video.currentTime.toFixed(2)}s)`
        );
        if (this.video.ended || this.video.paused) {
          this.pauseVideo();
          return;
        }
        this.playRAF = requestAnimationFrame(render);
      };
      this.playRAF = requestAnimationFrame(render);
    };

    // Align decode head to current scrub position, then play for real
    if (Math.abs(video.currentTime - startTime) > 0.02) {
      void this.seekVideoAsync(video, startTime, duration).then(beginPlay);
    } else {
      beginPlay();
    }
  }

  private pauseVideo(): void {
    this.isPlaying.set(false);
    if (this.video) {
      this.video.pause();
      this.video.playbackRate = 1;
    }
    if (this.playRAF) cancelAnimationFrame(this.playRAF);
    this.playRAF = null;
  }

  setLoopPoint(): void {
    if (!this.videoLoaded()) return;
    const lp = Math.max(2, this.currentFrame());
    this.loopPoint.set(lp);
    this.loopInfo.set(`Loop @ frame ${lp} · ${this.getOutputFrameCount()} out frames`);
  }

  clearLoop(): void {
    this.loopPoint.set(-1);
    this.loopInfo.set('');
    this.stopPreview();
  }

  private getOutputFrameCount(): number {
    if (this.loopPoint() < 2) return this.totalFrames();
    const n = this.loopPoint() + 1;
    switch (this.loopMode()) {
      case 'pingpong':
        return n + Math.max(0, n - 2);
      case 'reverse':
      case 'none':
      default:
        return n;
    }
  }

  async previewLoop(): Promise<void> {
    if (this.previewPlaying()) {
      this.stopPreview();
      return;
    }
    if (this.loading() || this.loopPoint() < 2 || !this.video) return;
    this.pauseVideo();
    this.previewPlaying.set(true);

    const frames: number[] = [];
    const n = this.loopPoint();
    if (this.loopMode() === 'reverse') {
      for (let i = n; i >= 0; i--) frames.push(i);
    } else if (this.loopMode() === 'pingpong') {
      for (let i = 0; i <= n; i++) frames.push(i);
      for (let i = n - 1; i >= 1; i--) frames.push(i);
    } else {
      for (let i = 0; i <= n; i++) frames.push(i);
    }

    // Pace by source duration of the loop range so speed matches real video.
    const fps = Math.max(1, this.fps());
    const spanSec = Math.max(1 / fps, n / fps);
    const frameDelay = (spanSec * 1000) / Math.max(1, n + 1);

    let idx = 0;
    const runId = this.loadGeneration;

    // Sequential awaits — each frame paints after seek completes (no frame cache).
    while (this.previewPlaying() && runId === this.loadGeneration) {
      await this.seekToFrameAsync(frames[idx]);
      if (!this.previewPlaying() || runId !== this.loadGeneration) break;
      idx = (idx + 1) % frames.length;
      await new Promise((r) => setTimeout(r, frameDelay));
    }
  }

  stopPreview(): void {
    this.previewPlaying.set(false);
    this.seekSeq++; // cancel any in-flight preview seeks
    if (this.previewRAF != null) {
      cancelAnimationFrame(this.previewRAF);
      clearTimeout(this.previewRAF);
      this.previewRAF = null;
    }
  }

  onOnionChange(e: Event): void {
    this.onionSkin.set((e.target as HTMLInputElement).checked);
    if (this.videoLoaded()) this.seekToFrame(this.currentFrame());
  }

  onLoopMode(mode: string): void {
    this.loopMode.set(mode as 'none' | 'pingpong' | 'reverse');
    if (this.loopPoint() >= 2) {
      const saved = this.currentFrame();
      this.currentFrame.set(this.loopPoint());
      this.setLoopPoint();
      this.currentFrame.set(saved);
      this.seekToFrame(saved);
    }
  }

  async onConcatFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (f && f.type.startsWith('video/')) await this.loadConcatVideo(f);
    else if (f) this.toast.show('Please select a video file', 'error');
    input.value = '';
  }

  private async loadConcatVideo(file: File): Promise<void> {
    if (this.concatVideo) {
      this.concatVideo.removeAttribute('src');
      this.concatVideo.load();
      this.concatVideo.remove();
      this.concatVideo = null;
    }
    const src = this.pipeline.setVideoPrepConcatSource(file, file.name || 'concat.mp4')!;
    const v = this.createVideoElement();
    v.src = src;
    await new Promise<void>((resolve, reject) => {
      v.onloadedmetadata = () => resolve();
      v.onerror = () => reject(new Error('Failed to load second video'));
    });
    this.concatVideo = v;
    this.concatMeta = {
      width: v.videoWidth,
      height: v.videoHeight,
      duration: v.duration,
      fps: 30,
    };
    this.concatLoaded.set(true);
    this.toast.show('2nd video loaded — will be appended', 'success');
  }

  removeConcat(): void {
    if (this.concatVideo) {
      this.concatVideo.removeAttribute('src');
      this.concatVideo.load();
      this.concatVideo.remove();
      this.concatVideo = null;
    }
    this.pipeline.setVideoPrepConcatSource(null);
    this.concatLoaded.set(false);
    this.crossfade.set(false);
  }

  sendToExporter(): void {
    if (!this.videoLoaded() || !this.video) {
      this.toast.show('Load a video first', 'error');
      return;
    }
    this.stopPreview();
    this.pauseVideo();

    const source = this.pipeline.videoPrepSource();
    const concatSource = this.pipeline.videoPrepConcatSource();

    this.pipeline.handoffVideoPrep({
      // Prefer pipeline blob — blob: URLs die if a tab is destroyed mid-handoff.
      videoSrc: source?.url ?? this.video.src,
      blob: source?.blob ?? null,
      videoWidth: this.videoWidth(),
      videoHeight: this.videoHeight(),
      duration: this.duration(),
      fps: this.fps(),
      totalFrames: this.totalFrames(),
      loopMode: this.loopMode(),
      loopPoint: this.loopPoint(),
      outputFrameCount: this.getOutputFrameCount(),
      keyColor: this.pipeline.keyColor(),
      concat: this.concatLoaded() && this.concatVideo
        ? {
            videoSrc: concatSource?.url ?? this.concatVideo.src,
            blob: concatSource?.blob ?? null,
            videoWidth: this.concatMeta.width,
            videoHeight: this.concatMeta.height,
            duration: this.concatMeta.duration,
            fps: this.concatMeta.fps,
            crossfade: this.crossfade(),
            crossfadeDuration: this.crossfadeDuration(),
          }
        : null,
    });

    this.toast.show('Video data sent to Model Exporter!', 'success');
    void this.router.navigate(['/export']);
  }

  scrubMax(): number {
    return Math.max(0, this.totalFrames() - 1);
  }

  infoLines(): string[] {
    if (!this.videoLoaded()) return ['No video loaded'];
    const lines = [
      `Resolution: ${this.videoWidth()} × ${this.videoHeight()}`,
      `Duration: ${this.duration().toFixed(2)}s`,
      `FPS: ${this.fps()}`,
      `Frames: ${this.totalFrames()}`,
    ];
    if (this.loopPoint() >= 2) {
      lines.push(`Loop Point: Frame ${this.loopPoint()}`, `Mode: ${this.loopMode()}`, `Output Frames: ${this.getOutputFrameCount()}`);
    }
    if (this.concatLoaded()) {
      lines.push(
        `2nd Video: ${this.concatMeta.width}×${this.concatMeta.height}`,
        `Crossfade: ${this.crossfade() ? this.crossfadeDuration() + 'ms' : 'Off'}`
      );
    }
    return lines;
  }
}
