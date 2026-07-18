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

function loadXaiBackend(): XaiBackend {
  const raw = localStorage.getItem(XAI_BACKEND_KEY);
  return raw === 'oauth' ? 'oauth' : 'api_key';
}

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly oauth = inject(XaiOAuthService);

  readonly openaiKey = signal(localStorage.getItem('openai_api_key') ?? '');
  readonly googleKey = signal(localStorage.getItem('google_api_key') ?? '');
  readonly xaiKey = signal(localStorage.getItem('xai_api_key') ?? '');
  readonly soundEnabled = signal(localStorage.getItem('as_sound_enabled') !== 'false');

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

  readonly keys = computed(() => {
    // Depend on OAuth epoch so provider lists update after login/logout
    this.oauth.authEpoch();
    return {
      openai: this.openaiKey(),
      google: this.googleKey(),
      xai: this.xaiKey(),
      xaiOAuth: this.oauth.isLoggedIn(),
      xaiBackend: this.xaiBackend(),
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

  constructor(private readonly http: HttpClient) {}

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
