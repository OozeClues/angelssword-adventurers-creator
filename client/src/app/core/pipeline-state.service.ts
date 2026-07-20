import { Injectable, signal } from '@angular/core';

export interface SpriteHandoff {
  blob: Blob | null;
  base64: string | null;
  keyColor: string;
}

export interface VideoHandoff {
  blob: Blob | null;
  url: string | null;
}

export interface VideoPrepHandoff {
  /** Object URL for playback; may be revoked if a tab is destroyed — prefer `blob`. */
  videoSrc: string;
  /** Stable binary payload for the exporter (survives blob URL revocation). */
  blob?: Blob | null;
  videoWidth: number;
  videoHeight: number;
  duration: number;
  fps: number;
  totalFrames: number;
  loopMode: 'none' | 'pingpong' | 'reverse';
  loopPoint: number;
  outputFrameCount: number;
  keyColor: string;
  concat: {
    videoSrc: string;
    blob?: Blob | null;
    videoWidth: number;
    videoHeight: number;
    duration: number;
    fps: number;
    crossfade: boolean;
    crossfadeDuration: number;
  } | null;
}

/** In-session source for Video Prep so tab remounts can restore the loaded video. */
export interface VideoPrepSource {
  blob: Blob;
  url: string;
  fileName: string;
}

/**
 * Low-res unkeyed scrub bank shared between Video Prep and Exporter.
 * Built once in Video Prep (~1/4 scale); Exporter reuses for flicker-free scrub.
 * Not persisted — session memory only.
 */
export interface VideoScrubProxyBank {
  /** Match key: `${blobSize}:${totalFrames}:${vw}x${vh}` */
  key: string;
  totalFrames: number;
  videoWidth: number;
  videoHeight: number;
  /** Downscale factor (e.g. 4 → 1/4 resolution). */
  scale: number;
  pw: number;
  ph: number;
  frames: (HTMLCanvasElement | null)[];
}

@Injectable({ providedIn: 'root' })
export class PipelineStateService {
  readonly characterName = signal(localStorage.getItem('as_char_name') ?? '');
  readonly keyColor = signal(
    PipelineStateService.normalizeHex(localStorage.getItem('as_key_color')) ?? '#00FF00'
  );

  readonly sprite = signal<SpriteHandoff>({
    blob: null,
    base64: null,
    keyColor:
      PipelineStateService.normalizeHex(localStorage.getItem('as_key_color')) ?? '#00FF00',
  });

  readonly video = signal<VideoHandoff>({ blob: null, url: null });
  readonly videoPrep = signal<VideoPrepHandoff | null>(null);

  /**
   * Last video loaded in Video Prep (upload or handoff). Owned by the pipeline
   * so object URLs are not revoked when the tab component is destroyed.
   */
  readonly videoPrepSource = signal<VideoPrepSource | null>(null);
  readonly videoPrepConcatSource = signal<VideoPrepSource | null>(null);

  /**
   * Shared 1/N scrub proxies (unkeyed canvases). Video Prep builds;
   * Exporter consumes so scrub does not re-decode or chroma-key every tick.
   */
  readonly videoScrubProxy = signal<VideoScrubProxyBank | null>(null);

  /** Incremented when a handoff should wake a target tab. */
  readonly spriteHandoffVersion = signal(0);
  readonly videoHandoffVersion = signal(0);
  readonly videoPrepHandoffVersion = signal(0);

  setCharacterName(name: string): void {
    this.characterName.set(name);
    localStorage.setItem('as_char_name', name);
  }

  /**
   * Shared key/chroma color for the whole pipeline (Sprite Prep → Exporter).
   * Normalized to #RRGGBB uppercase so tabs compare reliably.
   */
  setKeyColor(color: string): void {
    const normalized = PipelineStateService.normalizeHex(color);
    if (!normalized) return;
    if (this.keyColor() === normalized) {
      // Still keep sprite handoff payload in sync if needed.
      const sprite = this.sprite();
      if (sprite.keyColor !== normalized) {
        this.sprite.set({ ...sprite, keyColor: normalized });
      }
      return;
    }
    this.keyColor.set(normalized);
    localStorage.setItem('as_key_color', normalized);
    const sprite = this.sprite();
    this.sprite.set({ ...sprite, keyColor: normalized });
  }

  static normalizeHex(color: string | null | undefined): string | null {
    if (!color) return null;
    let h = String(color).trim();
    if (!h) return null;
    if (h[0] !== '#') h = `#${h}`;
    // #RGB → #RRGGBB
    if (/^#[0-9a-fA-F]{3}$/.test(h)) {
      h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(h)) return null;
    return h.toUpperCase();
  }

  handoffSprite(payload: { blob: Blob; base64: string; keyColor?: string }): void {
    const keyColor = payload.keyColor ?? this.keyColor();
    if (payload.keyColor) this.setKeyColor(payload.keyColor);
    this.sprite.set({
      blob: payload.blob,
      base64: payload.base64,
      keyColor,
    });
    this.spriteHandoffVersion.update((v) => v + 1);
  }

  handoffVideo(payload: { blob: Blob; url: string }): void {
    const prev = this.video();
    if (prev.url && prev.url.startsWith('blob:') && prev.url !== payload.url) {
      URL.revokeObjectURL(prev.url);
    }
    this.video.set({ blob: payload.blob, url: payload.url });
    this.videoHandoffVersion.update((v) => v + 1);
  }

  handoffVideoPrep(data: VideoPrepHandoff): void {
    this.videoPrep.set(data);
    this.videoPrepHandoffVersion.update((v) => v + 1);
  }

  /**
   * Register (or replace) the Video Prep primary source. Returns a stable
   * object URL owned by this service — callers must not revoke it.
   */
  setVideoPrepSource(blob: Blob, fileName = 'video.mp4'): string {
    const prev = this.videoPrepSource();
    // Reuse URL if same blob instance.
    if (prev && prev.blob === blob) {
      if (prev.fileName !== fileName) {
        this.videoPrepSource.set({ ...prev, fileName });
      }
      return prev.url;
    }
    if (prev?.url) URL.revokeObjectURL(prev.url);
    const url = URL.createObjectURL(blob);
    this.videoPrepSource.set({ blob, url, fileName });
    return url;
  }

  setVideoPrepConcatSource(blob: Blob | null, fileName = 'concat.mp4'): string | null {
    const prev = this.videoPrepConcatSource();
    if (!blob) {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      this.videoPrepConcatSource.set(null);
      return null;
    }
    if (prev && prev.blob === blob) return prev.url;
    if (prev?.url) URL.revokeObjectURL(prev.url);
    const url = URL.createObjectURL(blob);
    this.videoPrepConcatSource.set({ blob, url, fileName });
    return url;
  }

  /** Publish or clear the shared scrub proxy bank (Video Prep → Exporter). */
  setVideoScrubProxy(bank: VideoScrubProxyBank | null): void {
    this.videoScrubProxy.set(bank);
  }

  static scrubProxyKey(
    blobSize: number,
    totalFrames: number,
    videoWidth: number,
    videoHeight: number
  ): string {
    return `${blobSize | 0}:${totalFrames | 0}:${videoWidth | 0}x${videoHeight | 0}`;
  }
}
