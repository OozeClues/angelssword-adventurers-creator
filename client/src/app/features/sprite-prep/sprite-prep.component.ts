import {
  AfterViewInit,
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
import { ApiService } from '../../core/api.service';
import { SettingsService } from '../../core/settings.service';
import { ToastService } from '../../core/toast.service';
import { NotificationSoundService } from '../../core/notification-sound.service';
import { CancelService } from '../../core/cancel.service';
import { ColorSwatchesComponent } from '../../shared/components/color-swatches.component';
import { UploadZoneComponent } from '../../shared/components/upload-zone.component';
import { ModeSelectorComponent } from '../../shared/components/mode-selector.component';
import { GenCountComponent } from '../../shared/components/gen-count.component';
import { ComfyOptionsPanelComponent } from '../../shared/components/comfy-options-panel.component';
import {
  IMAGE_PROVIDERS,
  type ImageProviderId,
  getImageProvider,
  providerButtonLabel,
  resolveSelectValue,
} from '../../core/gen-providers';
import {
  KEY_COLORS,
  SwatchBadge,
  scoreKeyColorsFromImageData,
  scoreKeyColorsFromReferenceImageData,
  rgbToLab,
} from '../../shared/utils/key-colors';
import {
  colorName,
  downloadBlob,
  downloadDataUrl,
  fileToDataUrl,
  loadImage,
  scrollAppResultsIntoView,
} from '../../shared/utils/media';
import { SpriteFrameEditorComponent } from './sprite-frame-editor.component';

@Component({
  selector: 'app-sprite-prep',
  imports: [
    FormsModule,
    ColorSwatchesComponent,
    UploadZoneComponent,
    ModeSelectorComponent,
    GenCountComponent,
    SpriteFrameEditorComponent,
    ComfyOptionsPanelComponent,
  ],
  templateUrl: './sprite-prep.component.html',
})
export class SpritePrepComponent implements AfterViewInit, OnDestroy {
  @ViewChild('genResultsPanel') genResultsPanel?: ElementRef<HTMLElement>;
  @ViewChild('manualEditor') manualEditor?: SpriteFrameEditorComponent;
  @ViewChild('genEditor') genEditor?: SpriteFrameEditorComponent;
  @ViewChild('advKeyCanvas') advKeyCanvasRef?: ElementRef<HTMLCanvasElement>;

  private readonly pipeline = inject(PipelineStateService);
  private readonly api = inject(ApiService);
  readonly settings = inject(SettingsService);
  private readonly toast = inject(ToastService);
  private readonly sound = inject(NotificationSoundService);
  private readonly cancel = inject(CancelService);
  private readonly router = inject(Router);

  readonly mode = signal<'manual' | 'generate'>('manual');
  readonly modeOptions = [
    { value: 'manual', label: '📁 Manual Upload', title: 'Upload your own sprite image' },
    { value: 'generate', label: '✨ AI Generate', title: 'Generate a sprite using AI' },
  ];

  readonly imageProviderOptions = computed(() =>
    this.settings.availableImageProviders().map((p) => ({
      value: p.id,
      label: providerButtonLabel(p),
      title: p.description,
    }))
  );

  readonly imageProviderNote = computed(() => {
    const sel = this.settings.imageProviderSelection();
    if (!sel.provider) {
      return 'No image providers ready. Add an OpenAI, Gemini, or xAI key — log in with SuperGrok — or connect Local ComfyUI in Settings.';
    }
    if (sel.fellBack) {
      return `Using ${sel.provider.label} (fallback — preferred provider has no API key).`;
    }
    if (sel.provider.keyProvider === 'xai') {
      return `${sel.provider.label} via ${this.settings.xaiBackendLabel()} · configure in Settings`;
    }
    if (sel.provider.keyProvider === 'comfy') {
      const name = this.settings.comfyImageSelectionLabel() || 'workflow not selected';
      return `${sel.provider.label} · ${this.settings.comfyBaseUrl() || 'connected'} · ${name}`;
    }
    if (sel.provider.recommended) {
      return `${sel.provider.label} · recommended for sprites`;
    }
    return sel.provider.description;
  });

  readonly selectedImageProvider = computed(
    () => this.settings.imageProviderSelection().provider?.id ?? ''
  );

  /** Local ComfyUI selected as image provider. */
  readonly usingComfyImage = computed(
    () => this.settings.imageProviderSelection().provider?.keyProvider === 'comfy'
  );

  /**
   * Style reference is only useful when the workflow (or cloud model) can take 2 images.
   * For Comfy: disable when 0–1 LoadImage slots.
   */
  readonly styleRefEnabled = computed(() => {
    if (!this.usingComfyImage()) return true;
    return this.settings.comfyImageImageSlots().length >= 2;
  });

  readonly recommendedImageProviderLabel =
    IMAGE_PROVIDERS.find((p) => p.recommended)?.label ?? 'GPT Image 2';

  readonly imageCaps = computed(
    () => getImageProvider(this.settings.imageProviderSelection().provider?.id)?.caps ?? null
  );

  readonly imageAspectOptions = computed(() => this.imageCaps()?.aspectRatios ?? []);
  readonly imageSizeOptions = computed(() => this.imageCaps()?.sizes ?? []);
  readonly imageResolutionOptions = computed(() => this.imageCaps()?.resolutions ?? []);

  readonly imageAspect = signal(localStorage.getItem('as_image_aspect') || '16:9');
  readonly imageSize = signal(localStorage.getItem('as_image_size') || '1536x1024');
  readonly imageResolution = signal(localStorage.getItem('as_image_resolution') || '1K');

  readonly raceMode = signal('normal');
  readonly raceOptions = [
    { value: 'normal', label: '👤 Normal', title: 'Standard human/anime character' },
    { value: 'kanolith', label: '🐾 Kanolith', title: 'Kemonomimi style' },
    { value: 'zoalith', label: '🐲 Zoalith', title: 'Full anthropomorphic beastfolk' },
  ];

  /**
   * When true, skip the full sprite pipeline prompt (race, chroma, framing, etc.)
   * and use {@link customPrompt} after Character Name + Action only.
   */
  readonly useCustomPrompt = signal(localStorage.getItem('as_sprite_custom_prompt') === 'true');
  customPrompt = localStorage.getItem('as_sprite_custom_prompt_text') ?? '';

  characterName = this.pipeline.characterName();
  genCharName = this.pipeline.characterName();
  charDesc = '';
  charAction = '';

  readonly keyColor = signal(this.pipeline.keyColor());
  readonly swatchBadges = signal<Record<string, SwatchBadge>>({});

  /** Manual upload source for the frame editor (data URL). */
  readonly manualImageSrc = signal<string | null>(null);
  private spriteFileName = '';

  readonly genCount = signal(1);
  readonly generating = signal(false);
  /** 0–100 for Comfy (and future) live progress; -1 = indeterminate. */
  readonly genProgress = signal(-1);
  readonly genStatus = signal<{ type: string; text: string } | null>(null);
  readonly genResults = signal<string[]>([]);
  readonly selectedResult = signal<string | null>(null);
  readonly charRefBase64 = signal<string | null>(null);
  readonly styleRefBase64 = signal<string | null>(null);

  /** Comfy LoadImage roles that currently have an uploaded app image. */
  readonly comfyActiveRoles = computed(() => {
    const roles: Array<'character_reference' | 'style_reference'> = [];
    if (this.charRefBase64()) roles.push('character_reference');
    if (this.styleRefBase64() && this.styleRefEnabled()) roles.push('style_reference');
    return roles;
  });

  readonly showAdvKey = signal(false);
  readonly advKeyResults = signal<
    Array<{
      hex: string;
      name: string;
      score: number;
      dangerPercent: number;
      best: boolean;
    }>
  >([]);
  readonly advKeyCanAnalyze = signal(false);

  private genCancelled = false;
  private unregCancel: (() => void) | null = null;

  private advKeyRect: { x: number; y: number; w: number; h: number } | null = null;
  private advKeyImg: HTMLImageElement | null = null;
  private advKeyDrawing = false;
  private advKeyStartX = 0;
  private advKeyStartY = 0;
  readonly advSelectionStyle = signal<Record<string, string>>({ display: 'none' });

  constructor() {
    effect(() => {
      const shared = this.pipeline.keyColor();
      if (shared && shared !== this.keyColor()) {
        this.keyColor.set(shared);
      }
    });
  }

  ngAfterViewInit(): void {
    this.unregCancel = this.cancel.register(() => {
      if (this.generating()) {
        this.genCancelled = true;
        this.toast.show('Generation cancelled', 'warning');
      }
    });
  }

  ngOnDestroy(): void {
    this.unregCancel?.();
  }

  onModeChange(m: string): void {
    this.mode.set(m as 'manual' | 'generate');
  }

  onCharNameChange(value: string): void {
    this.characterName = value;
    this.genCharName = value;
    this.pipeline.setCharacterName(value);
  }

  onGenCharNameChange(value: string): void {
    this.genCharName = value;
    this.characterName = value;
    this.pipeline.setCharacterName(value);
  }

  onKeyColorChange(color: string): void {
    // Pipeline normalizes + writes localStorage `as_key_color` for the whole workflow
    this.pipeline.setKeyColor(color);
    const normalized = this.pipeline.keyColor();
    this.keyColor.set(normalized);
  }

  async onSpriteFiles(files: FileList): Promise<void> {
    const file = files[0];
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      const img = await loadImage(dataUrl);
      this.spriteFileName = file.name.replace(/\.\w+$/i, '');
      this.manualImageSrc.set(dataUrl);
      this.applyAutoKeyColor(img);
      this.toast.show(`Sprite loaded: ${img.naturalWidth}×${img.naturalHeight}`, 'success');
    } catch {
      this.toast.show('Failed to load image', 'error');
    }
  }

  clearSprite(): void {
    this.manualImageSrc.set(null);
    this.spriteFileName = '';
    this.toast.show('Sprite cleared', 'info');
  }

  private applyAutoKeyColor(image: HTMLImageElement): void {
    const w = image.naturalWidth;
    const h = image.naturalHeight;
    const tc = document.createElement('canvas');
    tc.width = w;
    tc.height = h;
    const tctx = tc.getContext('2d', { willReadFrequently: true })!;
    tctx.drawImage(image, 0, 0);
    const data = tctx.getImageData(0, 0, w, h).data;
    const scores = scoreKeyColorsFromImageData(data, w, h);
    this.applyScores(scores);
  }

  private applyScores(scores: { hex: string; badge: SwatchBadge; selected: boolean }[]): void {
    const badges: Record<string, SwatchBadge> = {};
    let selected = this.keyColor();
    for (const s of scores) {
      badges[s.hex] = s.badge;
      if (s.selected) selected = s.hex;
    }
    this.swatchBadges.set(badges);
    this.keyColor.set(selected);
    this.pipeline.setKeyColor(selected);
  }

  async downloadPNG(): Promise<void> {
    const editor = this.manualEditor;
    if (!editor) {
      this.toast.show('Load a sprite first', 'warning');
      return;
    }
    try {
      const frame = await editor.exportFrame();
      if (!frame) {
        this.toast.show('Could not export frame', 'error');
        return;
      }
      const name = this.pipeline.characterName() || this.spriteFileName || 'sprite';
      downloadBlob(frame.blob, `${name}_1280x720.png`);
    } catch (err) {
      this.toast.show('Download failed: ' + (err as Error).message, 'error');
    }
  }

  async handoffToVideoGen(): Promise<void> {
    const editor = this.manualEditor;
    if (!editor) {
      this.toast.show('Load a sprite first', 'warning');
      return;
    }
    try {
      const frame = await editor.exportFrame();
      if (!frame) {
        this.toast.show('Could not prepare sprite for handoff', 'error');
        return;
      }
      this.pipeline.handoffSprite({
        blob: frame.blob,
        base64: frame.base64,
        keyColor: this.keyColor(),
      });
      this.toast.show('Sprite sent to Generate Video', 'success');
      void this.router.navigate(['/video-gen']);
    } catch (err) {
      this.toast.show('Handoff failed: ' + (err as Error).message, 'error');
    }
  }

  async onCharRef(files: FileList): Promise<void> {
    if (!files[0]) return;
    const dataUrl = await fileToDataUrl(files[0]);
    this.charRefBase64.set(dataUrl);
    await this.analyzeReference(dataUrl);
    if (this.usingComfyImage()) {
      this.settings.ensureComfyImageBinding('image', 'character_reference');
    }
    this.toast.show('Character reference loaded — key color auto-detected', 'info');
  }

  clearCharRef(): void {
    this.charRefBase64.set(null);
    if (this.usingComfyImage()) {
      this.settings.clearComfyImageBinding('image', 'character_reference');
    }
    this.toast.show('Character reference cleared', 'info');
  }

  async onStyleRef(files: FileList): Promise<void> {
    if (!files[0]) return;
    if (!this.styleRefEnabled()) {
      this.toast.show(
        'This Comfy workflow only has one image input — style reference is disabled.',
        'warning'
      );
      return;
    }
    this.styleRefBase64.set(await fileToDataUrl(files[0]));
    if (this.usingComfyImage()) {
      this.settings.ensureComfyImageBinding('image', 'style_reference');
    }
    this.toast.show('Style reference loaded', 'info');
  }

  clearStyleRef(): void {
    this.styleRefBase64.set(null);
    if (this.usingComfyImage()) {
      this.settings.clearComfyImageBinding('image', 'style_reference');
    }
    this.toast.show('Style reference cleared', 'info');
  }

  private async analyzeReference(dataUrl: string): Promise<void> {
    const img = await loadImage(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const scores = scoreKeyColorsFromReferenceImageData(
      imageData.data,
      canvas.width,
      canvas.height
    );
    if (scores) this.applyScores(scores);
  }

  setUseCustomPrompt(enabled: boolean): void {
    this.useCustomPrompt.set(enabled);
    localStorage.setItem('as_sprite_custom_prompt', String(enabled));
  }

  onUseCustomPromptToggle(e: Event): void {
    this.setUseCustomPrompt((e.target as HTMLInputElement).checked);
  }

  onCustomPromptChange(text: string): void {
    this.customPrompt = text;
    localStorage.setItem('as_sprite_custom_prompt_text', text);
  }

  /**
   * Built pipeline prompt, or custom override:
   * `A single {name}, {action}.` + raw user prompt (no race/chroma/framing boilerplate).
   */
  private buildPrompt(): string {
    const name = this.genCharName.trim() || 'Character';
    const action = this.charAction.trim();
    const actionText = action || 'standing in a neutral idle position';

    if (this.useCustomPrompt()) {
      const raw = this.customPrompt.trim();
      // Name + action only, then the user's tagging / freeform prompt as-is.
      return [`A single ${name}, ${actionText}.`, raw].filter(Boolean).join('\n');
    }

    const desc = this.charDesc.trim();
    const keyHex = this.keyColor();
    const keyName = colorName(keyHex);

    let raceDirective = '';
    if (this.raceMode() === 'kanolith') {
      raceDirective =
        '\nCRITICAL - KEMONOMIMI STYLE:\nThis character is a kemonomimi (moe anthropomorphism). They must have a FULLY HUMAN face - human nose, human mouth, human skin, human facial structure. They have animal ears on top of their head and an animal tail, but NO human ears. NO snout, NO fur on face, NO whiskers, NO muzzle, NO animal nose. The face must be 100% anime-human in appearance. Only the ears and tail are animal-like.\n';
    } else if (this.raceMode() === 'zoalith') {
      raceDirective =
        '\nCRITICAL - FULL ANTHROPOMORPHIC STYLE:\nThis character is a full anthropomorphic beastfolk (furry/kemono style). They should have pronounced animal facial features: a visible snout or muzzle, fur covering the face and body, animal nose, whiskers if applicable. The body structure is humanoid but the head and skin are distinctly animal.\n';
    }

    let prompt = [
      `A single ${name}${desc ? ', ' + desc : ''}, ${actionText}.`,
      raceDirective,
      `Character shown from the waist up (upper body, chest, shoulders, head). The character is positioned in the lower portion of the canvas, centered horizontally, with plenty of solid background space above the character's head.`,
      `The entire background must be a solid, uniform ${keyName.toUpperCase()} (${keyHex}) with absolutely no gradients, shadows, or variations.`,
      `Every pixel of background must be the exact same shade of ${keyName.toLowerCase()} — a single uniform matte color.`,
      `The character should be drawn in a high-quality anime/JRPG art style with clean linework and cel-shading.`,
      `The image must be exactly 1280×720 pixels.`,
      `The character has crisp, clean edges with bold dark outlines and a well-defined silhouette against the flat colored background.`,
      `Waist-up portrait composition with flat studio lighting. The character's lower body is cut off at approximately the waist or hip level by the bottom edge of the canvas. No ground, no floor, no feet visible.`,
    ]
      .filter(Boolean)
      .join('\n');

    const charRef = this.charRefBase64();
    const styleRef = this.styleRefBase64();
    if (charRef && styleRef) {
      prompt =
        'Two reference images are provided. The FIRST image (character_reference.png) is the CHARACTER REFERENCE — the generated character must look exactly like this character. The SECOND image (style_reference.png) is the STYLE REFERENCE — match its art style only. ' +
        prompt +
        '\n\nCRITICAL: The character must look like the one in character_reference.png.';
    } else if (charRef) {
      prompt += '\n\nThe character should look exactly like the one in the provided reference image.';
    } else if (styleRef) {
      prompt = 'Match the exact art style shown in the provided style reference image. ' + prompt;
    }
    return prompt;
  }

  goToSettings(): void {
    void this.router.navigateByUrl('/settings');
  }

  onImageProviderChange(value: string): void {
    if (!value) return;
    this.settings.setPreferredImageProvider(value as ImageProviderId);
    this.syncImageFormatToProvider(value as ImageProviderId);
  }

  private syncImageFormatToProvider(id: ImageProviderId): void {
    const caps = getImageProvider(id)?.caps;
    if (!caps) return;
    if (caps.aspectRatios?.length) {
      const next = resolveSelectValue(
        caps.aspectRatios,
        this.imageAspect(),
        caps.defaultAspect
      );
      this.imageAspect.set(next);
      localStorage.setItem('as_image_aspect', next);
    }
    if (caps.sizes?.length) {
      const next = resolveSelectValue(caps.sizes, this.imageSize(), caps.defaultSize);
      this.imageSize.set(next);
      localStorage.setItem('as_image_size', next);
    }
    if (caps.resolutions?.length) {
      const next = resolveSelectValue(
        caps.resolutions,
        this.imageResolution(),
        caps.defaultResolution
      );
      this.imageResolution.set(next);
      localStorage.setItem('as_image_resolution', next);
    }
  }

  onImageAspectChange(value: string): void {
    if (!value) return;
    this.imageAspect.set(value);
    localStorage.setItem('as_image_aspect', value);
  }

  onImageSizeChange(value: string): void {
    if (!value) return;
    this.imageSize.set(value);
    localStorage.setItem('as_image_size', value);
  }

  onImageResolutionChange(value: string): void {
    if (!value) return;
    this.imageResolution.set(value);
    localStorage.setItem('as_image_resolution', value);
  }

  async generate(): Promise<void> {
    if (this.generating()) return;
    if (!this.genCharName.trim()) {
      this.toast.show('Please enter a character name', 'warning');
      return;
    }
    if (this.useCustomPrompt() && !this.customPrompt.trim()) {
      this.toast.show('Enter a custom prompt, or turn off Custom Prompt mode', 'warning');
      return;
    }
    const sel = this.settings.imageProviderSelection();
    if (!sel.provider) {
      this.toast.show(
        'Add an OpenAI, Gemini, or xAI key — log in with SuperGrok — or connect Local ComfyUI in Settings first',
        'warning'
      );
      return;
    }

    this.syncImageFormatToProvider(sel.provider.id);

    this.generating.set(true);
    this.genCancelled = false;
    this.genProgress.set(sel.provider.keyProvider === 'comfy' ? 0 : -1);
    this.genStatus.set({
      type: 'info',
      text: `Generating sprite with ${sel.provider.label} — this may take up to a minute…`,
    });

    try {
      const prompt = this.buildPrompt();
      const images: { label: string; data: string }[] = [];
      if (this.charRefBase64()) {
        images.push({ label: 'character_reference', data: this.charRefBase64()! });
      }
      if (this.styleRefBase64() && this.styleRefEnabled()) {
        images.push({ label: 'style_reference', data: this.styleRefBase64()! });
      }

      const format = {
        size: this.imageSizeOptions().length ? this.imageSize() : undefined,
        aspectRatio: this.imageAspectOptions().length ? this.imageAspect() : undefined,
        resolution: this.imageResolutionOptions().length ? this.imageResolution() : undefined,
      };

      const promises: Promise<string>[] = [];
      for (let i = 0; i < this.genCount(); i++) {
        if (this.genCancelled) break;
        const idx = i;
        promises.push(
          this.api.generateImage({
            prompt,
            images,
            provider: sel.provider.id,
            ...format,
            onProgress: (p) => {
              if (this.genCancelled) return;
              const label =
                this.genCount() > 1 ? `[${idx + 1}/${this.genCount()}] ` : '';
              this.genStatus.set({
                type: 'info',
                text: `${label}${p.message || 'Working…'}`,
              });
              if (typeof p.percent === 'number' && p.percent >= 0) {
                this.genProgress.set(Math.min(100, p.percent));
              }
            },
          })
        );
      }

      const results = await Promise.allSettled(promises);
      const ok: string[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') ok.push(r.value);
      }

      this.genResults.set(ok);
      if (ok.length > 0) {
        this.selectedResult.set(ok[0]);
        this.sound.play();
        this.genStatus.set({ type: 'success', text: `✅ Generated ${ok.length} sprite(s)!` });
        setTimeout(() => scrollAppResultsIntoView(this.genResultsPanel?.nativeElement), 50);
      } else if (!this.genCancelled) {
        const errors = results
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map((r) => {
            const reason = r.reason as { message?: string } | string;
            if (typeof reason === 'string') return reason;
            if (reason?.message) return reason.message;
            return String(reason ?? 'Unknown error');
          })
          .filter((m) => !!m && m !== 'undefined' && m !== 'null');
        const unique = [...new Set(errors)];
        const detail = unique[0] || 'All generations failed. Check your API key and try again.';
        console.error('[SpritePrep] generation failures:', unique);
        this.genStatus.set({
          type: 'error',
          text: `❌ ${detail}${unique.length > 1 ? ` (+${unique.length - 1} more)` : ''}`,
        });
      }
    } catch (err) {
      this.genStatus.set({ type: 'error', text: `❌ ${(err as Error).message}` });
    } finally {
      this.generating.set(false);
      this.genProgress.set(-1);
    }
  }

  cancelGenerate(): void {
    this.genCancelled = true;
    void this.api.cancelComfyJob();
    this.toast.show('Generation cancelled', 'warning');
    this.generating.set(false);
    this.genProgress.set(-1);
  }

  selectResult(dataUrl: string): void {
    this.selectedResult.set(dataUrl);
  }

  downloadResult(dataUrl: string, idx: number): void {
    downloadDataUrl(dataUrl, `${this.pipeline.characterName() || 'sprite'}_gen_${idx + 1}.png`);
  }

  async genHandoffToVideoGen(): Promise<void> {
    if (!this.selectedResult()) {
      this.toast.show('Select a sprite first', 'warning');
      return;
    }
    const editor = this.genEditor;
    if (!editor) {
      this.toast.show('Frame editor not ready', 'warning');
      return;
    }
    try {
      const frame = await editor.exportFrame();
      if (!frame) {
        this.toast.show('Could not prepare sprite for handoff', 'error');
        return;
      }
      this.pipeline.handoffSprite({
        blob: frame.blob,
        base64: frame.base64,
        keyColor: this.keyColor(),
      });
      this.toast.show('Sprite sent to Generate Video', 'success');
      void this.router.navigate(['/video-gen']);
    } catch (err) {
      this.toast.show('Handoff failed: ' + (err as Error).message, 'error');
    }
  }

  async genHandoffToManual(): Promise<void> {
    if (!this.selectedResult()) {
      this.toast.show('Select a sprite first', 'warning');
      return;
    }
    const editor = this.genEditor;
    if (!editor) {
      this.toast.show('Frame editor not ready', 'warning');
      return;
    }
    try {
      const frame = await editor.exportFrame();
      if (!frame) {
        this.toast.show('Could not prepare sprite', 'error');
        return;
      }
      this.manualImageSrc.set(frame.base64);
      this.spriteFileName = (this.pipeline.characterName() || 'sprite') + '_gen';
      const img = await loadImage(frame.base64);
      this.applyAutoKeyColor(img);
      this.mode.set('manual');
      this.toast.show('Framed sprite loaded into Manual Upload', 'success');
    } catch (err) {
      this.toast.show('Failed to send to Manual: ' + (err as Error).message, 'error');
    }
  }

  async openAdvancedKey(): Promise<void> {
    if (!this.charRefBase64()) {
      this.toast.show('Upload a Character Reference first', 'warning');
      return;
    }
    this.showAdvKey.set(true);
    this.advKeyResults.set([]);
    this.clearAdvSelection();
    const img = await loadImage(this.charRefBase64()!);
    this.advKeyImg = img;
    const canvas = this.advKeyCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const maxW = 760;
    const maxH = 500;
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }

  closeAdvancedKey(): void {
    this.showAdvKey.set(false);
  }

  clearAdvSelection(): void {
    this.advKeyRect = null;
    this.advSelectionStyle.set({ display: 'none' });
    this.advKeyCanAnalyze.set(false);
  }

  onAdvMouseDown(e: MouseEvent): void {
    const canvas = this.advKeyCanvasRef?.nativeElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    this.advKeyStartX = e.clientX - rect.left;
    this.advKeyStartY = e.clientY - rect.top;
    this.advKeyDrawing = true;
    this.advSelectionStyle.set({
      display: 'block',
      left: `${this.advKeyStartX}px`,
      top: `${this.advKeyStartY}px`,
      width: '0px',
      height: '0px',
    });
  }

  onAdvMouseMove(e: MouseEvent): void {
    if (!this.advKeyDrawing) return;
    const canvas = this.advKeyCanvasRef?.nativeElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const curX = e.clientX - rect.left;
    const curY = e.clientY - rect.top;
    const x = Math.min(this.advKeyStartX, curX);
    const y = Math.min(this.advKeyStartY, curY);
    const w = Math.abs(curX - this.advKeyStartX);
    const h = Math.abs(curY - this.advKeyStartY);
    this.advSelectionStyle.set({
      display: 'block',
      left: `${x}px`,
      top: `${y}px`,
      width: `${w}px`,
      height: `${h}px`,
    });
  }

  onAdvMouseUp(e: MouseEvent): void {
    if (!this.advKeyDrawing) return;
    this.advKeyDrawing = false;
    const canvas = this.advKeyCanvasRef?.nativeElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const curX = e.clientX - rect.left;
    const curY = e.clientY - rect.top;
    const x = Math.max(0, Math.min(this.advKeyStartX, curX));
    const y = Math.max(0, Math.min(this.advKeyStartY, curY));
    const w = Math.min(Math.abs(curX - this.advKeyStartX), canvas.width - x);
    const h = Math.min(Math.abs(curY - this.advKeyStartY), canvas.height - y);
    if (w > 10 && h > 10) {
      this.advKeyRect = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
      this.advKeyCanAnalyze.set(true);
    } else {
      this.clearAdvSelection();
    }
  }

  runAdvAnalysis(): void {
    if (!this.advKeyRect || !this.advKeyImg) return;
    const canvas = this.advKeyCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const { x, y, w, h } = this.advKeyRect;
    const imageData = ctx.getImageData(x, y, w, h);
    const pixels = imageData.data;
    const colorMap = new Map<number, number>();
    let totalPixels = 0;

    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const a = pixels[i + 3];
      if (a < 128) continue;
      const qr = r >> 2;
      const qg = g >> 2;
      const qb = b >> 2;
      const key = (qr << 12) | (qg << 6) | qb;
      colorMap.set(key, (colorMap.get(key) || 0) + 1);
      totalPixels++;
    }

    if (totalPixels < 100) {
      this.toast.show('Selection too small or mostly transparent', 'warning');
      return;
    }

    const results = KEY_COLORS.map((keyCol) => {
      const keyLab = rgbToLab(keyCol.r, keyCol.g, keyCol.b);
      let minDist = Infinity;
      let avgDist = 0;
      let dangerPixels = 0;
      const threshold = 30;

      for (const [quantKey, count] of colorMap) {
        const qr = ((quantKey >> 12) & 0x3f) << 2;
        const qg = ((quantKey >> 6) & 0x3f) << 2;
        const qb = (quantKey & 0x3f) << 2;
        const pixLab = rgbToLab(qr, qg, qb);
        const dist = Math.sqrt(
          (keyLab.L - pixLab.L) ** 2 + (keyLab.a - pixLab.a) ** 2 + (keyLab.b - pixLab.b) ** 2
        );
        if (dist < minDist) minDist = dist;
        avgDist += dist * count;
        if (dist < threshold) dangerPixels += count;
      }

      avgDist /= totalPixels;
      const dangerPercent = (dangerPixels / totalPixels) * 100;
      const score = minDist * 0.6 + avgDist * 0.4;
      return {
        hex: keyCol.hex,
        name: keyCol.name,
        minDist: Math.round(minDist * 10) / 10,
        avgDist: Math.round(avgDist * 10) / 10,
        dangerPercent: Math.round(dangerPercent * 10) / 10,
        score: Math.round(score * 10) / 10,
      };
    });

    results.sort((a, b) => b.score - a.score);
    this.advKeyResults.set(results.map((r, i) => ({ ...r, best: i === 0 })));
  }

  selectAdvColor(hex: string): void {
    this.keyColor.set(hex);
    this.pipeline.setKeyColor(hex);
    this.toast.show(`Key color set to ${hex}`, 'success');
    this.closeAdvancedKey();
  }

  maxAdvScore(): number {
    return this.advKeyResults()[0]?.score || 1;
  }
}
