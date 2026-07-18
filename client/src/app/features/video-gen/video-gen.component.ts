import {
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { PipelineStateService } from '../../core/pipeline-state.service';
import { ApiService, GeneratedVideo } from '../../core/api.service';
import { SettingsService } from '../../core/settings.service';
import { ToastService } from '../../core/toast.service';
import { NotificationSoundService } from '../../core/notification-sound.service';
import { CancelService } from '../../core/cancel.service';
import { UploadZoneComponent } from '../../shared/components/upload-zone.component';
import { ModeSelectorComponent } from '../../shared/components/mode-selector.component';
import { GenCountComponent } from '../../shared/components/gen-count.component';
import { downloadBlob, fileToDataUrl, scrollAppResultsIntoView } from '../../shared/utils/media';
import {
  VIDEO_PROVIDERS,
  type VideoProviderId,
  getVideoProvider,
  providerButtonLabel,
  resolveSelectValue,
} from '../../core/gen-providers';

const DEFAULT_PROMPT = `Locked-off Position Static Camera. Perfect Seamless Loop. 2d Anime Sakuga Game Animation Style. (Character description), (Animation Type) Subtle Movements.

[Constraints]: Do NOT Camera Zoom, Absolute static camera. Zero Camera movement, no panning, no drifting, and no zooming. The camera is perfectly stationary; only the character moves. The character herself doesnt move either on the Y axis. Maintain the same character position.`;

@Component({
  selector: 'app-video-gen',
  imports: [FormsModule, UploadZoneComponent, ModeSelectorComponent, GenCountComponent],
  templateUrl: './video-gen.component.html',
})
export class VideoGenComponent implements OnDestroy {
  @ViewChild('videoResultsPanel') videoResultsPanel?: ElementRef<HTMLElement>;

  private readonly pipeline = inject(PipelineStateService);
  private readonly api = inject(ApiService);
  readonly settings = inject(SettingsService);
  private readonly toast = inject(ToastService);
  private readonly sound = inject(NotificationSoundService);
  private readonly cancel = inject(CancelService);
  private readonly router = inject(Router);

  readonly mode = signal<'reference' | 'keyframe'>('reference');

  readonly videoProviderOptions = computed(() =>
    this.settings.availableVideoProviders().map((p) => ({
      value: p.id,
      label: providerButtonLabel(p),
      title: p.description,
    }))
  );

  readonly videoProviderNote = computed(() => {
    const sel = this.settings.videoProviderSelection();
    if (!sel.provider) {
      return 'No video providers ready. Add a Gemini or xAI key — or log in with SuperGrok — in Settings.';
    }
    if (sel.fellBack) {
      return `Using ${sel.provider.label} (fallback — preferred provider has no API key).`;
    }
    if (sel.provider.keyProvider === 'xai') {
      return `${sel.provider.label} via ${this.settings.xaiBackendLabel()} · configure in Settings`;
    }
    if (sel.provider.recommended) {
      return `${sel.provider.label} · recommended for VTuber animation`;
    }
    return sel.provider.description;
  });

  readonly selectedVideoProvider = computed(
    () => this.settings.videoProviderSelection().provider?.id ?? ''
  );

  /** Catalog default for empty-state recommendation (Gemini Omni Flash). */
  readonly recommendedVideoProviderLabel =
    VIDEO_PROVIDERS.find((p) => p.recommended)?.label ?? 'Gemini Omni Flash';

  readonly videoCaps = computed(
    () => getVideoProvider(this.settings.videoProviderSelection().provider?.id)?.caps ?? null
  );

  readonly supportsKeyframe = computed(() => this.videoCaps()?.supportsKeyframe ?? false);

  /** Mode buttons — keyframe disabled (not hidden) when the model can't do start+end frames. */
  readonly modeOptions = computed(() => {
    const keyOk = this.supportsKeyframe();
    return [
      {
        value: 'reference',
        label: '🖼️ Reference Mode',
        title: 'Reference image(s) + motion prompt (image-to-video)',
      },
      {
        value: 'keyframe',
        label: '🔑 Keyframe Mode',
        title: keyOk
          ? 'Start and end frames (true dual-keyframe conditioning)'
          : 'Not supported by this model — only single start-image animation',
        disabled: !keyOk,
      },
    ];
  });

  readonly videoAspectOptions = computed(() => this.videoCaps()?.aspectRatios ?? []);
  readonly videoResolutionOptions = computed(() => this.videoCaps()?.resolutions ?? []);
  readonly durationMin = computed(() => this.videoCaps()?.durationMin ?? 3);
  readonly durationMax = computed(() => this.videoCaps()?.durationMax ?? 10);

  readonly videoAspect = signal(localStorage.getItem('as_video_aspect') || '16:9');
  readonly videoResolution = signal(localStorage.getItem('as_video_resolution') || '720p');

  readonly referenceImages = signal<string[]>([]);
  readonly fromSpritePrep = signal(false);
  readonly duration = signal(5);
  readonly genCount = signal(1);
  readonly generating = signal(false);
  readonly genStatus = signal<{ type: string; text: string } | null>(null);
  readonly videos = signal<GeneratedVideo[]>([]);
  /** Single result chosen to hand off to Video Prep (index into videos()). */
  readonly selectedIndex = signal<number | null>(null);
  readonly startFrame = signal<string | null>(null);
  readonly endFrame = signal<string | null>(null);

  prompt = DEFAULT_PROMPT;
  keyframePrompt = DEFAULT_PROMPT;

  private cancelled = false;
  private unregCancel: (() => void) | null = null;

  constructor() {
    this.unregCancel = this.cancel.register(() => {
      if (this.generating()) {
        this.cancelled = true;
        this.toast.show('Generation cancelled', 'warning');
      }
    });

    effect(() => {
      const version = this.pipeline.spriteHandoffVersion();
      const sprite = this.pipeline.sprite();
      if (version > 0 && sprite.base64) {
        this.referenceImages.set([sprite.base64]);
        this.fromSpritePrep.set(true);
      }
    });

    // Initial handoff if already present
    const sprite = this.pipeline.sprite();
    if (sprite.base64) {
      this.referenceImages.set([sprite.base64]);
      this.fromSpritePrep.set(true);
    }
  }

  ngOnDestroy(): void {
    this.unregCancel?.();
    // Do not revoke a blob URL still held by the pipeline handoff — Video Prep
    // may still need it if the component is torn down mid-session.
    const liveHandoffUrl = this.pipeline.video()?.url;
    for (const v of this.videos()) {
      if (v.url.startsWith('blob:') && v.url !== liveHandoffUrl) {
        URL.revokeObjectURL(v.url);
      }
    }
  }

  async onRefFiles(files: FileList): Promise<void> {
    const max = Math.min(files.length, 3);
    const urls: string[] = [];
    for (let i = 0; i < max; i++) {
      urls.push(await fileToDataUrl(files[i]));
    }
    this.referenceImages.set(urls);
    this.fromSpritePrep.set(false);
    this.toast.show(`${urls.length} reference image(s) loaded`, 'success');
  }

  clearRefs(): void {
    this.referenceImages.set([]);
    this.fromSpritePrep.set(false);
  }

  async onStartFrame(files: FileList): Promise<void> {
    if (!files[0]) return;
    const url = await fileToDataUrl(files[0]);
    this.startFrame.set(url);
    const refs = [...this.referenceImages()];
    refs[0] = url;
    this.referenceImages.set(refs);
    this.toast.show('Start frame loaded', 'success');
  }

  async onEndFrame(files: FileList): Promise<void> {
    if (!files[0]) return;
    const url = await fileToDataUrl(files[0]);
    this.endFrame.set(url);
    const refs = [...this.referenceImages()];
    if (refs.length === 0) refs.push('');
    refs[1] = url;
    this.referenceImages.set(refs);
    this.toast.show('End frame loaded', 'success');
  }

  goToSettings(): void {
    void this.router.navigateByUrl('/settings');
  }

  onDuration(e: Event): void {
    const raw = parseInt((e.target as HTMLInputElement).value, 10);
    const min = this.durationMin();
    const max = this.durationMax();
    this.duration.set(Math.min(max, Math.max(min, raw)));
  }

  onVideoProviderChange(value: string): void {
    if (!value) return;
    this.settings.setPreferredVideoProvider(value as VideoProviderId);
    this.syncVideoFormatToProvider(value as VideoProviderId);
  }

  onModeChange(value: string): void {
    if (value === 'keyframe' && !this.supportsKeyframe()) {
      this.toast.show(
        'This model only supports a single start image (Reference Mode), not start+end keyframes.',
        'warning'
      );
      this.mode.set('reference');
      return;
    }
    this.mode.set(value === 'keyframe' ? 'keyframe' : 'reference');
  }

  private syncVideoFormatToProvider(id: VideoProviderId): void {
    const caps = getVideoProvider(id)?.caps;
    if (!caps) return;

    if (!caps.supportsKeyframe && this.mode() === 'keyframe') {
      this.mode.set('reference');
      this.toast.show(
        `${getVideoProvider(id)?.label || 'This model'} does not support keyframe mode — switched to Reference Mode.`,
        'warning'
      );
    }

    if (caps.aspectRatios?.length) {
      const next = resolveSelectValue(
        caps.aspectRatios,
        this.videoAspect(),
        caps.defaultAspect
      );
      this.videoAspect.set(next);
      localStorage.setItem('as_video_aspect', next);
    }
    if (caps.resolutions?.length) {
      const next = resolveSelectValue(
        caps.resolutions,
        this.videoResolution(),
        caps.defaultResolution
      );
      this.videoResolution.set(next);
      localStorage.setItem('as_video_resolution', next);
    }

    // Clamp duration into this provider's allowed range
    const d = this.duration();
    if (d < caps.durationMin || d > caps.durationMax) {
      this.duration.set(Math.min(caps.durationMax, Math.max(caps.durationMin, d)));
    }
  }

  onVideoAspectChange(value: string): void {
    if (!value) return;
    this.videoAspect.set(value);
    localStorage.setItem('as_video_aspect', value);
  }

  onVideoResolutionChange(value: string): void {
    if (!value) return;
    this.videoResolution.set(value);
    localStorage.setItem('as_video_resolution', value);
  }

  async generate(): Promise<void> {
    if (this.generating()) return;

    if (this.referenceImages().length === 0 && this.mode() === 'reference') {
      this.toast.show('Upload a reference image first, or send one from Sprite Prep', 'warning');
      return;
    }
    if (this.mode() === 'keyframe' && (!this.startFrame() || !this.endFrame())) {
      this.toast.show('Keyframe mode requires both a Start Frame and End Frame', 'warning');
      return;
    }
    const sel = this.settings.videoProviderSelection();
    if (!sel.provider) {
      this.toast.show(
        'Add a Gemini or xAI key — or log in with SuperGrok — in Settings first',
        'warning'
      );
      return;
    }

    if (this.mode() === 'keyframe' && !this.supportsKeyframe()) {
      this.toast.show(
        `${sel.provider.label} does not support keyframe mode. Use Reference Mode.`,
        'warning'
      );
      this.mode.set('reference');
      return;
    }

    this.syncVideoFormatToProvider(sel.provider.id);

    this.generating.set(true);
    this.cancelled = false;
    this.genStatus.set({
      type: 'info',
      text: `Generating video with ${sel.provider.label} — this may take several minutes…`,
    });

    try {
      const prompt = this.mode() === 'keyframe' ? this.keyframePrompt.trim() : this.prompt.trim();
      const refs =
        this.mode() === 'keyframe'
          ? [this.startFrame()!, this.endFrame()!]
          : this.referenceImages();

      const promises: Promise<GeneratedVideo>[] = [];
      for (let i = 0; i < this.genCount(); i++) {
        if (this.cancelled) break;
        promises.push(
          this.api.generateVideo({
            prompt,
            mode: this.mode(),
            referenceDataUrls: refs,
            duration: this.duration(),
            provider: sel.provider.id,
            aspectRatio: this.videoAspectOptions().length ? this.videoAspect() : undefined,
            resolution: this.videoResolutionOptions().length
              ? this.videoResolution()
              : undefined,
          })
        );
      }

      const results = await Promise.allSettled(promises);
      const ok: GeneratedVideo[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') ok.push(r.value);
      }

      // Revoke old
      for (const v of this.videos()) {
        if (v.url.startsWith('blob:')) URL.revokeObjectURL(v.url);
      }
      this.videos.set(ok);
      this.selectedIndex.set(ok.length ? 0 : null);

      if (ok.length > 0) {
        this.sound.play();
        this.genStatus.set({ type: 'success', text: `✅ Generated ${ok.length} video(s)!` });
        // Results render below the fold — bring the panel into view for action.
        setTimeout(() => scrollAppResultsIntoView(this.videoResultsPanel?.nativeElement), 50);
      } else if (!this.cancelled) {
        const errors = results
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map((r) => r.reason?.message || String(r.reason));
        this.genStatus.set({
          type: 'error',
          text: `❌ ${errors[0] || 'Unknown error — check the server console for details.'}`,
        });
      }
    } catch (err) {
      this.genStatus.set({ type: 'error', text: `❌ ${(err as Error).message}` });
    } finally {
      this.generating.set(false);
    }
  }

  cancelGenerate(): void {
    this.cancelled = true;
    this.toast.show('Generation cancelled', 'warning');
  }

  /** Exclusive single selection for pipeline handoff. */
  selectVideo(idx: number): void {
    this.selectedIndex.set(idx);
  }

  isSelected(idx: number): boolean {
    return this.selectedIndex() === idx;
  }

  downloadVideo(idx: number): void {
    const v = this.videos()[idx];
    if (!v) return;
    downloadBlob(v.blob, `${this.pipeline.characterName() || 'video'}_gen_${idx + 1}.mp4`);
  }

  togglePlay(videoEl: HTMLVideoElement, btn: HTMLButtonElement): void {
    if (videoEl.paused) {
      void videoEl.play();
      btn.textContent = '⏸ Pause';
    } else {
      videoEl.pause();
      btn.textContent = '▶️ Play';
    }
  }

  async handoffToVideoPrep(): Promise<void> {
    const idx = this.selectedIndex();
    if (idx === null) {
      this.toast.show('Select a video first', 'warning');
      return;
    }
    const video = this.videos()[idx];
    if (!video) return;

    // Materialize a solid Blob (arrayBuffer) so Prep never inherits a partial
    // stream handle. Reuse existing object URL when the bytes are already local.
    let blob = video.blob;
    let url = video.url;
    try {
      if (blob.size <= 0) throw new Error('empty video blob');
      // Force full read into memory once — cheap if already buffered; fixes
      // rare stream/blob edge cases after long generation sessions.
      const buf = await blob.arrayBuffer();
      blob = new Blob([buf], { type: blob.type || 'video/mp4' });
      if (url.startsWith('blob:')) {
        // Keep the preview URL on this tab; Prep gets its own via setVideoPrepSource.
      }
      url = URL.createObjectURL(blob);
    } catch (err) {
      this.toast.show('Could not prepare video for handoff: ' + (err as Error).message, 'error');
      return;
    }

    this.pipeline.handoffVideo({ blob, url });
    this.toast.show('Video sent to Video Preparation', 'success');
    void this.router.navigate(['/video-prep']);
  }
}
