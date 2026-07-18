/**
 * Pool of chroma workers for parallel export frame processing.
 * Transfers ImageData buffers to workers; returns PNG blobs.
 */
import type { ChromaKeySettings } from './chroma-key';
import type { ChromaWorkerResponse } from './chroma.worker';

type PngJob = {
  kind: 'png';
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  settings: ChromaKeySettings;
  resolve: (blob: Blob) => void;
  reject: (err: Error) => void;
};

type RgbaJob = {
  kind: 'rgba';
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  settings: ChromaKeySettings;
  resolve: (imageData: ImageData) => void;
  reject: (err: Error) => void;
};

type Job = PngJob | RgbaJob;

function toDetachableBuffer(data: Uint8ClampedArray): ArrayBuffer {
  if (data.byteOffset === 0 && data.buffer.byteLength === data.byteLength) {
    return data.buffer as ArrayBuffer;
  }
  return data.slice().buffer;
}

function defaultPoolSize(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  // Leave one core for main-thread capture/seek; cap to limit RAM (full frames in flight).
  return Math.max(1, Math.min(4, cores - 1));
}

export class ChromaWorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Job[] = [];
  private nextId = 1;
  private closed = false;
  /** Pending jobs by id (in-flight on a worker). */
  private inflight = new Map<number, Job>();
  /** Fallback encoder when worker returns raw RGBA. */
  private encodeRgba: ((width: number, height: number, buffer: ArrayBuffer) => Promise<Blob>) | null =
    null;

  constructor(size?: number) {
    const n = size ?? defaultPoolSize();
    for (let i = 0; i < n; i++) {
      const worker = new Worker(new URL('./chroma.worker', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (ev: MessageEvent<ChromaWorkerResponse>) => {
        this._onWorkerMessage(worker, ev.data);
      };
      worker.onerror = (err) => {
        // Fail all inflight on this worker — rare; surface first error.
        console.error('[chroma-worker]', err);
      };
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  /**
   * Optional main-thread PNG encoder used when OffscreenCanvas is missing.
   */
  setRgbaEncoder(fn: (width: number, height: number, buffer: ArrayBuffer) => Promise<Blob>) {
    this.encodeRgba = fn;
  }

  /**
   * Process one frame (chroma + AA + edge fade) and return a PNG blob.
   * Transfers ownership of imageData.data.buffer — do not use imageData after.
   */
  processToPng(imageData: ImageData, settings: ChromaKeySettings): Promise<Blob> {
    if (this.closed) {
      return Promise.reject(new Error('Chroma worker pool is closed'));
    }

    const buffer = toDetachableBuffer(imageData.data);

    return new Promise<Blob>((resolve, reject) => {
      const job: PngJob = {
        kind: 'png',
        id: this.nextId++,
        width: imageData.width,
        height: imageData.height,
        buffer,
        settings,
        resolve,
        reject,
      };
      this.queue.push(job);
      this._pump();
    });
  }

  /**
   * Process RGBA only (no PNG). Returns ImageData with processed pixels.
   * Transfers ownership of imageData.data.buffer — do not use imageData after.
   */
  processRgba(imageData: ImageData, settings: ChromaKeySettings): Promise<ImageData> {
    if (this.closed) {
      return Promise.reject(new Error('Chroma worker pool is closed'));
    }

    const buffer = toDetachableBuffer(imageData.data);

    return new Promise<ImageData>((resolve, reject) => {
      const job: RgbaJob = {
        kind: 'rgba',
        id: this.nextId++,
        width: imageData.width,
        height: imageData.height,
        buffer,
        settings,
        resolve,
        reject,
      };
      this.queue.push(job);
      this._pump();
    });
  }

  terminate() {
    this.closed = true;
    for (const job of this.queue) {
      job.reject(new Error('Export cancelled'));
    }
    this.queue.length = 0;
    for (const job of this.inflight.values()) {
      job.reject(new Error('Export cancelled'));
    }
    this.inflight.clear();
    for (const w of this.workers) {
      w.terminate();
    }
    this.workers = [];
    this.idle = [];
  }

  private _onWorkerMessage(worker: Worker, msg: ChromaWorkerResponse) {
    if (!msg || typeof msg.id !== 'number') {
      this.idle.push(worker);
      this._pump();
      return;
    }

    const job = this.inflight.get(msg.id);
    this.inflight.delete(msg.id);
    this.idle.push(worker);

    if (!job) {
      this._pump();
      return;
    }

    if (msg.type === 'error') {
      job.reject(new Error(msg.message || 'Chroma worker failed'));
      this._pump();
      return;
    }

    if (job.kind === 'rgba') {
      if (msg.type !== 'done-rgba') {
        job.reject(new Error('Expected RGBA response from chroma worker'));
        this._pump();
        return;
      }
      job.resolve(new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height));
      this._pump();
      return;
    }

    // PNG jobs
    if (msg.type === 'done') {
      job.resolve(msg.blob);
      this._pump();
      return;
    }

    if (msg.type === 'done-rgba') {
      const encode = this.encodeRgba;
      if (!encode) {
        job.reject(new Error('Worker returned RGBA but no main-thread PNG encoder is set'));
        this._pump();
        return;
      }
      encode(msg.width, msg.height, msg.buffer)
        .then(job.resolve)
        .catch(job.reject)
        .finally(() => this._pump());
      return;
    }

    job.reject(new Error('Unknown worker response'));
    this._pump();
  }

  private _pump() {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!;
      const job = this.queue.shift()!;
      this.inflight.set(job.id, job);
      try {
        worker.postMessage(
          {
            type: job.kind === 'rgba' ? 'process-rgba' : 'process-png',
            id: job.id,
            width: job.width,
            height: job.height,
            buffer: job.buffer,
            settings: job.settings,
          },
          [job.buffer]
        );
      } catch (err) {
        this.inflight.delete(job.id);
        this.idle.push(worker);
        job.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
}
