import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SettingsService } from './settings.service';
import { base64ToBlob, loadImage } from '../shared/utils/media';
import {
  IMAGE_PROVIDERS,
  VIDEO_PROVIDERS,
  type ImageProviderId,
  type VideoProviderId,
} from './gen-providers';

export interface GeneratedVideo {
  blob: Blob;
  url: string;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly settings = inject(SettingsService);

  async generateImage(opts: {
    prompt: string;
    images?: { label: string; data: string }[];
    provider?: ImageProviderId;
    /** OpenAI pixel size e.g. 1536x1024 */
    size?: string;
    /** Gemini / Grok aspect e.g. 3:2 */
    aspectRatio?: string;
    /** Gemini image_size (1K) or Grok resolution (1k) */
    resolution?: string;
  }): Promise<string> {
    const sel = this.settings.imageProviderSelection();
    const id = opts.provider || sel.provider?.id;
    if (!id) {
      throw new Error(
        'No image provider available. Add an OpenAI, Gemini, or xAI (Grok) API key in Settings.'
      );
    }
    const def = IMAGE_PROVIDERS.find((p) => p.id === id);
    if (!def) throw new Error(`Unknown image provider: ${id}`);

    if (def.keyProvider === 'openai') {
      return this.generateImageOpenAI(opts.prompt, opts.images, def.modelId, opts.size);
    }
    if (def.keyProvider === 'google') {
      return this.generateImageGemini(
        opts.prompt,
        opts.images,
        def.modelId,
        opts.aspectRatio,
        opts.resolution
      );
    }
    if (def.keyProvider === 'xai') {
      return this.generateImageXai(
        opts.prompt,
        opts.images,
        def.modelId,
        opts.aspectRatio,
        opts.resolution
      );
    }
    throw new Error(`Unsupported image provider: ${id}`);
  }

  private async generateImageOpenAI(
    prompt: string,
    images: { label: string; data: string }[] | undefined,
    modelId: string,
    size?: string
  ): Promise<string> {
    const key = this.settings.openaiKey();
    if (!key) throw new Error('No OpenAI API key. Go to Settings to add one.');

    const hasImages = !!images?.length;
    const endpoint = hasImages ? '/api/edits' : '/api/generate';
    const body: Record<string, unknown> = {
      model: modelId || 'gpt-image-2',
      prompt,
      n: 1,
      size: size || '1536x1024',
      quality: 'high',
    };
    if (hasImages) body['images'] = images;

    const data = await firstValueFrom(
      this.http.post<{ data?: { b64_json?: string }[]; error?: { message?: string } }>(
        endpoint,
        body,
        {
          headers: { Authorization: `Bearer ${key}` },
        }
      )
    );

    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      throw new Error(data?.error?.message || 'No image in OpenAI API response');
    }
    return `data:image/png;base64,${b64}`;
  }

  /**
   * xAI Grok Imagine image generation / editing.
   * Docs: https://docs.x.ai/developers/model-capabilities/images/generation
   */
  private async generateImageXai(
    prompt: string,
    images: { label: string; data: string }[] | undefined,
    modelId: string,
    aspectRatio?: string,
    resolution?: string
  ): Promise<string> {
    const key = this.settings.xaiKey();
    if (!key) throw new Error('No xAI API key. Go to Settings to add one.');

    const model = modelId || 'grok-imagine-image-quality';
    const hasImages = !!images?.length;
    const endpoint = hasImages ? '/api/xai/images/edits' : '/api/xai/images/generations';

    const body: Record<string, unknown> = {
      model,
      prompt,
      n: 1,
      aspect_ratio: aspectRatio || '16:9',
      resolution: resolution || '1k',
      response_format: 'b64_json',
    };

    if (hasImages && images) {
      // Downscale large refs — multi-MB data-URIs trigger TLS failures on the proxy hop to xAI.
      // xAI edits expect data-URI / URL *strings* (not { url, type } objects when using an array).
      const urls: string[] = [];
      for (const img of images.slice(0, 3)) {
        urls.push(await this.downscaleDataUrlForXai(this.ensureDataUrl(img.data)));
      }
      // One ref → string; multiple → string[] (image[i] must be strings)
      body['image'] = urls.length === 1 ? urls[0] : urls;
    }

    try {
      const data = await firstValueFrom(
        this.http.post<{
          data?: Array<{ b64_json?: string; url?: string }>;
          error?: { message?: string } | string;
        }>(endpoint, body, {
          headers: { Authorization: `Bearer ${key}` },
        })
      );

      const first = data?.data?.[0];
      if (first?.b64_json) {
        return `data:image/jpeg;base64,${first.b64_json}`;
      }
      if (first?.url) {
        return this.fetchXaiMediaAsDataUrl(first.url, key, 'image/jpeg');
      }
      const errField = data?.error;
      const errMsg =
        typeof errField === 'string'
          ? errField
          : errField?.message || 'No image in xAI API response';
      throw new Error(errMsg);
    } catch (err) {
      throw new Error(this.httpErrorMessage(err, 'Grok image generation failed'));
    }
  }

  /** Ensure a data URL (handles raw base64 or already-prefixed strings). */
  private ensureDataUrl(data: string, fallbackMime = 'image/png'): string {
    if (!data) return data;
    if (data.startsWith('data:')) return data;
    return `data:${fallbackMime};base64,${data}`;
  }

  /**
   * Shrink reference images before posting to xAI.
   * Large PNG data-URIs (several MB) frequently cause TLS "bad record mac" on the server proxy.
   */
  private async downscaleDataUrlForXai(
    dataUrl: string,
    maxEdge = 1536,
    quality = 0.88
  ): Promise<string> {
    try {
      // Already compact enough
      if (dataUrl.length < 900_000) return dataUrl;

      const img = await loadImage(dataUrl);
      const longest = Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height);
      const scale = longest > maxEdge ? maxEdge / longest : 1;

      // Even if under maxEdge, re-encode huge PNG/WebP payloads as JPEG
      if (scale >= 1 && dataUrl.length < 1_200_000 && dataUrl.includes('image/jpeg')) {
        return dataUrl;
      }

      const w = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
      const h = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return dataUrl;
      ctx.drawImage(img, 0, 0, w, h);
      const out = canvas.toDataURL('image/jpeg', quality);
      console.log(
        `[Grok] downscaled ref ${(dataUrl.length / 1024).toFixed(0)}KB → ${(out.length / 1024).toFixed(0)}KB (${w}×${h})`
      );
      return out;
    } catch (err) {
      console.warn('[Grok] ref downscale failed, sending original', err);
      return dataUrl;
    }
  }

  /**
   * Download a temporary xAI media URL via the local proxy (CORS-safe)
   * and return a blob: URL or data URL depending on mode.
   */
  private async fetchXaiMediaBlob(url: string, apiKey: string): Promise<Blob> {
    const resp = await firstValueFrom(
      this.http.post(
        '/api/xai/fetch-url',
        { url },
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          responseType: 'blob',
        }
      )
    );
    return resp as Blob;
  }

  private async fetchXaiMediaAsDataUrl(
    url: string,
    apiKey: string,
    fallbackMime: string
  ): Promise<string> {
    const blob = await this.fetchXaiMediaBlob(url, apiKey);
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Failed to read downloaded media'));
      // Preserve server content-type when possible
      const typed =
        blob.type && blob.type !== 'application/octet-stream'
          ? blob
          : new Blob([blob], { type: fallbackMime });
      reader.readAsDataURL(typed);
    });
  }

  /**
   * Gemini native image gen via Interactions API (same proxy as video).
   * Docs: https://ai.google.dev/gemini-api/docs/image-generation
   */
  private async generateImageGemini(
    prompt: string,
    images: { label: string; data: string }[] | undefined,
    modelId: string,
    aspectRatio?: string,
    resolution?: string
  ): Promise<string> {
    const apiKey = this.settings.googleKey();
    if (!apiKey) throw new Error('No Google API key. Go to Settings to add one.');

    // Interactions API input blocks: text + optional reference images
    const input: Array<Record<string, unknown>> = [];
    if (images?.length) {
      for (const img of images) {
        let raw = img.data || '';
        if (raw.includes(',')) raw = raw.substring(raw.indexOf(',') + 1);
        const mime = img.data?.includes('image/jpeg')
          ? 'image/jpeg'
          : img.data?.includes('image/webp')
            ? 'image/webp'
            : 'image/png';
        input.push({ type: 'image', data: raw, mime_type: mime });
      }
    }
    input.push({ type: 'text', text: prompt });

    // Gemini Interactions only accepts image/jpeg for response_format.mime_type.
    const body: Record<string, unknown> = {
      model: modelId || 'gemini-3.1-flash-image',
      input,
      response_format: {
        type: 'image',
        mime_type: 'image/jpeg',
        aspect_ratio: aspectRatio || '16:9',
        image_size: resolution || '1K',
      },
    };

    try {
      // Reuse the Interactions proxy used for video (same host + auth header).
      const data = await firstValueFrom(
        this.http.post<Record<string, unknown>>('/api/video/generate', body, {
          headers: { 'X-API-Key': apiKey },
        })
      );
      return this.extractImageFromGeminiResponse(data);
    } catch (err) {
      throw new Error(this.httpErrorMessage(err, 'Gemini image generation failed'));
    }
  }

  /**
   * Pull a generated image from an Interactions (or legacy generateContent) response.
   * Gemini 3 image models may place the final image in model_output content OR
   * in thought.summary (thinking intermediates); use the last image found.
   */
  extractImageFromGeminiResponse(data: Record<string, unknown>): string {
    const found = this.collectGeminiImages(data);
    if (found.length > 0) {
      // Last image is the final render (thought intermediates come first).
      return found[found.length - 1];
    }

    const status = data['status'];
    if (status && status !== 'completed' && status !== 'done') {
      throw new Error(
        `Gemini image generation incomplete (status: ${String(status)}). Try again.`
      );
    }

    const errMsg = this.extractGoogleErrorMessage(data);
    if (errMsg) throw new Error(errMsg);

    const stepTypes = Array.isArray(data['steps'])
      ? (data['steps'] as Array<{ type?: string }>)
          .map((s) => s?.type || '?')
          .join(', ')
      : Object.keys(data).slice(0, 12).join(', ');
    throw new Error(
      `No image data found in Gemini API response (keys/steps: ${stepTypes || 'empty'})`
    );
  }

  /** Collect data-URL images in response order (thought → model_output). */
  private collectGeminiImages(root: unknown): string[] {
    const found: string[] = [];

    const pushImage = (mime: string | undefined, b64: string | undefined) => {
      if (!b64 || typeof b64 !== 'string' || b64.length < 32) return;
      // Skip tiny strings / non-base64 noise
      if (b64.startsWith('http://') || b64.startsWith('https://')) return;
      const m = mime && mime.startsWith('image/') ? mime : 'image/jpeg';
      found.push(`data:${m};base64,${b64}`);
    };

    const visitBlock = (item: Record<string, unknown>) => {
      const type = item['type'];
      const mime =
        (item['mime_type'] as string | undefined) ||
        (item['mimeType'] as string | undefined);

      if (type === 'image' || (typeof mime === 'string' && mime.startsWith('image/'))) {
        pushImage(mime, item['data'] as string | undefined);
      }

      const inlineData = item['inlineData'] as
        | { mimeType?: string; data?: string }
        | undefined;
      const inlineSnake = item['inline_data'] as
        | { mime_type?: string; data?: string }
        | undefined;
      if (inlineData?.data) {
        pushImage(inlineData.mimeType, inlineData.data);
      } else if (inlineSnake?.data) {
        pushImage(inlineSnake.mime_type, inlineSnake.data);
      }
    };

    // Prefer structured paths first (stable order), then deep walk for leftovers.
    if (root && typeof root === 'object' && !Array.isArray(root)) {
      const data = root as Record<string, unknown>;

      const outImg = (data['output_image'] || data['outputImage']) as
        | { data?: string; mime_type?: string; mimeType?: string }
        | undefined;
      if (outImg?.data) {
        pushImage(outImg.mime_type || outImg.mimeType, outImg.data);
      }

      // Interactions steps (new schema)
      if (Array.isArray(data['steps'])) {
        for (const step of data['steps'] as Array<Record<string, unknown>>) {
          // thought.summary may hold interim + final images for thinking models
          if (Array.isArray(step['summary'])) {
            for (const item of step['summary'] as Array<Record<string, unknown>>) {
              visitBlock(item);
            }
          }
          if (Array.isArray(step['content'])) {
            for (const item of step['content'] as Array<Record<string, unknown>>) {
              visitBlock(item);
            }
          }
        }
      }

      // Legacy outputs array
      if (Array.isArray(data['outputs'])) {
        for (const item of data['outputs'] as Array<Record<string, unknown>>) {
          visitBlock(item);
        }
      }

      // generateContent candidates
      if (Array.isArray(data['candidates'])) {
        for (const c of data['candidates'] as Array<Record<string, unknown>>) {
          const content = c['content'] as { parts?: Array<Record<string, unknown>> } | undefined;
          if (content?.parts) {
            for (const part of content.parts) visitBlock(part);
          }
        }
      }

      // Nested result (polling wrappers)
      if (data['result'] && typeof data['result'] === 'object') {
        found.push(...this.collectGeminiImages(data['result']));
      }
    }

    return found;
  }

  /** Pull a readable message from Angular HttpErrorResponse, Google error bodies, or Error. */
  private httpErrorMessage(err: unknown, fallback: string): string {
    if (err instanceof Error && err.message && !err.message.startsWith('Http failure')) {
      // Already-normalized Error from extractImage / generateImage
      if (!(err as { error?: unknown }).error) return err.message;
    }

    const e = err as {
      error?: unknown;
      message?: string;
      status?: number;
    };

    const fromBody = this.extractGoogleErrorMessage(e?.error);
    if (fromBody) return fromBody;

    if (typeof e?.error === 'string' && e.error.trim()) {
      try {
        const parsed = JSON.parse(e.error) as unknown;
        const msg = this.extractGoogleErrorMessage(parsed);
        if (msg) return msg;
        return e.error.slice(0, 300);
      } catch {
        return e.error.slice(0, 300);
      }
    }

    if (e?.message && !e.message.startsWith('Http failure')) return e.message;
    if (e?.status) return `${fallback} (HTTP ${e.status})`;
    return fallback;
  }

  /**
   * Google: `{ error: { message } }` or `[{ error: { message } }]`.
   * xAI: `{ code, error: "string" }`.
   */
  private extractGoogleErrorMessage(body: unknown): string | null {
    if (!body) return null;
    if (typeof body === 'string') {
      const t = body.trim();
      if (!t) return null;
      try {
        return this.extractGoogleErrorMessage(JSON.parse(t));
      } catch {
        return t.slice(0, 400);
      }
    }
    if (Array.isArray(body)) {
      for (const item of body) {
        const msg = this.extractGoogleErrorMessage(item);
        if (msg) return msg;
      }
      return null;
    }
    if (typeof body === 'object') {
      const o = body as Record<string, unknown>;
      // xAI style: error is a string
      if (typeof o['error'] === 'string' && o['error'].trim()) {
        return o['error'];
      }
      if (o['error'] && typeof o['error'] === 'object') {
        const nested = o['error'] as Record<string, unknown>;
        if (typeof nested['message'] === 'string' && nested['message'].trim()) {
          return nested['message'];
        }
      }
      if (typeof o['message'] === 'string' && o['message'].trim()) {
        return o['message'];
      }
    }
    return null;
  }

  async generateVideo(opts: {
    prompt: string;
    mode: 'reference' | 'keyframe';
    referenceDataUrls: string[];
    duration: number;
    provider?: VideoProviderId;
    aspectRatio?: string;
    resolution?: string;
  }): Promise<GeneratedVideo> {
    const sel = this.settings.videoProviderSelection();
    const id = opts.provider || sel.provider?.id;
    if (!id) {
      throw new Error(
        'No video provider available. Add a Gemini or xAI (Grok) API key in Settings.'
      );
    }
    const def = VIDEO_PROVIDERS.find((p) => p.id === id);
    if (!def) throw new Error(`Unknown video provider: ${id}`);

    if (opts.mode === 'keyframe' && !def.caps.supportsKeyframe) {
      throw new Error(
        `${def.label} does not support keyframe mode (start + end frames). Use Reference Mode instead.`
      );
    }

    if (def.keyProvider === 'google') {
      return this.generateVideoGemini(opts, def.modelId);
    }
    if (def.keyProvider === 'xai') {
      return this.generateVideoXai(opts, def.modelId);
    }
    throw new Error(`Unsupported video provider: ${id}`);
  }

  /**
   * xAI Grok Imagine video — async start + poll + download.
   * Docs: https://docs.x.ai/developers/model-capabilities/video/generation
   * Note: Grok supports single-image i2v only (no true start+end keyframes).
   */
  private async generateVideoXai(
    opts: {
      prompt: string;
      mode: 'reference' | 'keyframe';
      referenceDataUrls: string[];
      duration: number;
      aspectRatio?: string;
      resolution?: string;
    },
    modelId: string
  ): Promise<GeneratedVideo> {
    const apiKey = this.settings.xaiKey();
    if (!apiKey) throw new Error('No xAI API key. Go to Settings to add one.');

    // Grok video duration is 1–15s
    const seconds = Math.min(15, Math.max(1, Math.round(Number(opts.duration) || 5)));
    const textPrompt =
      opts.prompt ||
      'Generate a gentle breathing idle animation with slight body sway. Keep the character on the same background.';

    const body: Record<string, unknown> = {
      model: modelId || 'grok-imagine-video',
      prompt: textPrompt,
      duration: seconds,
      aspect_ratio: opts.aspectRatio || '16:9',
      resolution: opts.resolution || '720p',
    };

    // Image-to-video: single start frame only
    if (opts.referenceDataUrls.length > 0) {
      const start = await this.downscaleDataUrlForXai(
        this.ensureDataUrl(opts.referenceDataUrls[0])
      );
      // Image-to-video REST shape uses { url } (not a bare string)
      body['image'] = { url: start };
      body['prompt'] = `The video must be exactly ${seconds} seconds long. ${textPrompt}`;
    }

    try {
      const startResp = await firstValueFrom(
        this.http.post<{ request_id?: string; error?: { message?: string } }>(
          '/api/xai/videos/generations',
          body,
          { headers: { Authorization: `Bearer ${apiKey}` } }
        )
      );

      const requestId = startResp?.request_id;
      if (!requestId) {
        throw new Error(startResp?.error?.message || 'No request_id from xAI video API');
      }

      const videoUrl = await this.pollXaiVideo(requestId, apiKey);
      const blob = await this.fetchXaiMediaBlob(videoUrl, apiKey);
      const typed =
        blob.type && blob.type.startsWith('video/')
          ? blob
          : new Blob([blob], { type: 'video/mp4' });
      return { blob: typed, url: URL.createObjectURL(typed) };
    } catch (err) {
      throw new Error(this.httpErrorMessage(err, 'Grok video generation failed'));
    }
  }

  /** Poll xAI video job until done / failed / expired (max ~12 min). */
  private async pollXaiVideo(requestId: string, apiKey: string): Promise<string> {
    const maxAttempts = 144; // 144 * 5s ≈ 12 minutes
    const delayMs = 5000;

    for (let i = 0; i < maxAttempts; i++) {
      const data = await firstValueFrom(
        this.http.get<{
          status?: string;
          video?: { url?: string };
          error?: { message?: string; code?: string };
        }>(`/api/xai/videos/${encodeURIComponent(requestId)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
      );

      const status = data?.status;
      if (status === 'done') {
        const url = data?.video?.url;
        if (!url) throw new Error('xAI video done but no video URL returned');
        return url;
      }
      if (status === 'failed') {
        throw new Error(
          data?.error?.message || `xAI video generation failed (${data?.error?.code || 'error'})`
        );
      }
      if (status === 'expired') {
        throw new Error('xAI video request expired — try again');
      }
      // pending / unknown — wait
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error('xAI video generation timed out after ~12 minutes');
  }

  private async generateVideoGemini(
    opts: {
      prompt: string;
      mode: 'reference' | 'keyframe';
      referenceDataUrls: string[];
      duration: number;
      aspectRatio?: string;
      resolution?: string;
    },
    modelId: string
  ): Promise<GeneratedVideo> {
    const apiKey = this.settings.googleKey();
    if (!apiKey) throw new Error('No Google API key. Go to Settings to add one.');

    // Omni Flash output length is 3–10s; omitted duration defaults to 10s on the API.
    const seconds = Math.min(10, Math.max(3, Math.round(Number(opts.duration) || 5)));

    const textPrompt =
      opts.prompt ||
      'Generate a gentle breathing idle animation with slight body sway. Keep the character on the same background.';

    // Duration lives on response_format (Interactions API: google-duration string, e.g. "5s").
    const requestBody: Record<string, unknown> = {
      model: modelId || 'gemini-omni-flash-preview',
      response_format: {
        type: 'video',
        aspect_ratio: opts.aspectRatio || '16:9',
        duration: `${seconds}s`,
      },
    };

    if (opts.mode === 'keyframe' && opts.referenceDataUrls.length >= 2) {
      const startRef = opts.referenceDataUrls[0];
      const startRaw = startRef.includes(',') ? startRef.split(',')[1] : startRef;
      const startMime = startRef.includes('image/png') ? 'image/png' : 'image/jpeg';
      requestBody['input'] = [
        { type: 'image', data: startRaw, mime_type: startMime },
        {
          type: 'text',
          text:
            `Starting from this image (start frame), animate the character transitioning to the end pose. ` +
            `The video must be exactly ${seconds} seconds long. ${textPrompt}`,
        },
      ];
      requestBody['generation_config'] = {
        video_config: { task: 'image_to_video' },
      };
    } else if (opts.referenceDataUrls.length > 0) {
      const ref = opts.referenceDataUrls[0];
      const raw = ref.includes(',') ? ref.split(',')[1] : ref;
      const mimeType = ref.includes('image/png') ? 'image/png' : 'image/jpeg';
      requestBody['input'] = [
        { type: 'image', data: raw, mime_type: mimeType },
        {
          type: 'text',
          text: `The video must be exactly ${seconds} seconds long. ${textPrompt}`,
        },
      ];
      requestBody['generation_config'] = {
        video_config: { task: 'image_to_video' },
      };
    } else {
      requestBody['input'] = `The video must be exactly ${seconds} seconds long. ${textPrompt}`;
      requestBody['generation_config'] = {
        video_config: { task: 'text_to_video' },
      };
    }

    const data = await firstValueFrom(
      this.http.post<Record<string, unknown>>('/api/video/generate', requestBody, {
        headers: { 'X-API-Key': apiKey },
      })
    );

    return this.extractVideoFromResponse(data);
  }

  extractVideoFromResponse(data: Record<string, unknown>): GeneratedVideo {
    if (Array.isArray(data['steps'])) {
      for (const step of data['steps'] as Array<Record<string, unknown>>) {
        if (step['type'] === 'model_output' && Array.isArray(step['content'])) {
          for (const item of step['content'] as Array<Record<string, unknown>>) {
            if (item['type'] === 'video' && item['data']) {
              const mimeType = (item['mime_type'] as string) || 'video/mp4';
              const blob = base64ToBlob(item['data'] as string, mimeType);
              return { blob, url: URL.createObjectURL(blob) };
            }
          }
        }
      }
    }

    if (Array.isArray(data['candidates'])) {
      for (const candidate of data['candidates'] as Array<Record<string, unknown>>) {
        const content = candidate['content'] as { parts?: Array<Record<string, unknown>> } | undefined;
        if (content?.parts) {
          for (const part of content.parts) {
            const inline = part['inlineData'] as { mimeType?: string; data?: string } | undefined;
            if (inline?.mimeType?.startsWith('video/') && inline.data) {
              const blob = base64ToBlob(inline.data, inline.mimeType);
              return { blob, url: URL.createObjectURL(blob) };
            }
          }
        }
      }
    }

    if (data['result'] && typeof data['result'] === 'object') {
      return this.extractVideoFromResponse(data['result'] as Record<string, unknown>);
    }

    throw new Error('No video data found in API response. Check the console for details.');
  }
}
