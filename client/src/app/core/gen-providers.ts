/** Online generation providers for image / video tools. */

export type KeyProvider = 'openai' | 'google' | 'xai';

export type ImageProviderId = 'openai-gpt-image' | 'gemini-image' | 'grok-image';
export type VideoProviderId = 'gemini-omni' | 'grok-video';

export interface SelectOption {
  value: string;
  label: string;
  title?: string;
}

/** Per-provider image output knobs (only non-empty lists are shown in the UI). */
export interface ImageProviderCaps {
  /** OpenAI pixel sizes (e.g. 1536x1024). */
  sizes?: SelectOption[];
  /** Aspect ratios for Gemini / Grok (e.g. 3:2). */
  aspectRatios?: SelectOption[];
  /** Gemini image_size / Grok resolution (e.g. 1K, 1k). */
  resolutions?: SelectOption[];
  defaultSize?: string;
  defaultAspect?: string;
  defaultResolution?: string;
}

/** Per-provider video output knobs. */
export interface VideoProviderCaps {
  aspectRatios: SelectOption[];
  resolutions?: SelectOption[];
  durationMin: number;
  durationMax: number;
  /** True start+end frame conditioning (not just start-image i2v). */
  supportsKeyframe: boolean;
  defaultAspect: string;
  defaultResolution?: string;
}

export interface GenProviderDef<T extends string = string> {
  id: T;
  /** Short label for the selector button */
  label: string;
  /** Longer description / tooltip */
  description: string;
  /** Which API key this needs */
  keyProvider: KeyProvider;
  /** Highlighted default recommendation */
  recommended?: boolean;
  /** Model id sent to the backend when relevant */
  modelId: string;
}

export interface ImageProviderDef extends GenProviderDef<ImageProviderId> {
  caps: ImageProviderCaps;
}

export interface VideoProviderDef extends GenProviderDef<VideoProviderId> {
  caps: VideoProviderCaps;
}

const SPRITE_ASPECTS: SelectOption[] = [
  { value: '16:9', label: '16:9', title: 'Widescreen — matches pipeline canvas (recommended)' },
  { value: '3:2', label: '3:2', title: 'Photo landscape' },
  { value: '4:3', label: '4:3', title: 'Classic landscape' },
  { value: '1:1', label: '1:1', title: 'Square' },
  { value: '2:3', label: '2:3', title: 'Portrait' },
  { value: '9:16', label: '9:16', title: 'Tall portrait / phone' },
];

const GROK_IMAGE_ASPECTS: SelectOption[] = [
  ...SPRITE_ASPECTS,
  { value: '3:4', label: '3:4', title: 'Portrait' },
  { value: '2:1', label: '2:1', title: 'Wide banner' },
  { value: 'auto', label: 'Auto', title: 'Model picks aspect from the prompt' },
];

const GEMINI_IMAGE_ASPECTS: SelectOption[] = [
  ...SPRITE_ASPECTS,
  { value: '3:4', label: '3:4', title: 'Portrait' },
  { value: '4:5', label: '4:5', title: 'Portrait' },
  { value: '5:4', label: '5:4', title: 'Landscape' },
  { value: '21:9', label: '21:9', title: 'Ultra-wide' },
];

const VIDEO_ASPECTS: SelectOption[] = [
  { value: '16:9', label: '16:9', title: 'Widescreen — matches pipeline (recommended)' },
  { value: '9:16', label: '9:16', title: 'Vertical / shorts' },
  { value: '1:1', label: '1:1', title: 'Square' },
  { value: '4:3', label: '4:3', title: 'Classic' },
  { value: '3:4', label: '3:4', title: 'Portrait' },
  { value: '3:2', label: '3:2', title: 'Photo landscape' },
  { value: '2:3', label: '2:3', title: 'Photo portrait' },
];

export const IMAGE_PROVIDERS: ImageProviderDef[] = [
  {
    id: 'openai-gpt-image',
    label: 'GPT Image 2',
    description: 'OpenAI GPT Image 2 — recommended for character sprites (high quality landscape sizes)',
    keyProvider: 'openai',
    recommended: true,
    modelId: 'gpt-image-2',
    caps: {
      // Closest landscape size GPT Image exposes (≈3:2); no native 16:9 enum.
      sizes: [
        { value: '1536x1024', label: '1536×1024', title: 'Landscape — closest to 16:9 workflow (recommended)' },
        { value: '1024x1536', label: '1024×1536', title: 'Portrait' },
        { value: '1024x1024', label: '1024×1024', title: 'Square' },
      ],
      defaultSize: '1536x1024',
    },
  },
  {
    id: 'gemini-image',
    label: 'Gemini Image',
    description:
      'Google Gemini 3.1 Flash Image (Nano Banana 2) — good alternative when using a Gemini key',
    keyProvider: 'google',
    modelId: 'gemini-3.1-flash-image',
    caps: {
      aspectRatios: GEMINI_IMAGE_ASPECTS,
      resolutions: [
        { value: '1K', label: '1K', title: 'Default quality (~1024px)' },
        { value: '0.5K', label: '0.5K', title: 'Faster / smaller (512px)' },
        { value: '2K', label: '2K', title: 'Higher detail' },
        { value: '4K', label: '4K', title: 'Max detail (slower / costlier)' },
      ],
      defaultAspect: '16:9',
      defaultResolution: '1K',
    },
  },
  {
    id: 'grok-image',
    label: 'Grok Imagine',
    description:
      'xAI Grok Imagine (image quality) — text-to-image and reference edits via the Imagine API',
    keyProvider: 'xai',
    modelId: 'grok-imagine-image-quality',
    caps: {
      aspectRatios: GROK_IMAGE_ASPECTS,
      resolutions: [
        { value: '1k', label: '1K', title: 'Default quality' },
        { value: '2k', label: '2K', title: 'Higher detail' },
      ],
      defaultAspect: '16:9',
      defaultResolution: '1k',
    },
  },
];

export const VIDEO_PROVIDERS: VideoProviderDef[] = [
  {
    id: 'gemini-omni',
    label: 'Gemini Omni Flash',
    description: 'Google Gemini Omni Flash — image-to-video + keyframe mode (3–10s)',
    keyProvider: 'google',
    recommended: true,
    modelId: 'gemini-omni-flash-preview',
    caps: {
      // Omni Flash is validated for 16:9 in this pipeline; keep a short list of common ratios.
      aspectRatios: [
        { value: '16:9', label: '16:9', title: 'Widescreen — recommended' },
        { value: '9:16', label: '9:16', title: 'Vertical' },
        { value: '1:1', label: '1:1', title: 'Square' },
      ],
      durationMin: 3,
      durationMax: 10,
      supportsKeyframe: true,
      defaultAspect: '16:9',
    },
  },
  {
    id: 'grok-video',
    label: 'Grok Imagine Video',
    description:
      'xAI Grok Imagine Video — image-to-video / text-to-video (1–15s). No dual keyframe start+end.',
    keyProvider: 'xai',
    modelId: 'grok-imagine-video',
    caps: {
      aspectRatios: VIDEO_ASPECTS,
      resolutions: [
        { value: '480p', label: '480p', title: 'Faster / cheaper' },
        { value: '720p', label: '720p', title: 'HD — recommended' },
        { value: '1080p', label: '1080p', title: 'Full HD (image-to-video; may require 1.5 model)' },
      ],
      durationMin: 1,
      durationMax: 15,
      // Grok i2v takes a single start image only — not true start+end keyframes.
      supportsKeyframe: false,
      defaultAspect: '16:9',
      defaultResolution: '720p',
    },
  },
];

export const DEFAULT_IMAGE_PROVIDER: ImageProviderId = 'openai-gpt-image';
export const DEFAULT_VIDEO_PROVIDER: VideoProviderId = 'gemini-omni';

export interface ProviderKeys {
  openai: string;
  google: string;
  xai: string;
}

export function providerNeedsKey(def: GenProviderDef, keys: ProviderKeys): boolean {
  if (def.keyProvider === 'openai') return !!keys.openai.trim();
  if (def.keyProvider === 'google') return !!keys.google.trim();
  if (def.keyProvider === 'xai') return !!keys.xai.trim();
  return false;
}

/**
 * Providers the user can actually call (API key present).
 * Order: recommended first among available, then catalog order.
 */
export function availableProviders<T extends string>(
  catalog: GenProviderDef<T>[],
  keys: ProviderKeys
): GenProviderDef<T>[] {
  return catalog.filter((p) => providerNeedsKey(p, keys));
}

/**
 * Resolve which provider to use:
 * 1) preferred if available
 * 2) else recommended among available
 * 3) else first available
 * 4) else null
 */
export function resolveProvider<T extends string>(
  catalog: GenProviderDef<T>[],
  preferred: T | null | undefined,
  keys: ProviderKeys
): { provider: GenProviderDef<T> | null; fellBack: boolean } {
  const available = availableProviders(catalog, keys);
  if (!available.length) return { provider: null, fellBack: false };

  if (preferred) {
    const match = available.find((p) => p.id === preferred);
    if (match) return { provider: match, fellBack: false };
  }

  const recommended = available.find((p) => p.recommended);
  if (recommended) {
    return {
      provider: recommended,
      fellBack: !!preferred && preferred !== recommended.id,
    };
  }

  return {
    provider: available[0],
    fellBack: !!preferred && preferred !== available[0].id,
  };
}

/** Label with star for recommended defaults. */
export function providerButtonLabel(def: GenProviderDef): string {
  return def.recommended ? `⭐ ${def.label}` : def.label;
}

export function getImageProvider(id: ImageProviderId | null | undefined): ImageProviderDef | null {
  if (!id) return null;
  return IMAGE_PROVIDERS.find((p) => p.id === id) ?? null;
}

export function getVideoProvider(id: VideoProviderId | null | undefined): VideoProviderDef | null {
  if (!id) return null;
  return VIDEO_PROVIDERS.find((p) => p.id === id) ?? null;
}

/** Pick a valid option for the current caps list, falling back to default then first. */
export function resolveSelectValue(
  options: SelectOption[] | undefined,
  preferred: string | null | undefined,
  fallback?: string
): string {
  if (!options?.length) return preferred || fallback || '';
  if (preferred && options.some((o) => o.value === preferred)) return preferred;
  if (fallback && options.some((o) => o.value === fallback)) return fallback;
  return options[0].value;
}
