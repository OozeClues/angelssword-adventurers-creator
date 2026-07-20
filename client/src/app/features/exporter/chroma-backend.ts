/**
 * Chroma frame processing backends: CPU workers (default) + optional WebGPU.
 */
import type { ChromaKeySettings } from './chroma-key';
import { ChromaWorkerPool } from './chroma-worker-pool';

export type ChromaBackendKind = 'cpu' | 'webgpu';

export interface ChromaFrameProcessor {
  readonly backend: ChromaBackendKind;
  /** Suggested parallel process slots (capture can overlap with this). */
  readonly concurrency: number;
  processToPng(imageData: ImageData, settings: ChromaKeySettings): Promise<Blob>;
  processRgba(imageData: ImageData, settings: ChromaKeySettings): Promise<ImageData>;
  /**
   * Key in place and return raw RGBA bytes (for server rawvideo path).
   * Optional — CPU/PNG path may omit this.
   */
  processToRawRgba?(
    imageData: ImageData,
    settings: ChromaKeySettings
  ): Promise<{ width: number; height: number; buffer: ArrayBuffer }>;
  setRgbaEncoder?(fn: (width: number, height: number, buffer: ArrayBuffer) => Promise<Blob>): void;
  dispose(): void;
}

/** CPU path: existing worker pool (+ main-thread fallback when pool cannot start). */
export class CpuChromaProcessor implements ChromaFrameProcessor {
  readonly backend: ChromaBackendKind = 'cpu';
  private pool: ChromaWorkerPool | null;
  private encodeRgba: ((width: number, height: number, buffer: ArrayBuffer) => Promise<Blob>) | null =
    null;
  private closed = false;

  constructor(pool: ChromaWorkerPool | null = null) {
    if (pool) {
      this.pool = pool;
    } else {
      try {
        this.pool = new ChromaWorkerPool();
      } catch (err) {
        console.warn('[chroma] worker pool unavailable, main-thread CPU only:', err);
        this.pool = null;
      }
    }
  }

  get concurrency(): number {
    return this.pool ? this.pool.size : 1;
  }

  setRgbaEncoder(fn: (width: number, height: number, buffer: ArrayBuffer) => Promise<Blob>) {
    this.encodeRgba = fn;
    this.pool?.setRgbaEncoder(fn);
  }

  async processToPng(imageData: ImageData, settings: ChromaKeySettings): Promise<Blob> {
    if (this.closed) throw new Error('Chroma processor is closed');
    if (this.pool) {
      return this.pool.processToPng(imageData, settings);
    }
    // Main-thread fallback
    const { ChromaKey } = await import('./chroma-key');
    const keyer = new ChromaKey();
    keyer.applySettings(settings);
    keyer.processExportFrame(imageData);
    return encodeImageDataPng(imageData, this.encodeRgba);
  }

  async processRgba(imageData: ImageData, settings: ChromaKeySettings): Promise<ImageData> {
    if (this.closed) throw new Error('Chroma processor is closed');
    if (this.pool) {
      return this.pool.processRgba(imageData, settings);
    }
    const { ChromaKey } = await import('./chroma-key');
    const keyer = new ChromaKey();
    keyer.applySettings(settings);
    keyer.processExportFrame(imageData);
    return imageData;
  }

  async processToRawRgba(
    imageData: ImageData,
    settings: ChromaKeySettings
  ): Promise<{ width: number; height: number; buffer: ArrayBuffer }> {
    const img = await this.processRgba(imageData, settings);
    const data = img.data;
    const buffer =
      data.byteOffset === 0 && data.buffer.byteLength === data.byteLength
        ? (data.buffer as ArrayBuffer)
        : data.slice().buffer;
    return { width: img.width, height: img.height, buffer };
  }

  dispose() {
    this.closed = true;
    this.pool?.terminate();
    this.pool = null;
  }
}

export async function encodeImageDataPng(
  imageData: ImageData,
  encodeRgba?: ((width: number, height: number, buffer: ArrayBuffer) => Promise<Blob>) | null
): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(imageData.width, imageData.height);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.putImageData(imageData, 0, 0);
        return await canvas.convertToBlob({ type: 'image/png' });
      }
    } catch {
      /* fall through */
    }
  }
  if (encodeRgba) {
    const buf =
      imageData.data.byteOffset === 0 &&
      imageData.data.buffer.byteLength === imageData.data.byteLength
        ? (imageData.data.buffer as ArrayBuffer)
        : imageData.data.slice().buffer;
    return encodeRgba(imageData.width, imageData.height, buf);
  }
  // DOM canvas fallback
  const c = document.createElement('canvas');
  c.width = imageData.width;
  c.height = imageData.height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable for PNG encode');
  ctx.putImageData(imageData, 0, 0);
  return new Promise((resolve, reject) => {
    c.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encode failed'))), 'image/png');
  });
}

export type CreateChromaProcessorOptions = {
  /** Force a backend (for debug). Default: prefer WebGPU when available. */
  prefer?: 'auto' | 'cpu' | 'webgpu';
  /** Skip GPU vs CPU parity smoke test (not recommended). */
  skipParityCheck?: boolean;
};

/**
 * Create a chroma processor for multi-frame export.
 *
 * Default **auto**: try WebGPU keying, else multi-core CPU workers.
 * Transparent WebM packaging still uses server ffmpeg (libvpx VP9 + alpha) —
 * hardware encoders (NVENC/QuickSync/VideoToolbox) do not support VP9/WebM with alpha.
 * Interactive scrub/preview uses a separate shared WebGPU session.
 */
/** Preview scrub: WebGPU disabled when Settings → Preview mode is CPU. */
export function isPreviewAccelCpuOnly(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    const p = localStorage.getItem('as_preview_accel');
    if (p === 'cpu') return true;
    if (p === 'auto') return false;
    // legacy
    return localStorage.getItem('as_export_accel') === 'cpu';
  } catch {
    return false;
  }
}

/** @deprecated use isPreviewAccelCpuOnly */
export function isExportAccelCpuOnly(): boolean {
  return isPreviewAccelCpuOnly();
}

export type ExportPipelineMode = 'cpu' | 'gpu';

export function getExportPipelineMode(): ExportPipelineMode {
  try {
    if (typeof localStorage === 'undefined') return 'cpu';
    const m = localStorage.getItem('as_export_mode');
    if (m === 'gpu' || m === 'cpu') return m;
  } catch {
    /* ignore */
  }
  return 'cpu';
}

export async function createChromaProcessor(
  options: CreateChromaProcessorOptions = {}
): Promise<ChromaFrameProcessor> {
  const pipeline = getExportPipelineMode();
  // Export mode CPU → workers + PNG. Export mode GPU → WebGPU (else fall back to CPU).
  let prefer: 'auto' | 'cpu' | 'webgpu' = pipeline === 'gpu' ? 'webgpu' : 'cpu';
  if (options.prefer === 'cpu') prefer = 'cpu';
  if (options.prefer === 'webgpu' && pipeline === 'gpu') prefer = 'webgpu';

  if (prefer === 'cpu') {
    console.info('[chroma] using CPU worker backend (export mode=cpu)');
    return new CpuChromaProcessor();
  }

  if (prefer === 'webgpu' || prefer === 'auto') {
    try {
      const { getSharedPreviewWebGpu } = await import('./chroma-webgpu');
      // Export GPU mode should still work even if preview is CPU-only:
      // temporarily allow GPU by not checking preview flag inside getShared — 
      // getShared checks as_export_accel legacy; update getShared to only use preview key.
      const gpu = await getSharedPreviewWebGpu({ allowForExport: pipeline === 'gpu' });
      if (gpu) {
        console.info('[chroma] using WebGPU backend (export mode=gpu, raw RGBA)');
        return {
          backend: 'webgpu' as const,
          concurrency: Math.max(1, gpu.concurrency),
          processToPng: (imageData, settings) => gpu.processToPng(imageData, settings),
          processRgba: (imageData, settings) => gpu.processRgba(imageData, settings),
          processToRawRgba: (imageData, settings) => gpu.processToRawRgba(imageData, settings),
          setRgbaEncoder: (fn) => gpu.setRgbaEncoder(fn),
          dispose: () => {
            /* shared session */
          },
        };
      }
    } catch (err) {
      console.warn('[chroma] WebGPU init failed, falling back to CPU:', err);
    }
    console.warn('[chroma] GPU export requested but WebGPU unavailable; using CPU PNG path');
  }

  console.info('[chroma] using CPU worker backend (export fallback)');
  return new CpuChromaProcessor();
}

/** Shared main-thread PNG encoder for worker / GPU RGBA fallbacks. */
export function createDomPngEncoder(): (
  width: number,
  height: number,
  buffer: ArrayBuffer
) => Promise<Blob> {
  return async (w, h, buf) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D unavailable');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0);
    return new Promise((resolve, reject) => {
      c.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('PNG encode failed'))),
        'image/png'
      );
    });
  };
}

/** Result of probing whether export chroma can use WebGPU. */
export type ExportAccelProbe = {
  /** Backend export will prefer after a successful probe. */
  backend: ChromaBackendKind;
  /** Short label for badges, e.g. "WebGPU" / "CPU". */
  label: string;
  /** One-line status next to the icon. */
  summary: string;
  /** Longer explanation for the Settings status card. */
  detail: string;
  /** GPU adapter description when known. */
  adapterName?: string;
  vendor?: string;
  /** Why WebGPU was not selected (CPU only). */
  reason?: string;
  /** Furthest init stage (api → adapter → device → shader → pipelines → smoke → ready). */
  stage?: string;
  /** Soft CPU comparison on smoke fixture (not a hard gate). */
  parityMaxDelta?: number;
  parityMismatchPct?: number;
  /** navigator.gpu present? */
  apiPresent?: boolean;
};

let cachedAccelProbe: ExportAccelProbe | null = null;
let accelProbeInflight: Promise<ExportAccelProbe> | null = null;

/**
 * Probe whether export chroma acceleration will use WebGPU.
 * Runs the same staged init + smoke path as real exports, then disposes the device.
 * Results are cached for the page lifetime (pass `{ force: true }` to re-check).
 */
export async function probeExportAcceleration(
  options: { force?: boolean } = {}
): Promise<ExportAccelProbe> {
  if (options.force) {
    cachedAccelProbe = null;
  } else if (cachedAccelProbe) {
    return cachedAccelProbe;
  }

  if (accelProbeInflight) {
    const existing = await accelProbeInflight;
    if (!options.force) return existing;
  }

  const run = (async (): Promise<ExportAccelProbe> => {
    const apiPresent =
      typeof navigator !== 'undefined' && !!(navigator as Navigator & { gpu?: GPU }).gpu;
    try {
      const { diagnoseWebGpuChroma } = await import('./chroma-webgpu');
      const report = await diagnoseWebGpuChroma();

      // Always dispose a successful device after the probe — live sessions re-acquire.
      report.processor?.dispose();
      report.processor = undefined;

      if (report.ok) {
        const who = [report.vendor, report.adapterName].filter(Boolean).join(' · ');
        const previewCpu = isPreviewAccelCpuOnly();
        let detail =
          'WebGPU is available for GPU export and (when Preview mode is Auto) scrub keying. ' +
          'Transparent WebM packing still uses ffmpeg (VP9+alpha).';
        if (previewCpu) {
          detail += ' Preview mode is CPU only — scrubbing will not use the GPU.';
        }
        if (who) detail += ` Adapter: ${who}.`;
        if (report.parityMaxDelta != null) {
          detail += ` Smoke vs CPU: max |Δ|=${report.parityMaxDelta}, ${(report.parityMismatchPct ?? 0).toFixed(1)}% pixels differ slightly (expected).`;
        }
        return {
          backend: 'webgpu',
          label: 'WebGPU',
          summary: previewCpu ? 'WebGPU ready (preview forced CPU)' : 'WebGPU ready',
          detail,
          adapterName: report.adapterName,
          vendor: report.vendor,
          stage: report.stage,
          parityMaxDelta: report.parityMaxDelta,
          parityMismatchPct: report.parityMismatchPct,
          apiPresent: true,
        };
      }

      return {
        backend: 'cpu',
        label: 'CPU',
        summary: 'CPU only',
        detail:
          'WebGPU is not available — Export preview and export both use CPU chroma. Multi-frame export still uses worker threads when possible.',
        reason: report.message,
        adapterName: report.adapterName,
        vendor: report.vendor,
        stage: report.stage,
        parityMaxDelta: report.parityMaxDelta,
        parityMismatchPct: report.parityMismatchPct,
        apiPresent,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        backend: 'cpu',
        label: 'CPU',
        summary: 'CPU workers',
        detail:
          'Export chroma keying runs on multi-core CPU workers. WebGPU probe threw an exception.',
        reason: msg,
        stage: 'api',
        apiPresent,
      };
    }
  })()
    .then((result) => {
      cachedAccelProbe = result;
      return result;
    })
    .finally(() => {
      accelProbeInflight = null;
    });

  accelProbeInflight = run;
  return run;
}

/** Last cached probe, if any (sync; may be null before first probe). */
export function getCachedExportAcceleration(): ExportAccelProbe | null {
  return cachedAccelProbe;
}
