/// <reference lib="webworker" />
/**
 * Worker: chroma-key a frame and encode PNG (OffscreenCanvas when available).
 */
import { ChromaKey, type ChromaKeySettings } from './chroma-key';

export type ChromaWorkerRequest = {
  type: 'process-png' | 'process-rgba';
  id: number;
  width: number;
  height: number;
  /** RGBA buffer (transferred). */
  buffer: ArrayBuffer;
  settings: ChromaKeySettings;
};

export type ChromaWorkerResponse =
  | { type: 'done'; id: number; blob: Blob }
  | {
      type: 'done-rgba';
      id: number;
      width: number;
      height: number;
      buffer: ArrayBuffer;
    }
  | { type: 'error'; id: number; message: string };

const keyer = new ChromaKey();

async function encodePng(imageData: ImageData): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'undefined') return null;
  try {
    const canvas = new OffscreenCanvas(imageData.width, imageData.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(imageData, 0, 0);
    return await canvas.convertToBlob({ type: 'image/png' });
  } catch {
    return null;
  }
}

self.onmessage = async (ev: MessageEvent<ChromaWorkerRequest>) => {
  const msg = ev.data;
  if (!msg || (msg.type !== 'process-png' && msg.type !== 'process-rgba')) return;

  const { id, width, height, buffer, settings } = msg;
  try {
    keyer.applySettings(settings);
    const data = new Uint8ClampedArray(buffer);
    const imageData = new ImageData(data, width, height);
    keyer.processExportFrame(imageData);

    if (msg.type === 'process-rgba') {
      const out = imageData.data.buffer;
      const res: ChromaWorkerResponse = {
        type: 'done-rgba',
        id,
        width,
        height,
        buffer: out,
      };
      (self as DedicatedWorkerGlobalScope).postMessage(res, [out]);
      return;
    }

    const blob = await encodePng(imageData);
    if (blob) {
      const res: ChromaWorkerResponse = { type: 'done', id, blob };
      (self as DedicatedWorkerGlobalScope).postMessage(res);
      return;
    }

    // Fallback: return processed RGBA for main-thread PNG encode
    const out = imageData.data.buffer;
    const res: ChromaWorkerResponse = {
      type: 'done-rgba',
      id,
      width,
      height,
      buffer: out,
    };
    (self as DedicatedWorkerGlobalScope).postMessage(res, [out]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const res: ChromaWorkerResponse = { type: 'error', id, message };
    (self as DedicatedWorkerGlobalScope).postMessage(res);
  }
};
