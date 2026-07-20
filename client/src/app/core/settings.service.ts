import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  DEFAULT_IMAGE_PROVIDER,
  DEFAULT_VIDEO_PROVIDER,
  IMAGE_PROVIDERS,
  VIDEO_PROVIDERS,
  type ImageProviderId,
  type VideoProviderId,
  type XaiBackend,
  availableProviders,
  resolveProvider,
  xaiBackendLabel,
  xaiBackendReady,
} from './gen-providers';
import { XaiOAuthService } from './xai-oauth.service';

const XAI_BACKEND_KEY = 'as_xai_backend';
const COMFY_URL_KEY = 'as_comfy_base_url';
const COMFY_AUTO_KEY = 'as_comfy_auto';
const COMFY_IMAGE_TPL_KEY = 'as_comfy_image_template';
const COMFY_VIDEO_TPL_KEY = 'as_comfy_video_template';
const COMFY_IMAGE_CUSTOM_KEY = 'as_comfy_image_custom';
const COMFY_VIDEO_CUSTOM_KEY = 'as_comfy_video_custom';
const COMFY_INCLUDE_API_KEY = 'as_comfy_include_api_templates';
const COMFY_IMAGE_MODELS_KEY = 'as_comfy_image_models';
const COMFY_VIDEO_MODELS_KEY = 'as_comfy_video_models';
const COMFY_IMAGE_FREE_KEY = 'as_comfy_image_free_before';
const COMFY_VIDEO_FREE_KEY = 'as_comfy_video_free_before';
const COMFY_IMAGE_BIND_KEY = 'as_comfy_image_bindings';
const COMFY_VIDEO_BIND_KEY = 'as_comfy_video_bindings';
/**
 * Preview (scrub) WebGPU: auto | cpu.
 * Migrates legacy `as_export_accel` which used to mean both preview and export.
 */
const PREVIEW_ACCEL_KEY = 'as_preview_accel';
/** Export pipeline: cpu (PNG) | gpu (WebGPU+raw). */
const EXPORT_MODE_KEY = 'as_export_mode';
/** @deprecated legacy key — migrated into preview + export settings */
const LEGACY_EXPORT_ACCEL_KEY = 'as_export_accel';

export type PreviewAccelMode = 'auto' | 'cpu';
export type ExportPipelineMode = 'cpu' | 'gpu';

function loadPreviewAccelMode(): PreviewAccelMode {
  const raw = localStorage.getItem(PREVIEW_ACCEL_KEY);
  if (raw === 'cpu' || raw === 'auto') return raw;
  // Migrate legacy toggle
  const legacy = localStorage.getItem(LEGACY_EXPORT_ACCEL_KEY);
  return legacy === 'cpu' ? 'cpu' : 'auto';
}

function loadExportPipelineMode(): ExportPipelineMode {
  const raw = localStorage.getItem(EXPORT_MODE_KEY);
  if (raw === 'cpu' || raw === 'gpu') return raw;
  // Legacy: as_export_mode=server (removed) or as_export_accel=cpu → cpu
  const legacy = localStorage.getItem(LEGACY_EXPORT_ACCEL_KEY);
  return legacy === 'cpu' ? 'cpu' : 'cpu';
}

function loadXaiBackend(): XaiBackend {
  const raw = localStorage.getItem(XAI_BACKEND_KEY);
  return raw === 'oauth' ? 'oauth' : 'api_key';
}

function loadJsonLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export interface ComfyTemplateInfo {
  id: string;
  name: string;
  title: string;
  description: string;
  tags: string[];
  models: string[];
  openSource: boolean;
  isApi: boolean;
  moduleName: string;
  category: string;
  mediaType: 'image' | 'video';
  io?: unknown;
  tutorialUrl?: string | null;
}

/** Past ComfyUI run usable as a workflow source (id is `history:<prompt_id>`). */
export interface ComfyHistoryInfo {
  id: string;
  promptId: string;
  title: string;
  description: string;
  mediaType: 'image' | 'video';
  media?: string;
  at?: number | null;
  nodeCount?: number;
  classes?: string[];
  source?: 'history';
}

export interface ComfyCandidate {
  baseUrl: string;
  local?: boolean;
}

export interface ComfyCheckpointSlot {
  nodeId: string;
  classType: string;
  title: string;
  field: string;
  current: string;
  /** User selection (may equal current). */
  selected: string;
  /** Valid files for this node class from Comfy object_info (filtered). */
  options: string[];
}

export interface ComfyUnetSlot {
  nodeId: string;
  classType: string;
  title: string;
  field: string;
  current: string;
  selected: string;
  options: string[];
}

export interface ComfyLoraSlot {
  nodeId: string;
  classType: string;
  title: string;
  field?: string;
  lora_name: string;
  strength_model: number;
  strength_clip: number;
  enabled: boolean;
  /** User selection of lora file. */
  selected: string;
  options: string[];
}

export interface ComfyVaeSlot {
  nodeId: string;
  classType: string;
  title: string;
  field: string;
  current: string;
  selected: string;
  options: string[];
}

/** CLIP / text encoder (e.g. Gemma on LTXAVTextEncoderLoader). */
export interface ComfyClipSlot {
  nodeId: string;
  classType: string;
  title: string;
  field: string;
  current: string;
  selected: string;
  options: string[];
}

export interface ComfyModelOverrides {
  checkpoints: ComfyCheckpointSlot[];
  unets: ComfyUnetSlot[];
  loras: ComfyLoraSlot[];
  vaes: ComfyVaeSlot[];
  clips: ComfyClipSlot[];
}

/** LoadImage (or similar) node that can receive an app-uploaded reference. */
export interface ComfyImageSlot {
  nodeId: string;
  classType: string;
  title: string;
  /** True when title is a custom Comfy display name (not class+id fallback). */
  hasCustomTitle?: boolean;
  field: string;
  current: string;
  index: number;
}

/**
 * Sentinel for model/LoRA dropdowns: trust the workflow, do not inject an override.
 * Non-empty so HTML <select> does not fall back to the first real file option
 * (empty-string option values are unreliable with Angular ngModel).
 */
export const COMFY_WORKFLOW_DEFAULT = '__as_workflow_default__';

/**
 * App-side image roles → Comfy LoadImage nodeId.
 * Image: character_reference, style_reference
 * Video: reference_0, start_frame, end_frame
 * Empty string = auto (fill remaining LoadImage nodes in order).
 */
export type ComfyImageRole =
  | 'character_reference'
  | 'style_reference'
  | 'reference_0'
  | 'start_frame'
  | 'end_frame';

export type ComfyImageBindings = Partial<Record<ComfyImageRole, string>>;

/** Payload sent to /api/comfy/generate under `models`. */
export interface ComfyModelsPayload {
  overrides?: Array<{ nodeId: string; field: string; value: string }>;
  checkpoints?: Array<{ nodeId: string; ckpt_name: string; field?: string }>;
  unets?: Array<{ nodeId: string; unet_name: string; field?: string }>;
  vaes?: Array<{ nodeId: string; vae_name: string; field?: string }>;
  clips?: Array<{ nodeId: string; field?: string; value?: string; clip_name?: string }>;
  loras?: Array<{
    nodeId: string;
    enabled: boolean;
    lora_name?: string;
    strength_model?: number;
    strength_clip?: number;
  }>;
}

/** Stable prefs key for one model widget (multi-field loaders need field scope). */
function modelSlotPrefKey(nodeId: string, field: string): string {
  return `${nodeId}::${field || 'value'}`;
}

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly oauth = inject(XaiOAuthService);

  readonly openaiKey = signal(localStorage.getItem('openai_api_key') ?? '');
  readonly googleKey = signal(localStorage.getItem('google_api_key') ?? '');
  readonly xaiKey = signal(localStorage.getItem('xai_api_key') ?? '');
  readonly soundEnabled = signal(localStorage.getItem('as_sound_enabled') !== 'false');

  /**
   * Interactive Export-tab preview scrub: `auto` uses WebGPU when available.
   */
  readonly previewAccelMode = signal<PreviewAccelMode>(loadPreviewAccelMode());

  /**
   * Export pipeline:
   * - cpu — browser workers + PNG → server ffmpeg (known-good)
   * - gpu — browser WebGPU key + raw RGBA → server ffmpeg
   */
  readonly exportPipelineMode = signal<ExportPipelineMode>(loadExportPipelineMode());

  /** @deprecated use previewAccelMode — kept for older call sites */
  readonly exportAccelMode = this.previewAccelMode;

  /**
   * Master toggle: which Grok credential path is used for Imagine image/video.
   * Both can be configured; only the active backend is used for generation.
   */
  readonly xaiBackend = signal<XaiBackend>(loadXaiBackend());

  /** Preferred providers (may not have a key — UI resolves a fallback). */
  readonly preferredImageProvider = signal<ImageProviderId>(
    (localStorage.getItem('as_image_provider') as ImageProviderId) || DEFAULT_IMAGE_PROVIDER
  );
  readonly preferredVideoProvider = signal<VideoProviderId>(
    (localStorage.getItem('as_video_provider') as VideoProviderId) || DEFAULT_VIDEO_PROVIDER
  );

  // --- Local ComfyUI ---
  readonly comfyBaseUrl = signal(localStorage.getItem(COMFY_URL_KEY) ?? '');
  readonly comfyAuto = signal(localStorage.getItem(COMFY_AUTO_KEY) !== 'false');
  readonly comfyConnected = signal(false);
  readonly comfyScanning = signal(false);
  readonly comfyStatusText = signal('');
  readonly comfyCandidates = signal<ComfyCandidate[]>([]);
  readonly comfyIncludeApiTemplates = signal(
    localStorage.getItem(COMFY_INCLUDE_API_KEY) === 'true'
  );
  /** Template id, or "custom". */
  readonly comfyImageTemplateId = signal(localStorage.getItem(COMFY_IMAGE_TPL_KEY) ?? '');
  readonly comfyVideoTemplateId = signal(localStorage.getItem(COMFY_VIDEO_TPL_KEY) ?? '');
  readonly comfyImageCustomWorkflow = signal(localStorage.getItem(COMFY_IMAGE_CUSTOM_KEY) ?? '');
  readonly comfyVideoCustomWorkflow = signal(localStorage.getItem(COMFY_VIDEO_CUSTOM_KEY) ?? '');
  readonly comfyImageTemplates = signal<ComfyTemplateInfo[]>([]);
  readonly comfyVideoTemplates = signal<ComfyTemplateInfo[]>([]);
  readonly comfyImageHistory = signal<ComfyHistoryInfo[]>([]);
  readonly comfyVideoHistory = signal<ComfyHistoryInfo[]>([]);

  /** Installed files on the Comfy instance. */
  readonly comfyCheckpoints = signal<string[]>([]);
  readonly comfyLoras = signal<string[]>([]);
  readonly comfyUnets = signal<string[]>([]);
  readonly comfyVaes = signal<string[]>([]);

  /** Model slots detected in the currently selected image/video workflow. */
  readonly comfyImageModelSlots = signal<ComfyModelOverrides>({
    checkpoints: [],
    unets: [],
    loras: [],
    vaes: [],
    clips: [],
  });
  readonly comfyVideoModelSlots = signal<ComfyModelOverrides>({
    checkpoints: [],
    unets: [],
    loras: [],
    vaes: [],
    clips: [],
  });
  /** LoadImage nodes in the selected image/video workflow. */
  readonly comfyImageImageSlots = signal<ComfyImageSlot[]>([]);
  readonly comfyVideoImageSlots = signal<ComfyImageSlot[]>([]);
  /** Current role → nodeId bindings for the selected workflows. */
  readonly comfyImageBindings = signal<ComfyImageBindings>({});
  readonly comfyVideoBindings = signal<ComfyImageBindings>({});
  /**
   * Unload models + free VRAM via Comfy /free before generate.
   * Defaults: image false (keep warm cache), video true (LTX-sized).
   */
  readonly comfyImageFreeBeforeRun = signal(
    localStorage.getItem(COMFY_IMAGE_FREE_KEY) === 'true'
  );
  readonly comfyVideoFreeBeforeRun = signal(
    localStorage.getItem(COMFY_VIDEO_FREE_KEY) !== 'false'
  );
  readonly comfyModelsLoading = signal(false);

  private comfyBootstrapped = false;
  /**
   * User model overrides keyed by workflow, then nodeId.
   * Shape: { [workflowKey]: { [nodeId]: { ckpt_name?|unet_name?|… } } }
   * (Old flat { [nodeId]: … } prefs are ignored — they caused wrong models across graphs.)
   */
  private comfyImageModelPrefs = loadJsonLocal<Record<string, Record<string, unknown>>>(
    COMFY_IMAGE_MODELS_KEY,
    {}
  );
  private comfyVideoModelPrefs = loadJsonLocal<Record<string, Record<string, unknown>>>(
    COMFY_VIDEO_MODELS_KEY,
    {}
  );
  /** Per-workflow role → LoadImage nodeId bindings. */
  private comfyImageBindPrefs = loadJsonLocal<Record<string, ComfyImageBindings>>(
    COMFY_IMAGE_BIND_KEY,
    {}
  );
  private comfyVideoBindPrefs = loadJsonLocal<Record<string, ComfyImageBindings>>(
    COMFY_VIDEO_BIND_KEY,
    {}
  );

  readonly keys = computed(() => {
    // Depend on OAuth epoch so provider lists update after login/logout
    this.oauth.authEpoch();
    return {
      openai: this.openaiKey(),
      google: this.googleKey(),
      xai: this.xaiKey(),
      xaiOAuth: this.oauth.isLoggedIn(),
      xaiBackend: this.xaiBackend(),
      comfyConnected: this.comfyConnected(),
    };
  });

  /** Whether the currently selected Grok backend has credentials. */
  readonly xaiReady = computed(() => xaiBackendReady(this.keys()));

  /** Short label for UI: "SuperGrok OAuth" | "API Key" */
  readonly xaiBackendLabel = computed(() => xaiBackendLabel(this.xaiBackend()));

  readonly availableImageProviders = computed(() =>
    availableProviders(IMAGE_PROVIDERS, this.keys())
  );
  readonly availableVideoProviders = computed(() =>
    availableProviders(VIDEO_PROVIDERS, this.keys())
  );

  /** Resolved selection for image gen (with fallback metadata). */
  readonly imageProviderSelection = computed(() =>
    resolveProvider(IMAGE_PROVIDERS, this.preferredImageProvider(), this.keys())
  );
  readonly videoProviderSelection = computed(() =>
    resolveProvider(VIDEO_PROVIDERS, this.preferredVideoProvider(), this.keys())
  );

  constructor(private readonly http: HttpClient) {
    // Probe Comfy status once after construct (async)
    queueMicrotask(() => void this.bootstrapComfy());
  }

  /**
   * Sync connection state with the local proxy; optionally auto-scan / reconnect.
   */
  async bootstrapComfy(): Promise<void> {
    if (this.comfyBootstrapped) return;
    this.comfyBootstrapped = true;
    try {
      const status = await firstValueFrom(
        this.http.get<{
          connected?: boolean;
          baseUrl?: string | null;
        }>('/api/comfy/status')
      );
      if (status?.connected && status.baseUrl) {
        this.comfyConnected.set(true);
        this.comfyBaseUrl.set(status.baseUrl);
        localStorage.setItem(COMFY_URL_KEY, status.baseUrl);
        this.comfyStatusText.set(`Connected · ${status.baseUrl}`);
        await this.refreshComfyTemplates();
        return;
      }

      const saved = this.comfyBaseUrl().trim();
      if (saved) {
        try {
          await this.connectComfy(saved, false);
          return;
        } catch {
          /* fall through to auto-scan */
        }
      }

      if (this.comfyAuto()) {
        await this.scanComfy({ lan: false, autoConnect: true });
      }
    } catch {
      // Server may not be up yet in pure ng serve without proxy — ignore
    }
  }

  setComfyAuto(enabled: boolean): void {
    this.comfyAuto.set(enabled);
    localStorage.setItem(COMFY_AUTO_KEY, String(enabled));
  }

  /**
   * Toggle cloud API templates in the catalog and immediately re-fetch lists
   * (users should not need a separate Refresh click).
   */
  async setComfyIncludeApiTemplates(enabled: boolean): Promise<void> {
    this.comfyIncludeApiTemplates.set(enabled);
    localStorage.setItem(COMFY_INCLUDE_API_KEY, String(enabled));
    await this.refreshComfyTemplates();
  }

  /** Display label for a template option — marks cloud/API entries clearly. */
  comfyTemplateOptionLabel(t: { title?: string; name?: string; isApi?: boolean }): string {
    const name = (t.title || t.name || '').trim() || 'Untitled';
    return t.isApi ? `☁️ ${name}` : name;
  }

  /**
   * Open the connected ComfyUI web UI in a new browser tab.
   * Comfy serves its full graph editor at the instance root (same host:port as the API).
   * Returns false if not connected / no URL.
   */
  openComfyUi(): boolean {
    const raw = (this.comfyBaseUrl() || '').trim();
    if (!raw) return false;
    let url = raw.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }

  setComfyImageTemplateId(id: string): void {
    this.comfyImageTemplateId.set(id);
    if (id) localStorage.setItem(COMFY_IMAGE_TPL_KEY, id);
    else localStorage.removeItem(COMFY_IMAGE_TPL_KEY);
    void this.inspectComfyWorkflow('image');
  }

  setComfyVideoTemplateId(id: string): void {
    this.comfyVideoTemplateId.set(id);
    if (id) localStorage.setItem(COMFY_VIDEO_TPL_KEY, id);
    else localStorage.removeItem(COMFY_VIDEO_TPL_KEY);
    void this.inspectComfyWorkflow('video');
  }

  setComfyImageCustomWorkflow(json: string): void {
    this.comfyImageCustomWorkflow.set(json);
    if (json.trim()) localStorage.setItem(COMFY_IMAGE_CUSTOM_KEY, json);
    else localStorage.removeItem(COMFY_IMAGE_CUSTOM_KEY);
    if (this.comfyImageTemplateId() === 'custom') {
      void this.inspectComfyWorkflow('image');
    }
  }

  setComfyVideoCustomWorkflow(json: string): void {
    this.comfyVideoCustomWorkflow.set(json);
    if (json.trim()) localStorage.setItem(COMFY_VIDEO_CUSTOM_KEY, json);
    else localStorage.removeItem(COMFY_VIDEO_CUSTOM_KEY);
    if (this.comfyVideoTemplateId() === 'custom') {
      void this.inspectComfyWorkflow('video');
    }
  }

  async scanComfy(opts?: { lan?: boolean; autoConnect?: boolean }): Promise<ComfyCandidate[]> {
    this.comfyScanning.set(true);
    this.comfyStatusText.set(
      opts?.lan === false ? 'Scanning localhost…' : 'Scanning localhost + LAN…'
    );
    try {
      const data = await firstValueFrom(
        this.http.post<{
          candidates?: ComfyCandidate[];
          connected?: { baseUrl?: string } | null;
          error?: string;
        }>('/api/comfy/scan', {
          lan: opts?.lan !== false,
          autoConnect: opts?.autoConnect !== false && this.comfyAuto(),
        })
      );
      const candidates = data?.candidates || [];
      this.comfyCandidates.set(candidates);

      if (data?.connected?.baseUrl) {
        this.comfyConnected.set(true);
        this.comfyBaseUrl.set(data.connected.baseUrl);
        localStorage.setItem(COMFY_URL_KEY, data.connected.baseUrl);
        this.comfyStatusText.set(`Connected · ${data.connected.baseUrl}`);
        await this.refreshComfyTemplates();
      } else if (candidates.length) {
        this.comfyStatusText.set(`Found ${candidates.length} instance(s) — pick one to connect`);
      } else {
        this.comfyConnected.set(false);
        this.comfyStatusText.set('No ComfyUI instances found');
      }
      return candidates;
    } catch (err) {
      this.comfyStatusText.set((err as Error).message || 'Scan failed');
      throw err;
    } finally {
      this.comfyScanning.set(false);
    }
  }

  async connectComfy(baseUrl: string, persist = true): Promise<void> {
    const url = baseUrl.trim();
    if (!url) throw new Error('Enter a ComfyUI URL (e.g. http://127.0.0.1:8188)');
    this.comfyStatusText.set(`Connecting to ${url}…`);
    try {
      const data = await firstValueFrom(
        this.http.post<{
          connected?: { baseUrl?: string };
          error?: string;
        }>('/api/comfy/connect', { baseUrl: url })
      );
      const connectedUrl = data?.connected?.baseUrl || url;
      this.comfyConnected.set(true);
      this.comfyBaseUrl.set(connectedUrl);
      if (persist) localStorage.setItem(COMFY_URL_KEY, connectedUrl);
      this.comfyStatusText.set(`Connected · ${connectedUrl}`);
      await this.refreshComfyTemplates();
    } catch (err) {
      this.comfyConnected.set(false);
      const msg = this.formatHttpApiError(err, 'Could not connect to ComfyUI');
      this.comfyStatusText.set(msg);
      throw new Error(msg);
    }
  }

  async disconnectComfy(): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/api/comfy/disconnect', {}));
    } catch {
      /* ignore */
    }
    this.comfyConnected.set(false);
    this.comfyStatusText.set('Disconnected');
    this.comfyImageTemplates.set([]);
    this.comfyVideoTemplates.set([]);
    this.comfyImageHistory.set([]);
    this.comfyVideoHistory.set([]);
    this.comfyCheckpoints.set([]);
    this.comfyLoras.set([]);
    this.comfyUnets.set([]);
    this.comfyVaes.set([]);
    this.comfyImageModelSlots.set({ checkpoints: [], unets: [], loras: [], vaes: [], clips: [] });
    this.comfyVideoModelSlots.set({ checkpoints: [], unets: [], loras: [], vaes: [], clips: [] });
    this.comfyImageImageSlots.set([]);
    this.comfyVideoImageSlots.set([]);
    this.comfyImageBindings.set({});
    this.comfyVideoBindings.set({});
  }

  async testComfy(baseUrl?: string): Promise<void> {
    const url = (baseUrl ?? this.comfyBaseUrl()).trim();
    if (!url) throw new Error('Enter a ComfyUI URL first');
    await firstValueFrom(
      this.http.post('/api/comfy/test', { baseUrl: url, connect: true })
    );
    this.comfyConnected.set(true);
    this.comfyBaseUrl.set(url);
    localStorage.setItem(COMFY_URL_KEY, url);
    this.comfyStatusText.set(`Connected · ${url}`);
    await this.refreshComfyTemplates();
  }

  async refreshComfyTemplates(): Promise<void> {
    if (!this.comfyConnected()) {
      this.comfyImageTemplates.set([]);
      this.comfyVideoTemplates.set([]);
      this.comfyImageHistory.set([]);
      this.comfyVideoHistory.set([]);
      return;
    }
    const includeApi = this.comfyIncludeApiTemplates();
    // Cache-bust so toggling includeApi always hits the server (never a stale GET).
    const bust = `_=${Date.now()}`;
    const q = `${includeApi ? 'includeApi=1' : 'includeApi=0'}&${bust}`;
    try {
      const [img, vid, imgHist, vidHist] = await Promise.all([
        firstValueFrom(
          this.http.get<{ templates?: ComfyTemplateInfo[] }>(
            `/api/comfy/templates?media=image&${q}`
          )
        ),
        firstValueFrom(
          this.http.get<{ templates?: ComfyTemplateInfo[] }>(
            `/api/comfy/templates?media=video&${q}`
          )
        ),
        firstValueFrom(
          this.http.get<{ history?: ComfyHistoryInfo[] }>(`/api/comfy/history?media=image&max=40`)
        ).catch(() => ({ history: [] as ComfyHistoryInfo[] })),
        firstValueFrom(
          this.http.get<{ history?: ComfyHistoryInfo[] }>(`/api/comfy/history?media=video&max=40`)
        ).catch(() => ({ history: [] as ComfyHistoryInfo[] })),
      ]);
      const imageTemplates = img?.templates || [];
      const videoTemplates = vid?.templates || [];
      const imageHistory = imgHist?.history || [];
      const videoHistory = vidHist?.history || [];
      // New array refs so selects always re-render when the toggle changes
      this.comfyImageTemplates.set([...imageTemplates]);
      this.comfyVideoTemplates.set([...videoTemplates]);
      this.comfyImageHistory.set([...imageHistory]);
      this.comfyVideoHistory.set([...videoHistory]);

      // Drop selection if it pointed at a template no longer in the list
      // (e.g. cloud API template after unchecking "Show cloud API templates")
      this.pruneInvalidComfyTemplateSelection(
        'image',
        imageTemplates,
        imageHistory
      );
      this.pruneInvalidComfyTemplateSelection(
        'video',
        videoTemplates,
        videoHistory
      );

      // Auto-pick: prefer first history, else first template — only if nothing selected
      // (set signals directly to avoid mid-refresh inspect storms)
      if (!this.comfyImageTemplateId()) {
        const pick = imageHistory[0]?.id || imageTemplates[0]?.id;
        if (pick) {
          this.comfyImageTemplateId.set(pick);
          localStorage.setItem(COMFY_IMAGE_TPL_KEY, pick);
        }
      }
      if (!this.comfyVideoTemplateId()) {
        const pick = videoHistory[0]?.id || videoTemplates[0]?.id;
        if (pick) {
          this.comfyVideoTemplateId.set(pick);
          localStorage.setItem(COMFY_VIDEO_TPL_KEY, pick);
        }
      }

      await this.refreshComfyInstalledModels();
      await Promise.all([
        this.inspectComfyWorkflow('image'),
        this.inspectComfyWorkflow('video'),
      ]);
    } catch (err) {
      console.warn('[Comfy] template refresh failed', err);
      throw err;
    }
  }

  /**
   * If the selected template id is not custom/history/present, clear it so the
   * dropdown does not keep a ghost cloud selection after includeApi is turned off.
   */
  private pruneInvalidComfyTemplateSelection(
    kind: 'image' | 'video',
    templates: ComfyTemplateInfo[],
    history: ComfyHistoryInfo[]
  ): void {
    const id =
      kind === 'image' ? this.comfyImageTemplateId() : this.comfyVideoTemplateId();
    if (!id || id === 'custom') return;
    if (id.startsWith('history:')) {
      if (history.some((h) => h.id === id)) return;
    } else if (templates.some((t) => t.id === id)) {
      return;
    }
    if (kind === 'image') {
      this.comfyImageTemplateId.set('');
      localStorage.removeItem(COMFY_IMAGE_TPL_KEY);
    } else {
      this.comfyVideoTemplateId.set('');
      localStorage.removeItem(COMFY_VIDEO_TPL_KEY);
    }
  }

  async refreshComfyInstalledModels(): Promise<void> {
    if (!this.comfyConnected()) return;
    try {
      const data = await firstValueFrom(
        this.http.get<{
          checkpoints?: string[];
          loras?: string[];
          diffusion_models?: string[];
          vae?: string[];
          models?: Record<string, string[]>;
        }>('/api/comfy/models')
      );
      this.comfyCheckpoints.set(data?.checkpoints || data?.models?.['checkpoints'] || []);
      this.comfyLoras.set(data?.loras || data?.models?.['loras'] || []);
      this.comfyUnets.set(
        data?.diffusion_models ||
          data?.models?.['diffusion_models'] ||
          data?.models?.['unet'] ||
          []
      );
      this.comfyVaes.set(data?.vae || data?.models?.['vae'] || []);
    } catch (err) {
      console.warn('[Comfy] models list failed', err);
    }
  }

  /**
   * Inspect the selected image or video workflow for checkpoint / LoRA slots.
   */
  async inspectComfyWorkflow(kind: 'image' | 'video'): Promise<void> {
    if (!this.comfyConnected()) return;

    const templateId =
      kind === 'image' ? this.comfyImageTemplateId() : this.comfyVideoTemplateId();
    const body: Record<string, unknown> = {};

    if (templateId === 'custom') {
      const customWorkflow =
        kind === 'image'
          ? this.comfyImageCustomWorkflow().trim()
          : this.comfyVideoCustomWorkflow().trim();
      if (!customWorkflow) {
        this.setModelSlots(kind, {
          checkpoints: [],
          unets: [],
          loras: [],
          vaes: [],
          clips: [],
        });
        this.setImageSlots(kind, []);
        return;
      }
      body['customWorkflow'] = customWorkflow;
    } else if (templateId) {
      body['templateId'] = templateId;
    } else {
      this.setModelSlots(kind, {
        checkpoints: [],
        unets: [],
        loras: [],
        vaes: [],
        clips: [],
      });
      this.setImageSlots(kind, []);
      return;
    }

    this.comfyModelsLoading.set(true);
    try {

      const data = await firstValueFrom(
        this.http.post<{
          checkpoints?: Array<{
            nodeId: string;
            classType: string;
            title: string;
            field: string;
            current: string;
            options?: string[];
          }>;
          unets?: Array<{
            nodeId: string;
            classType: string;
            title: string;
            field: string;
            current: string;
            options?: string[];
          }>;
          loras?: Array<{
            nodeId: string;
            classType: string;
            title: string;
            field?: string;
            lora_name: string;
            current?: string;
            strength_model: number;
            strength_clip: number;
            enabled: boolean;
            options?: string[];
          }>;
          vaes?: Array<{
            nodeId: string;
            classType: string;
            title: string;
            field: string;
            current: string;
            options?: string[];
          }>;
          clips?: Array<{
            nodeId: string;
            classType: string;
            title: string;
            field: string;
            current: string;
            options?: string[];
          }>;
          images?: Array<{
            nodeId: string;
            classType: string;
            title: string;
            field: string;
            current: string;
            index: number;
          }>;
          imageSlotCount?: number;
        }>('/api/comfy/inspect-workflow', body)
      );

      // Only restore overrides saved for *this* workflow — never cross-apply node IDs
      // from a previous graph (that was hanging LTX/video by forcing SD checkpoints onto UNETs).
      const wfKey = this.comfyWorkflowPrefsKey(kind);
      const allPrefs = kind === 'image' ? this.comfyImageModelPrefs : this.comfyVideoModelPrefs;
      const prefs = (allPrefs[wfKey] || {}) as Record<string, Record<string, unknown>>;

      /**
       * Default is always Workflow Default (trust the graph).
       * Only restore a pref when it is an explicit *different* file from `current`
       * and still listed in this node's options. Never invent options[0].
       */
      const pickSelected = (
        prefVal: string | undefined,
        current: string,
        options: string[]
      ): string => {
        if (prefVal == null) return COMFY_WORKFLOW_DEFAULT;
        const v = String(prefVal).trim();
        if (!v || v === COMFY_WORKFLOW_DEFAULT) return COMFY_WORKFLOW_DEFAULT;
        // Same as graph → no override needed
        if (current && v === current) return COMFY_WORKFLOW_DEFAULT;
        // Invalid for this node (wrong folder / stale pref from another graph)
        if (options.length && !options.includes(v)) return COMFY_WORKFLOW_DEFAULT;
        return v;
      };

      const readPref = (nodeId: string, field: string, legacyKeys: string[]): string | undefined => {
        const scoped = prefs[modelSlotPrefKey(nodeId, field)] as
          | { value?: string; [k: string]: unknown }
          | string
          | undefined;
        if (typeof scoped === 'string') return scoped;
        if (scoped && typeof scoped === 'object') {
          if (typeof scoped.value === 'string') return scoped.value;
          if (typeof scoped[field] === 'string') return scoped[field] as string;
        }
        // Legacy nodeId-only prefs (ambiguous for multi-field nodes — only use for single known key)
        const legacy = prefs[nodeId] as Record<string, unknown> | undefined;
        if (!legacy || typeof legacy !== 'object') return undefined;
        for (const k of legacyKeys) {
          if (typeof legacy[k] === 'string') return legacy[k] as string;
        }
        return undefined;
      };

      const checkpoints: ComfyCheckpointSlot[] = (data?.checkpoints || []).map((c) => {
        const options = c.options?.length ? c.options : [];
        const field = c.field || 'ckpt_name';
        const selected = pickSelected(
          readPref(c.nodeId, field, ['ckpt_name', 'value']),
          c.current || '',
          options
        );
        return { ...c, field, options, selected };
      });

      const unets: ComfyUnetSlot[] = (data?.unets || []).map((u) => {
        const options = u.options?.length ? u.options : [];
        const field = u.field || 'unet_name';
        const selected = pickSelected(
          readPref(u.nodeId, field, ['unet_name', 'value']),
          u.current || '',
          options
        );
        return { ...u, field, options, selected };
      });

      const loras: ComfyLoraSlot[] = (data?.loras || []).map((l) => {
        const options = l.options?.length ? l.options : [];
        const prefScoped = prefs[modelSlotPrefKey(l.nodeId, l.field || 'lora_name')] as
          | {
              enabled?: boolean;
              lora_name?: string;
              value?: string;
              strength_model?: number;
              strength_clip?: number;
            }
          | undefined;
        const prefLegacy = prefs[l.nodeId] as typeof prefScoped;
        const pref = prefScoped || prefLegacy;
        const current = l.lora_name || l.current || '';
        const selected = pickSelected(pref?.lora_name || pref?.value, current, options);
        return {
          ...l,
          options,
          lora_name: current,
          enabled: pref?.enabled ?? l.enabled ?? true,
          selected,
          strength_model:
            typeof pref?.strength_model === 'number' ? pref.strength_model : l.strength_model,
          strength_clip:
            typeof pref?.strength_clip === 'number' ? pref.strength_clip : l.strength_clip,
        };
      });

      const vaes: ComfyVaeSlot[] = (data?.vaes || []).map((v) => {
        const options = v.options?.length ? v.options : [];
        const field = v.field || 'vae_name';
        const selected = pickSelected(
          readPref(v.nodeId, field, ['vae_name', 'value', 'ckpt_name']),
          v.current || '',
          options
        );
        return { ...v, field, options, selected };
      });

      const clips: ComfyClipSlot[] = (data?.clips || []).map((cl) => {
        const options = cl.options?.length ? cl.options : [];
        const field = cl.field || 'clip_name';
        const selected = pickSelected(
          readPref(cl.nodeId, field, ['text_encoder', 'clip_name', 'value']),
          cl.current || '',
          options
        );
        return { ...cl, field, options, selected };
      });

      this.setModelSlots(kind, { checkpoints, unets, loras, vaes, clips });

      const imageSlots: ComfyImageSlot[] = (data?.images || []).map((im, i) => ({
        nodeId: String(im.nodeId),
        classType: im.classType || 'LoadImage',
        title: im.title || `LoadImage ${im.nodeId}`,
        hasCustomTitle: !!(im as { hasCustomTitle?: boolean }).hasCustomTitle || !!(im.title && im.title !== `LoadImage ${im.nodeId}`),
        field: im.field || 'image',
        current: im.current || '',
        index: typeof im.index === 'number' ? im.index : i,
      }));
      this.setImageSlots(kind, imageSlots);
      this.applyImageBindingsForWorkflow(kind, imageSlots);
      // Do not rewrite prefs on inspect — only when the user changes a control
    } catch (err) {
      console.warn('[Comfy] inspect workflow failed', err);
      this.setModelSlots(kind, {
        checkpoints: [],
        unets: [],
        loras: [],
        vaes: [],
        clips: [],
      });
      this.setImageSlots(kind, []);
    } finally {
      this.comfyModelsLoading.set(false);
    }
  }

  private setModelSlots(kind: 'image' | 'video', slots: ComfyModelOverrides): void {
    if (kind === 'image') this.comfyImageModelSlots.set(slots);
    else this.comfyVideoModelSlots.set(slots);
  }

  private setImageSlots(kind: 'image' | 'video', slots: ComfyImageSlot[]): void {
    if (kind === 'image') this.comfyImageImageSlots.set(slots);
    else this.comfyVideoImageSlots.set(slots);
  }

  /**
   * Restore only user-saved bindings that still point at a real LoadImage node.
   * No auto-assignment — roles stay None until a reference is uploaded (or user picks).
   */
  private applyImageBindingsForWorkflow(kind: 'image' | 'video', slots: ComfyImageSlot[]): void {
    const wfKey = this.comfyWorkflowPrefsKey(kind);
    const saved =
      kind === 'image' ? this.comfyImageBindPrefs[wfKey] : this.comfyVideoBindPrefs[wfKey];
    const validIds = new Set(slots.map((s) => s.nodeId));
    const merged: ComfyImageBindings = {};
    if (saved && typeof saved === 'object') {
      for (const [role, nodeId] of Object.entries(saved) as [ComfyImageRole, string][]) {
        if (nodeId && validIds.has(nodeId)) merged[role] = nodeId;
        // Explicit empty string stays as None
        else if (nodeId === '') merged[role] = '';
      }
    }
    // Drop roles that point at missing nodes
    for (const role of Object.keys(merged) as ComfyImageRole[]) {
      const id = merged[role];
      if (id && !validIds.has(id)) delete merged[role];
    }
    if (kind === 'image') this.comfyImageBindings.set(merged);
    else this.comfyVideoBindings.set(merged);
  }

  setComfyFreeBeforeRun(kind: 'image' | 'video', enabled: boolean): void {
    if (kind === 'image') {
      this.comfyImageFreeBeforeRun.set(enabled);
      localStorage.setItem(COMFY_IMAGE_FREE_KEY, String(enabled));
    } else {
      this.comfyVideoFreeBeforeRun.set(enabled);
      localStorage.setItem(COMFY_VIDEO_FREE_KEY, String(enabled));
    }
  }

  updateComfyImageBinding(kind: 'image' | 'video', role: ComfyImageRole, nodeId: string): void {
    const current = kind === 'image' ? this.comfyImageBindings() : this.comfyVideoBindings();
    const next: ComfyImageBindings = { ...current, [role]: nodeId };
    if (kind === 'image') this.comfyImageBindings.set(next);
    else this.comfyVideoBindings.set(next);

    const wfKey = this.comfyWorkflowPrefsKey(kind);
    if (kind === 'image') {
      this.comfyImageBindPrefs = { ...this.comfyImageBindPrefs, [wfKey]: next };
      localStorage.setItem(COMFY_IMAGE_BIND_KEY, JSON.stringify(this.comfyImageBindPrefs));
    } else {
      this.comfyVideoBindPrefs = { ...this.comfyVideoBindPrefs, [wfKey]: next };
      localStorage.setItem(COMFY_VIDEO_BIND_KEY, JSON.stringify(this.comfyVideoBindPrefs));
    }
  }

  /**
   * Forget a role assignment entirely (image cleared from the app).
   * Differs from setting None (`''`): missing means “may auto-assign on next upload”.
   */
  clearComfyImageBinding(kind: 'image' | 'video', role: ComfyImageRole): void {
    const current = kind === 'image' ? this.comfyImageBindings() : this.comfyVideoBindings();
    if (!(role in current)) return;
    const next: ComfyImageBindings = { ...current };
    delete next[role];
    if (kind === 'image') this.comfyImageBindings.set(next);
    else this.comfyVideoBindings.set(next);

    const wfKey = this.comfyWorkflowPrefsKey(kind);
    if (kind === 'image') {
      this.comfyImageBindPrefs = { ...this.comfyImageBindPrefs, [wfKey]: next };
      localStorage.setItem(COMFY_IMAGE_BIND_KEY, JSON.stringify(this.comfyImageBindPrefs));
    } else {
      this.comfyVideoBindPrefs = { ...this.comfyVideoBindPrefs, [wfKey]: next };
      localStorage.setItem(COMFY_VIDEO_BIND_KEY, JSON.stringify(this.comfyVideoBindPrefs));
    }
  }

  /**
   * When the user uploads a reference for `role`, pick a free LoadImage node if
   * none is assigned yet. Prefers nodes not already used by other roles.
   * Does not override an explicit None (`''`) the user chose in the dropdown.
   * Returns the chosen nodeId, or null if none / None / no slots.
   */
  ensureComfyImageBinding(kind: 'image' | 'video', role: ComfyImageRole): string | null {
    const slots =
      kind === 'image' ? this.comfyImageImageSlots() : this.comfyVideoImageSlots();
    if (!slots.length) return null;

    const bindings = kind === 'image' ? this.comfyImageBindings() : this.comfyVideoBindings();
    const existing = bindings[role];
    // Explicit None — user disabled injection for this role; do not re-assign
    if (existing === '') return null;
    if (existing && slots.some((s) => s.nodeId === existing)) {
      return existing;
    }

    const usedByOthers = new Set(
      (Object.entries(bindings) as [ComfyImageRole, string | undefined][])
        .filter(([r, id]) => r !== role && !!id)
        .map(([, id]) => id as string)
    );
    const free = slots.find((s) => !usedByOthers.has(s.nodeId));
    const pick = (free || slots[0]).nodeId;
    this.updateComfyImageBinding(kind, role, pick);
    return pick;
  }

  /** How many LoadImage nodes the current workflow exposes. */
  comfyImageSlotCount(kind: 'image' | 'video'): number {
    return kind === 'image'
      ? this.comfyImageImageSlots().length
      : this.comfyVideoImageSlots().length;
  }

  /**
   * Build generate payload images with nodeId from role bindings.
   * Roles set to None (empty) are skipped — no injection for that image.
   * If a role has data but no binding yet, auto-assign a free slot once.
   */
  comfyImagesWithBindings(
    kind: 'image' | 'video',
    items: Array<{ label: string; data: string; role?: ComfyImageRole }>
  ): Array<{ label: string; data: string; nodeId?: string }> {
    const out: Array<{ label: string; data: string; nodeId?: string }> = [];
    for (const it of items) {
      if (!it.data) continue;
      const role = (it.role || it.label) as ComfyImageRole;
      const bindings = kind === 'image' ? this.comfyImageBindings() : this.comfyVideoBindings();
      let nodeId = bindings[role];
      // Explicit None — user chose not to inject this role
      if (nodeId === '') continue;
      if (!nodeId) {
        nodeId = this.ensureComfyImageBinding(kind, role) || undefined;
      }
      if (!nodeId) {
        // No LoadImage nodes in workflow — skip (nothing to bind to)
        continue;
      }
      out.push({ label: it.label, data: it.data, nodeId });
    }
    return out;
  }

  /** Stable key for the currently selected image/video workflow (for model prefs). */
  private comfyWorkflowPrefsKey(kind: 'image' | 'video'): string {
    const id = kind === 'image' ? this.comfyImageTemplateId() : this.comfyVideoTemplateId();
    if (!id) return `${kind}:none`;
    if (id === 'custom') {
      const raw =
        kind === 'image' ? this.comfyImageCustomWorkflow() : this.comfyVideoCustomWorkflow();
      let h = 0;
      const s = raw.slice(0, 8000);
      for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
      return `${kind}:custom:${h}`;
    }
    return `${kind}:${id}`;
  }

  private persistModelPrefs(kind: 'image' | 'video'): void {
    const slots = kind === 'image' ? this.comfyImageModelSlots() : this.comfyVideoModelSlots();
    const wfKey = this.comfyWorkflowPrefsKey(kind);
    const nodePrefs: Record<string, unknown> = {};

    // Only persist explicit overrides that differ from the graph — keyed by nodeId::field
    const saveFile = (
      nodeId: string,
      field: string,
      selected: string,
      current: string
    ): void => {
      if (!selected || selected === COMFY_WORKFLOW_DEFAULT) return;
      if (current && selected === current) return; // same as graph — not an override
      nodePrefs[modelSlotPrefKey(nodeId, field)] = { value: selected, field };
    };

    for (const c of slots.checkpoints) {
      saveFile(c.nodeId, c.field || 'ckpt_name', c.selected, c.current);
    }
    for (const u of slots.unets) {
      saveFile(u.nodeId, u.field || 'unet_name', u.selected, u.current);
    }
    for (const v of slots.vaes) {
      saveFile(v.nodeId, v.field || 'vae_name', v.selected, v.current);
    }
    for (const cl of slots.clips || []) {
      saveFile(cl.nodeId, cl.field || 'clip_name', cl.selected, cl.current);
    }
    for (const l of slots.loras) {
      const field = l.field || 'lora_name';
      const nameOverride =
        !!l.selected &&
        l.selected !== COMFY_WORKFLOW_DEFAULT &&
        l.selected !== l.lora_name;
      const enabledDefault = l.enabled !== false;
      if (nameOverride || !enabledDefault || l.strength_model !== 1 || l.strength_clip !== 1) {
        const entry: Record<string, unknown> = {
          enabled: l.enabled,
          strength_model: l.strength_model,
          strength_clip: l.strength_clip,
          field,
        };
        if (nameOverride) entry['value'] = l.selected;
        if (nameOverride) entry['lora_name'] = l.selected;
        nodePrefs[modelSlotPrefKey(l.nodeId, field)] = entry;
      }
    }

    if (kind === 'image') {
      const next = { ...this.comfyImageModelPrefs, [wfKey]: nodePrefs };
      this.comfyImageModelPrefs = next;
      localStorage.setItem(COMFY_IMAGE_MODELS_KEY, JSON.stringify(next));
    } else {
      const next = { ...this.comfyVideoModelPrefs, [wfKey]: nodePrefs };
      this.comfyVideoModelPrefs = next;
      localStorage.setItem(COMFY_VIDEO_MODELS_KEY, JSON.stringify(next));
    }
  }

  updateComfyCheckpoint(
    kind: 'image' | 'video',
    nodeId: string,
    ckptName: string,
    field?: string
  ): void {
    const slots = kind === 'image' ? this.comfyImageModelSlots() : this.comfyVideoModelSlots();
    const fld = field || 'ckpt_name';
    const next = {
      ...slots,
      checkpoints: slots.checkpoints.map((c) =>
        c.nodeId === nodeId && (c.field || 'ckpt_name') === fld
          ? { ...c, selected: ckptName }
          : c
      ),
    };
    this.setModelSlots(kind, next);
    this.persistModelPrefs(kind);
  }

  updateComfyUnet(
    kind: 'image' | 'video',
    nodeId: string,
    unetName: string,
    field?: string
  ): void {
    const slots = kind === 'image' ? this.comfyImageModelSlots() : this.comfyVideoModelSlots();
    const fld = field || 'unet_name';
    const next = {
      ...slots,
      unets: slots.unets.map((u) =>
        u.nodeId === nodeId && (u.field || 'unet_name') === fld
          ? { ...u, selected: unetName }
          : u
      ),
    };
    this.setModelSlots(kind, next);
    this.persistModelPrefs(kind);
  }

  updateComfyVae(
    kind: 'image' | 'video',
    nodeId: string,
    vaeName: string,
    field?: string
  ): void {
    const slots = kind === 'image' ? this.comfyImageModelSlots() : this.comfyVideoModelSlots();
    const fld = field || 'vae_name';
    const next = {
      ...slots,
      vaes: slots.vaes.map((v) =>
        v.nodeId === nodeId && (v.field || 'vae_name') === fld ? { ...v, selected: vaeName } : v
      ),
    };
    this.setModelSlots(kind, next);
    this.persistModelPrefs(kind);
  }

  updateComfyClip(
    kind: 'image' | 'video',
    nodeId: string,
    value: string,
    field?: string
  ): void {
    const slots = kind === 'image' ? this.comfyImageModelSlots() : this.comfyVideoModelSlots();
    const fld = field || 'clip_name';
    const clips = slots.clips || [];
    const next = {
      ...slots,
      clips: clips.map((c) =>
        c.nodeId === nodeId && (c.field || 'clip_name') === fld ? { ...c, selected: value } : c
      ),
    };
    this.setModelSlots(kind, next);
    this.persistModelPrefs(kind);
  }

  updateComfyLora(
    kind: 'image' | 'video',
    nodeId: string,
    patch: Partial<Pick<ComfyLoraSlot, 'enabled' | 'selected' | 'strength_model' | 'strength_clip'>>
  ): void {
    const slots = kind === 'image' ? this.comfyImageModelSlots() : this.comfyVideoModelSlots();
    const next = {
      ...slots,
      loras: slots.loras.map((l) => (l.nodeId === nodeId ? { ...l, ...patch } : l)),
    };
    this.setModelSlots(kind, next);
    this.persistModelPrefs(kind);
  }

  /**
   * Build models payload for /api/comfy/generate.
   * **Workflow Default means do not inject** — trust the graph file as-is.
   * Only sends values that differ from `current` (graph default).
   */
  comfyModelsPayload(kind: 'image' | 'video'): ComfyModelsPayload {
    const slots = kind === 'image' ? this.comfyImageModelSlots() : this.comfyVideoModelSlots();
    const payload: ComfyModelsPayload = {};
    const overrides: Array<{ nodeId: string; field: string; value: string }> = [];

    const pushIfOverride = (
      nodeId: string,
      field: string,
      selected: string,
      current: string
    ): void => {
      if (!selected || selected === COMFY_WORKFLOW_DEFAULT) return;
      if (current && selected === current) return;
      overrides.push({ nodeId, field, value: selected });
    };

    for (const c of slots.checkpoints) {
      pushIfOverride(c.nodeId, c.field || 'ckpt_name', c.selected, c.current);
    }
    for (const u of slots.unets) {
      pushIfOverride(u.nodeId, u.field || 'unet_name', u.selected, u.current);
    }
    for (const v of slots.vaes) {
      pushIfOverride(v.nodeId, v.field || 'vae_name', v.selected, v.current);
    }
    for (const cl of slots.clips || []) {
      pushIfOverride(cl.nodeId, cl.field || 'clip_name', cl.selected, cl.current);
    }
    if (overrides.length) payload.overrides = overrides;

    const loraOverrides = slots.loras.filter((l) => {
      const nameOverride =
        !!l.selected &&
        l.selected !== COMFY_WORKFLOW_DEFAULT &&
        l.selected !== l.lora_name;
      const disabled = l.enabled === false;
      const strengthChanged =
        (typeof l.strength_model === 'number' && l.strength_model !== 1) ||
        (typeof l.strength_clip === 'number' && l.strength_clip !== 1);
      return nameOverride || disabled || strengthChanged;
    });
    if (loraOverrides.length) {
      payload.loras = loraOverrides.map((l) => {
        const entry: {
          nodeId: string;
          enabled: boolean;
          lora_name?: string;
          strength_model?: number;
          strength_clip?: number;
        } = {
          nodeId: l.nodeId,
          enabled: l.enabled,
          strength_model: l.strength_model,
          strength_clip: l.strength_clip,
        };
        if (
          l.selected &&
          l.selected !== COMFY_WORKFLOW_DEFAULT &&
          l.selected !== l.lora_name
        ) {
          entry.lora_name = l.selected;
        }
        return entry;
      });
    }

    return payload;
  }

  /**
   * File options for a model slot (does not include Workflow Default — templates add that).
   */
  modelSlotOptions(slot: { options?: string[]; current?: string; selected?: string }): string[] {
    const opts = slot.options?.length ? [...slot.options] : [];
    for (const v of [slot.current, slot.selected]) {
      if (v && v !== COMFY_WORKFLOW_DEFAULT && !opts.includes(v)) opts.unshift(v);
    }
    return opts;
  }

  /** Sentinel value for model/LoRA selects (bind option [value] to this). */
  readonly workflowDefaultValue = COMFY_WORKFLOW_DEFAULT;

  /**
   * Label for the Workflow Default select option — must show the graph's actual
   * file (`slot.current`), never options[0] from the combo list.
   */
  workflowDefaultOptionLabel(current?: string): string {
    const raw = current != null ? String(current).trim() : '';
    if (raw && raw !== COMFY_WORKFLOW_DEFAULT) {
      const short = raw.includes('/') ? raw.split('/').pop()! : raw;
      return `Workflow Default (${short})`;
    }
    return 'Workflow Default (unchanged in graph)';
  }

  /** Human label for a LoadImage slot — custom title first when present. */
  comfyImageSlotLabel(slot: ComfyImageSlot): string {
    const n = slot.index + 1;
    const name = (slot.title || '').trim() || slot.classType || 'LoadImage';
    // Custom titles: "Start Frame · #1"; generic: "#1 · LoadImage (12)"
    if (slot.hasCustomTitle || (slot.title && !/^LoadImage\b/i.test(slot.title) && slot.title !== `${slot.classType} ${slot.nodeId}`)) {
      return `${name} · #${n}`;
    }
    return `#${n} · ${name} (${slot.nodeId})`;
  }

  /** Reload only history lists (e.g. after running jobs in ComfyUI). */
  async refreshComfyHistory(): Promise<void> {
    if (!this.comfyConnected()) return;
    try {
      const [imgHist, vidHist] = await Promise.all([
        firstValueFrom(
          this.http.get<{ history?: ComfyHistoryInfo[] }>(`/api/comfy/history?media=image&max=40`)
        ),
        firstValueFrom(
          this.http.get<{ history?: ComfyHistoryInfo[] }>(`/api/comfy/history?media=video&max=40`)
        ),
      ]);
      this.comfyImageHistory.set(imgHist?.history || []);
      this.comfyVideoHistory.set(vidHist?.history || []);
    } catch (err) {
      console.warn('[Comfy] history refresh failed', err);
      throw err;
    }
  }

  /** Human label for the currently selected image workflow source. */
  comfyImageSelectionLabel(): string {
    const id = this.comfyImageTemplateId();
    if (!id) return '';
    if (id === 'custom') return 'custom workflow';
    if (id.startsWith('history:')) {
      return this.comfyImageHistory().find((h) => h.id === id)?.title || id;
    }
    const t = this.comfyImageTemplates().find((x) => x.id === id);
    return t ? this.comfyTemplateOptionLabel(t) : id;
  }

  comfyVideoSelectionLabel(): string {
    const id = this.comfyVideoTemplateId();
    if (!id) return '';
    if (id === 'custom') return 'custom workflow';
    if (id.startsWith('history:')) {
      return this.comfyVideoHistory().find((h) => h.id === id)?.title || id;
    }
    const t = this.comfyVideoTemplates().find((x) => x.id === id);
    return t ? this.comfyTemplateOptionLabel(t) : id;
  }

  /** Payload fragment for /api/comfy/generate from current image template settings. */
  comfyImageWorkflowSelection(): { templateId?: string; customWorkflow?: string } {
    const id = this.comfyImageTemplateId();
    if (id === 'custom') {
      const raw = this.comfyImageCustomWorkflow().trim();
      if (!raw) throw new Error('Paste a custom ComfyUI API-format workflow JSON in Settings.');
      return { customWorkflow: raw };
    }
    if (!id) {
      throw new Error('Select a ComfyUI image template, history run, or custom workflow in Settings.');
    }
    return { templateId: id };
  }

  comfyVideoWorkflowSelection(): { templateId?: string; customWorkflow?: string } {
    const id = this.comfyVideoTemplateId();
    if (id === 'custom') {
      const raw = this.comfyVideoCustomWorkflow().trim();
      if (!raw) throw new Error('Paste a custom ComfyUI API-format workflow JSON in Settings.');
      return { customWorkflow: raw };
    }
    if (!id) {
      throw new Error('Select a ComfyUI video template, history run, or custom workflow in Settings.');
    }
    return { templateId: id };
  }

  setXaiBackend(backend: XaiBackend): void {
    const next = backend === 'oauth' ? 'oauth' : 'api_key';
    this.xaiBackend.set(next);
    localStorage.setItem(XAI_BACKEND_KEY, next);
  }

  saveOpenAIKey(key: string): void {
    const trimmed = key.trim();
    this.openaiKey.set(trimmed);
    if (trimmed) localStorage.setItem('openai_api_key', trimmed);
    else localStorage.removeItem('openai_api_key');
  }

  saveGoogleKey(key: string): void {
    const trimmed = key.trim();
    this.googleKey.set(trimmed);
    if (trimmed) localStorage.setItem('google_api_key', trimmed);
    else localStorage.removeItem('google_api_key');
  }

  saveXaiKey(key: string): void {
    const trimmed = key
      .trim()
      .replace(/^Bearer\s+/i, '')
      .replace(/^["']|["']$/g, '')
      .trim();
    this.xaiKey.set(trimmed);
    if (trimmed) localStorage.setItem('xai_api_key', trimmed);
    else localStorage.removeItem('xai_api_key');
  }

  setPreferredImageProvider(id: ImageProviderId): void {
    this.preferredImageProvider.set(id);
    localStorage.setItem('as_image_provider', id);
  }

  setPreferredVideoProvider(id: VideoProviderId): void {
    this.preferredVideoProvider.set(id);
    localStorage.setItem('as_video_provider', id);
  }

  setSoundEnabled(enabled: boolean): void {
    this.soundEnabled.set(enabled);
    localStorage.setItem('as_sound_enabled', String(enabled));
  }

  setPreviewAccelMode(mode: PreviewAccelMode): void {
    const m: PreviewAccelMode = mode === 'cpu' ? 'cpu' : 'auto';
    this.previewAccelMode.set(m);
    localStorage.setItem(PREVIEW_ACCEL_KEY, m);
    // Keep legacy key in sync so older code paths still see the intent.
    localStorage.setItem(LEGACY_EXPORT_ACCEL_KEY, m);
    if (m === 'cpu') {
      void import('../features/exporter/chroma-webgpu')
        .then((mod) => mod.disposeSharedPreviewWebGpu())
        .catch(() => {
          /* module may not be loaded */
        });
    }
  }

  /** @deprecated use setPreviewAccelMode */
  setExportAccelMode(mode: PreviewAccelMode): void {
    this.setPreviewAccelMode(mode);
  }

  setExportPipelineMode(mode: ExportPipelineMode): void {
    const m: ExportPipelineMode = mode === 'gpu' || mode === 'cpu' ? mode : 'cpu';
    this.exportPipelineMode.set(m);
    localStorage.setItem(EXPORT_MODE_KEY, m);
  }

  /**
   * Bearer token for the *active* Grok backend (API key or SuperGrok OAuth).
   * Returns null if that backend is not configured.
   */
  async getXaiBearerToken(): Promise<string | null> {
    if (this.xaiBackend() === 'oauth') {
      return this.oauth.getAccessToken();
    }
    const key = this.xaiKey().trim();
    return key || null;
  }

  /** Actionable error when Grok is selected but the active backend has no credentials. */
  xaiMissingCredentialMessage(): string {
    if (this.xaiBackend() === 'oauth') {
      return 'Not logged in with SuperGrok. Go to Settings → Grok Imagine → Login with SuperGrok.';
    }
    return 'No xAI API key. Go to Settings → Grok Imagine and add a console.x.ai API key (or switch to SuperGrok OAuth).';
  }

  async testOpenAI(key: string): Promise<void> {
    await firstValueFrom(
      this.http.post(
        '/api/chat',
        {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Say "connected" in one word.' }],
          max_tokens: 5,
        },
        {
          headers: {
            Authorization: `Bearer ${key}`,
          },
        }
      )
    );
  }

  async testGoogle(key: string): Promise<void> {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data?.error?.message || `HTTP ${resp.status}`);
    }
  }

  /**
   * Validates an xAI API key (or any Bearer) via the local proxy.
   */
  async testXai(key: string): Promise<void> {
    const cleaned = key
      .trim()
      .replace(/^Bearer\s+/i, '')
      .replace(/^["']|["']$/g, '')
      .trim();
    if (!cleaned) throw new Error('Enter an API key first');

    try {
      await firstValueFrom(
        this.http.post(
          '/api/xai/test',
          {},
          {
            headers: { Authorization: `Bearer ${cleaned}` },
          }
        )
      );
    } catch (err) {
      throw new Error(this.formatHttpApiError(err, 'xAI connection failed'));
    }
  }

  /** Test the currently active Grok backend (API key or OAuth token). */
  async testActiveXaiBackend(): Promise<void> {
    const token = await this.getXaiBearerToken();
    if (!token) throw new Error(this.xaiMissingCredentialMessage());
    await this.testXai(token);
  }

  /**
   * Prefer API error text over generic Angular Http failure text.
   * xAI often returns `{ "code": "...", "error": "human message" }` (error is a string).
   * OpenAI/Google use `{ "error": { "message": "..." } }`.
   */
  private formatHttpApiError(err: unknown, fallback: string): string {
    const e = err as {
      error?: unknown;
      message?: string;
      status?: number;
    };

    const fromBody = this.extractApiErrorText(e?.error);
    if (fromBody) return fromBody;

    if (e?.message && !e.message.startsWith('Http failure')) return e.message;
    if (e?.status === 403) {
      return (
        'xAI returned HTTP 403 (forbidden). Confirm the key is a console.x.ai API key, ' +
        'the team has credits/billing enabled, and Imagine/API access is allowed for that team.'
      );
    }
    if (e?.status) return `${fallback} (HTTP ${e.status})`;
    return fallback;
  }

  private extractApiErrorText(body: unknown): string | null {
    if (!body) return null;
    if (typeof body === 'string') {
      const t = body.trim();
      if (!t) return null;
      try {
        return this.extractApiErrorText(JSON.parse(t));
      } catch {
        return t.slice(0, 400);
      }
    }
    if (Array.isArray(body)) {
      for (const item of body) {
        const msg = this.extractApiErrorText(item);
        if (msg) return msg;
      }
      return null;
    }
    if (typeof body === 'object') {
      const o = body as Record<string, unknown>;
      // xAI: { error: "string" }
      if (typeof o['error'] === 'string' && o['error'].trim()) return o['error'];
      // OpenAI / Google: { error: { message } }
      if (o['error'] && typeof o['error'] === 'object') {
        const nested = o['error'] as Record<string, unknown>;
        if (typeof nested['message'] === 'string' && nested['message'].trim()) {
          return nested['message'];
        }
      }
      if (typeof o['message'] === 'string' && o['message'].trim()) return o['message'];
    }
    return null;
  }
}
