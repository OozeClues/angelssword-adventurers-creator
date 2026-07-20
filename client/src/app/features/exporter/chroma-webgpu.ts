/**
 * WebGPU chroma key backend (hybrid):
 *  - CPU: edge flood-fill (exact connected-component from borders)
 *  - GPU: edge distance, OBS UV key + spill, periphery, smoke, post, AA, edge fade
 *
 * Falls back via factory when WebGPU is missing or parity check fails.
 */
import {
  ChromaKey,
  type ChromaKeySettings,
} from './chroma-key';
import type { ChromaFrameProcessor } from './chroma-backend';

const WORKGROUP = 256;
const EDGE_DEPTH = 4;
const BODY_DEPTH_SMOKE = 6;

/** Prefer browser WebGPU globals; fall back to spec bit values (Firefox builds sometimes omit them). */
function gpuBufferUsage(): {
  MAP_READ: number;
  COPY_SRC: number;
  COPY_DST: number;
  UNIFORM: number;
  STORAGE: number;
} {
  const fallback = {
    MAP_READ: 0x0001,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
  };
  const g = globalThis as unknown as {
    GPUBufferUsage?: {
      MAP_READ: number;
      COPY_SRC: number;
      COPY_DST: number;
      UNIFORM: number;
      STORAGE: number;
    };
  };
  const u = g.GPUBufferUsage;
  if (
    u &&
    typeof u.MAP_READ === 'number' &&
    typeof u.STORAGE === 'number' &&
    typeof u.UNIFORM === 'number'
  ) {
    return u;
  }
  return fallback;
}

function gpuMapModeRead(): number {
  const g = globalThis as unknown as { GPUMapMode?: { READ: number } };
  return g.GPUMapMode?.READ ?? 0x0001;
}

function gpuShaderStageCompute(): number {
  const g = globalThis as unknown as { GPUShaderStage?: { COMPUTE: number } };
  return g.GPUShaderStage?.COMPUTE ?? 0x4;
}

// Params uniform: 16 × f32 words (64 bytes), std140-friendly packing as array of f32/u32 via Float32Array
// Layout (all as f32 slots; integer fields stored as f32 bit-cast via Uint32 overlay where needed):
// 0 width, 1 height, 2 keyR, 3 keyG, 4 keyB, 5 keyU, 6 keyV,
// 7 similarity, 8 smoothness, 9 spill, 10 postSat, 11 postBright, 12 edgeFadeWidth,
// 13 flags (as u32 bits: 1=aa, 2=smoke), 14 dilateMax, 15 pad

const PARAMS_F32 = 16;
const PARAMS_BYTES = PARAMS_F32 * 4;

const WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  keyR: f32,
  keyG: f32,
  keyB: f32,
  keyU: f32,
  keyV: f32,
  similarity: f32,
  smoothness: f32,
  spill: f32,
  postSat: f32,
  postBright: f32,
  edgeFadeWidth: f32,
  flags: u32,
  dilateMax: u32,
  _pad: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> rgba: array<u32>;
@group(0) @binding(2) var<storage, read_write> distA: array<u32>;
@group(0) @binding(3) var<storage, read_write> distB: array<u32>;
@group(0) @binding(4) var<storage, read_write> distSq: array<f32>;
@group(0) @binding(5) var<storage, read_write> alphaScratch: array<u32>;

fn unpack_rgba(p: u32) -> vec4<u32> {
  return vec4<u32>(p & 0xFFu, (p >> 8u) & 0xFFu, (p >> 16u) & 0xFFu, (p >> 24u) & 0xFFu);
}

fn pack_rgba(c: vec4<u32>) -> u32 {
  return (c.r & 0xFFu) | ((c.g & 0xFFu) << 8u) | ((c.b & 0xFFu) << 16u) | ((c.a & 0xFFu) << 24u);
}

fn pix_count() -> u32 {
  return params.width * params.height;
}

fn clamp_u8(v: f32) -> u32 {
  return u32(clamp(v, 0.0, 255.0) + 0.5);
}

fn pow15(t: f32) -> f32 {
  let x = clamp(t, 0.0, 1.0);
  return x * sqrt(x);
}

// ── init edge distance from alpha ─────────────────────────────────
@compute @workgroup_size(${WORKGROUP})
fn init_edge_dist(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= pix_count()) { return; }
  let a = unpack_rgba(rgba[i]).a;
  let d = select(255u, 0u, a == 0u);
  distA[i] = d;
  distB[i] = d;
}

// ── one dilate step: distA → distB (Jacobi BFS expansion) ─────────
// Expand only FROM pixels with dist < dilateMax (matches CPU BFS).
@compute @workgroup_size(${WORKGROUP})
fn dilate_ab(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= pix_count()) { return; }
  let w = params.width;
  let h = params.height;
  let x = i % w;
  let y = i / w;
  var best = distA[i];
  let maxD = params.dilateMax;
  if (x > 0u) {
    let n = distA[i - 1u];
    if (n < maxD) { best = min(best, n + 1u); }
  }
  if (x + 1u < w) {
    let n = distA[i + 1u];
    if (n < maxD) { best = min(best, n + 1u); }
  }
  if (y > 0u) {
    let n = distA[i - w];
    if (n < maxD) { best = min(best, n + 1u); }
  }
  if (y + 1u < h) {
    let n = distA[i + w];
    if (n < maxD) { best = min(best, n + 1u); }
  }
  distB[i] = best;
}

// ── copy distB → distA ────────────────────────────────────────────
@compute @workgroup_size(${WORKGROUP})
fn copy_ba(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= pix_count()) { return; }
  distA[i] = distB[i];
}

// ── Pass A: squared UV chroma distance ────────────────────────────
@compute @workgroup_size(${WORKGROUP})
fn chroma_dist(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= pix_count()) { return; }
  let c = unpack_rgba(rgba[i]);
  if (c.a == 0u) {
    distSq[i] = 0.0;
    return;
  }
  let inv255 = 1.0 / 255.0;
  let rf = f32(c.r) * inv255;
  let gf = f32(c.g) * inv255;
  let bf = f32(c.b) * inv255;
  let u = -0.148736 * rf - 0.331264 * gf + 0.5 * bf;
  let v = 0.5 * rf - 0.418688 * gf - 0.081312 * bf;
  let du = u - params.keyU;
  let dv = v - params.keyV;
  distSq[i] = du * du + dv * dv;
}

fn box_filter_dist(x: u32, y: u32, i: u32) -> f32 {
  let w = params.width;
  let h = params.height;
  var distSum = sqrt(distSq[i]);
  var totalWeight = 1.0;

  if (x > 0u) {
    let ni = i - 1u;
    if (unpack_rgba(rgba[ni]).a > 0u) {
      distSum += sqrt(distSq[ni]) * 2.0;
      totalWeight += 2.0;
    }
  }
  if (x + 1u < w) {
    let ni = i + 1u;
    if (unpack_rgba(rgba[ni]).a > 0u) {
      distSum += sqrt(distSq[ni]) * 2.0;
      totalWeight += 2.0;
    }
  }
  if (y > 0u) {
    let ni = i - w;
    if (unpack_rgba(rgba[ni]).a > 0u) {
      distSum += sqrt(distSq[ni]) * 2.0;
      totalWeight += 2.0;
    }
  }
  if (y + 1u < h) {
    let ni = i + w;
    if (unpack_rgba(rgba[ni]).a > 0u) {
      distSum += sqrt(distSq[ni]) * 2.0;
      totalWeight += 2.0;
    }
  }
  return distSum / totalWeight;
}

// ── Pass B: alpha + spill (edgeDist in distA) ──────────────────────
@compute @workgroup_size(${WORKGROUP})
fn chroma_key(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= pix_count()) { return; }
  var c = unpack_rgba(rgba[i]);
  if (c.a == 0u) { return; }

  let w = params.width;
  let x = i % w;
  let y = i / w;
  let depth = distA[i];
  let dSq = distSq[i];
  let sim = params.similarity;
  let simSq = sim * sim;
  // Note: "smooth" is a reserved WGSL keyword (interpolation qualifier).
  let smoothAmt = max(0.002, params.smoothness);
  let spillAmt = max(0.002, params.spill);
  let invSmooth = 1.0 / smoothAmt;
  let invSpill = 1.0 / spillAmt;

  var chromaDist: f32;
  if (depth <= ${EDGE_DEPTH}u) {
    chromaDist = box_filter_dist(x, y, i);
  } else {
    if (dSq <= simSq) {
      c.a = 0u;
      rgba[i] = pack_rgba(c);
      return;
    }
    chromaDist = sqrt(dSq);
  }

  let baseMask = chromaDist - sim;

  if (depth <= ${EDGE_DEPTH}u) {
    let fullMask = pow15(clamp(baseMask * invSmooth, 0.0, 1.0));
    c.a = u32(f32(c.a) * fullMask + 0.5);
    if (c.a == 0u) {
      rgba[i] = pack_rgba(c);
      return;
    }
  }

  let spillVal = pow15(clamp(baseMask * invSpill, 0.0, 1.0));
  if (spillVal < 0.999) {
    let rf = f32(c.r);
    let gf = f32(c.g);
    let bf = f32(c.b);
    let lum = rf * 0.2126 + gf * 0.7152 + bf * 0.0722;
    c.r = clamp_u8(lum + (rf - lum) * spillVal);
    c.g = clamp_u8(lum + (gf - lum) * spillVal);
    c.b = clamp_u8(lum + (bf - lum) * spillVal);
  }
  rgba[i] = pack_rgba(c);
}

// ── periphery blackout (edgeDist in distA, max 2) ─────────────────
@compute @workgroup_size(${WORKGROUP})
fn periphery(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= pix_count()) { return; }
  let dist = distA[i];
  if (dist == 0u || dist > 2u) { return; }
  var c = unpack_rgba(rgba[i]);
  if (c.a < 200u) { return; }

  let keyMax = max(params.keyR, max(params.keyG, params.keyB));
  let isKeyR = params.keyR > keyMax * 0.7;
  let isKeyG = params.keyG > keyMax * 0.7;
  let isKeyB = params.keyB > keyMax * 0.7;

  let r = f32(c.r);
  let g = f32(c.g);
  let b = f32(c.b);
  var contamination = 0.0;
  if (isKeyR && isKeyB && !isKeyG) {
    contamination = max(max(0.0, r - g), max(0.0, b - g));
  } else if (isKeyR && isKeyG && !isKeyB) {
    contamination = max(max(0.0, r - b), max(0.0, g - b));
  } else if (isKeyG && !isKeyR && !isKeyB) {
    contamination = max(0.0, g - max(r, b));
  } else if (isKeyB && !isKeyR && !isKeyG) {
    contamination = max(0.0, b - max(r, g));
  } else if (isKeyR && !isKeyG && !isKeyB) {
    contamination = max(0.0, r - max(g, b));
  }

  let threshold = select(20.0, 8.0, dist == 1u);
  if (contamination <= threshold) { return; }

  let distFade = select(0.6, 1.0, dist == 1u);
  let strength = min(1.0, (contamination - threshold) / 60.0) * distFade;
  let lum = r * 0.299 + g * 0.587 + b * 0.114;
  let darkTarget = min(lum * 0.25, 35.0);
  c.r = clamp_u8(r * (1.0 - strength) + darkTarget * strength);
  c.g = clamp_u8(g * (1.0 - strength) + darkTarget * strength);
  c.b = clamp_u8(b * (1.0 - strength) + darkTarget * strength);
  rgba[i] = pack_rgba(c);
}

// ── smoke cleanup ─────────────────────────────────────────────────
@compute @workgroup_size(${WORKGROUP})
fn smoke(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= pix_count()) { return; }
  var c = unpack_rgba(rgba[i]);
  if (c.a < 1u) { return; }
  let depth = distA[i];
  if (depth > ${BODY_DEPTH_SMOKE}u) { return; }

  let keyCb = 128.0 + (-0.168736 * params.keyR - 0.331264 * params.keyG + 0.5 * params.keyB);
  let keyCr = 128.0 + (0.5 * params.keyR - 0.418688 * params.keyG - 0.081312 * params.keyB);
  let SMOKE_THRESHOLD = 40.0;
  let SMOKE_SOFTEDGE = 60.0;
  let smokeLimit = SMOKE_THRESHOLD + SMOKE_SOFTEDGE;
  let smokeLimitSq = smokeLimit * smokeLimit;
  let smokeThreshSq = SMOKE_THRESHOLD * SMOKE_THRESHOLD;

  let r = f32(c.r);
  let g = f32(c.g);
  let b = f32(c.b);
  let cb = 128.0 + (-0.168736 * r - 0.331264 * g + 0.5 * b);
  let cr = 128.0 + (0.5 * r - 0.418688 * g - 0.081312 * b);
  let dcb = cb - keyCb;
  let dcr = cr - keyCr;
  let chromaDistSq = dcb * dcb + dcr * dcr;
  if (chromaDistSq >= smokeLimitSq) { return; }

  var contamination: f32;
  if (chromaDistSq < smokeThreshSq) {
    contamination = 1.0;
  } else {
    let chromaDist = sqrt(chromaDistSq);
    contamination = 1.0 - (chromaDist - SMOKE_THRESHOLD) / SMOKE_SOFTEDGE;
  }
  contamination = pow(contamination, 0.7);
  contamination *= max(0.0, 1.0 - f32(depth) / f32(${BODY_DEPTH_SMOKE}u));
  if (contamination < 0.01) { return; }

  let lum = r * 0.299 + g * 0.587 + b * 0.114;
  let origAlpha = f32(c.a);
  if (c.a < 200u) {
    let darkVal = min(lum * 0.5, 80.0);
    let k = contamination * 0.7;
    c.r = clamp_u8(r * (1.0 - k) + darkVal * k);
    c.g = clamp_u8(g * (1.0 - k) + darkVal * k);
    c.b = clamp_u8(b * (1.0 - k) + darkVal * k);
    c.a = clamp_u8(origAlpha * (1.0 - contamination * 0.3));
  } else {
    let darkVal = min(lum * 0.2, 30.0);
    c.r = clamp_u8(r * (1.0 - contamination) + darkVal * contamination);
    c.g = clamp_u8(g * (1.0 - contamination) + darkVal * contamination);
    c.b = clamp_u8(b * (1.0 - contamination) + darkVal * contamination);
    c.a = clamp_u8(origAlpha * (1.0 - contamination * 0.85));
  }
  rgba[i] = pack_rgba(c);
}

// ── post brightness / saturation ──────────────────────────────────
@compute @workgroup_size(${WORKGROUP})
fn post_process(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= pix_count()) { return; }
  var c = unpack_rgba(rgba[i]);
  if (c.a == 0u) { return; }
  var r = f32(c.r);
  var g = f32(c.g);
  var b = f32(c.b);
  let bright = params.postBright;
  let sat = params.postSat;
  if (bright != 1.0) {
    r = r * bright;
    g = g * bright;
    b = b * bright;
  }
  if (sat != 1.0) {
    let lum = 0.299 * r + 0.587 * g + 0.114 * b;
    r = lum + (r - lum) * sat;
    g = lum + (g - lum) * sat;
    b = lum + (b - lum) * sat;
  }
  c.r = clamp_u8(r);
  c.g = clamp_u8(g);
  c.b = clamp_u8(b);
  rgba[i] = pack_rgba(c);
}

// ── snapshot alphas for AA ────────────────────────────────────────
@compute @workgroup_size(${WORKGROUP})
fn snapshot_alpha(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= pix_count()) { return; }
  alphaScratch[i] = unpack_rgba(rgba[i]).a;
}

// ── anti-alias ────────────────────────────────────────────────────
@compute @workgroup_size(${WORKGROUP})
fn anti_alias(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= pix_count()) { return; }
  let w = params.width;
  let h = params.height;
  let x = i % w;
  let y = i / w;
  if (x == 0u || y == 0u || x + 1u >= w || y + 1u >= h) { return; }

  let alpha = alphaScratch[i];
  if (alpha < 128u) { return; }

  let aUp = alphaScratch[i - w];
  let aDown = alphaScratch[i + w];
  let aLeft = alphaScratch[i - 1u];
  let aRight = alphaScratch[i + 1u];
  let aUL = alphaScratch[i - w - 1u];
  let aUR = alphaScratch[i - w + 1u];
  let aDL = alphaScratch[i + w - 1u];
  let aDR = alphaScratch[i + w + 1u];

  if (aUp >= 128u && aDown >= 128u && aLeft >= 128u && aRight >= 128u
      && aUL >= 128u && aUR >= 128u && aDL >= 128u && aDR >= 128u) {
    return;
  }

  var opaqueW = 0u;
  if (alpha >= 128u) { opaqueW += 2u; }
  if (aUp >= 128u) { opaqueW += 2u; }
  if (aDown >= 128u) { opaqueW += 2u; }
  if (aLeft >= 128u) { opaqueW += 2u; }
  if (aRight >= 128u) { opaqueW += 2u; }
  if (aUL >= 128u) { opaqueW += 1u; }
  if (aUR >= 128u) { opaqueW += 1u; }
  if (aDL >= 128u) { opaqueW += 1u; }
  if (aDR >= 128u) { opaqueW += 1u; }

  let smoothAlpha = (opaqueW * 255u) / 14u;
  if (smoothAlpha < alpha) {
    var c = unpack_rgba(rgba[i]);
    c.a = smoothAlpha;
    rgba[i] = pack_rgba(c);
  }
}

// ── edge fade ─────────────────────────────────────────────────────
@compute @workgroup_size(${WORKGROUP})
fn edge_fade(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= pix_count()) { return; }
  let fadeW = params.edgeFadeWidth;
  if (fadeW <= 0.0) { return; }
  var c = unpack_rgba(rgba[i]);
  if (c.a == 0u) { return; }
  let w = params.width;
  let x = i % w;
  let y = i / w;
  let minDist = min(min(f32(x), f32(w - 1u - x)), f32(y));
  if (minDist >= fadeW) { return; }
  let t = minDist / fadeW;
  let edgeFactor = t * t;
  c.a = clamp_u8(f32(c.a) * edgeFactor);
  rgba[i] = pack_rgba(c);
}
`;

type PipelineName =
  | 'init_edge_dist'
  | 'dilate_ab'
  | 'copy_ba'
  | 'chroma_dist'
  | 'chroma_key'
  | 'periphery'
  | 'smoke'
  | 'post_process'
  | 'snapshot_alpha'
  | 'anti_alias'
  | 'edge_fade';

function keyUv(r: number, g: number, b: number): { u: number; v: number } {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  return {
    u: -0.148736 * rf - 0.331264 * gf + 0.5 * bf,
    v: 0.5 * rf - 0.418688 * gf - 0.081312 * bf,
  };
}

function writeParams(
  buf: ArrayBuffer,
  width: number,
  height: number,
  settings: ChromaKeySettings,
  dilateMax: number
) {
  const u32 = new Uint32Array(buf);
  const f32 = new Float32Array(buf);
  const { u, v } = keyUv(settings.keyR, settings.keyG, settings.keyB);
  u32[0] = width;
  u32[1] = height;
  f32[2] = settings.keyR;
  f32[3] = settings.keyG;
  f32[4] = settings.keyB;
  f32[5] = u;
  f32[6] = v;
  f32[7] = settings.similarity;
  f32[8] = settings.smoothness;
  f32[9] = settings.spillSuppression;
  f32[10] = settings.postSaturation;
  f32[11] = settings.postBrightness;
  f32[12] = settings.edgeFadeWidth;
  let flags = 0;
  if (settings.antiAlias) flags |= 1;
  if (settings.smokeCleanup) flags |= 2;
  u32[13] = flags;
  u32[14] = dilateMax;
  u32[15] = 0;
}

export class WebGpuChromaProcessor implements ChromaFrameProcessor {
  readonly backend = 'webgpu' as const;
  readonly concurrency = 1;

  get isUsable(): boolean {
    return !this.closed && !this.deviceLost && !this.gpuFailed;
  }

  private device: GPUDevice;
  private pipelines: Map<PipelineName, GPUComputePipeline>;
  private bindGroupLayout: GPUBindGroupLayout;
  private paramsBuf: GPUBuffer;
  private rgbaBuf: GPUBuffer | null = null;
  private distABuf: GPUBuffer | null = null;
  private distBBuf: GPUBuffer | null = null;
  private distSqBuf: GPUBuffer | null = null;
  private alphaBuf: GPUBuffer | null = null;
  private readbackBuf: GPUBuffer | null = null;
  private capacityPixels = 0;
  private paramsScratch = new ArrayBuffer(PARAMS_BYTES);
  private packedScratch: Uint32Array | null = null;
  private encodeRgba: ((width: number, height: number, buffer: ArrayBuffer) => Promise<Blob>) | null =
    null;
  private closed = false;
  private chain: Promise<unknown> = Promise.resolve();
  private cpuFallback: ChromaFrameProcessor | null = null;
  private gpuFailed = false;
  private floodKeyer = new ChromaKey();
  private deviceLost = false;

  constructor(
    device: GPUDevice,
    pipelines: Map<PipelineName, GPUComputePipeline>,
    bindGroupLayout: GPUBindGroupLayout,
    paramsBuf: GPUBuffer
  ) {
    this.device = device;
    this.pipelines = pipelines;
    this.bindGroupLayout = bindGroupLayout;
    this.paramsBuf = paramsBuf;
    void device.lost.then((info) => {
      this.deviceLost = true;
      console.warn('[chroma-webgpu] device lost:', info.message);
    });
  }

  setRgbaEncoder(fn: (width: number, height: number, buffer: ArrayBuffer) => Promise<Blob>) {
    this.encodeRgba = fn;
    this.cpuFallback?.setRgbaEncoder?.(fn);
  }

  private async ensureCpuFallback(): Promise<ChromaFrameProcessor> {
    if (!this.cpuFallback) {
      // Dynamic import avoids circular dependency with chroma-backend.ts
      const { CpuChromaProcessor } = await import('./chroma-backend');
      this.cpuFallback = new CpuChromaProcessor();
      if (this.encodeRgba) this.cpuFallback.setRgbaEncoder?.(this.encodeRgba);
    }
    return this.cpuFallback;
  }

  private ensureCapacity(pixels: number) {
    if (pixels <= this.capacityPixels && this.rgbaBuf) return;

    this.destroyFrameBuffers();
    const BUF = gpuBufferUsage();
    const rgbaBytes = pixels * 4;
    const distBytes = pixels * 4; // u32
    const distSqBytes = pixels * 4; // f32
    const usage = BUF.STORAGE | BUF.COPY_SRC | BUF.COPY_DST;

    this.rgbaBuf = this.device.createBuffer({ size: rgbaBytes, usage, label: 'chroma-rgba' });
    this.distABuf = this.device.createBuffer({ size: distBytes, usage, label: 'chroma-distA' });
    this.distBBuf = this.device.createBuffer({ size: distBytes, usage, label: 'chroma-distB' });
    this.distSqBuf = this.device.createBuffer({ size: distSqBytes, usage, label: 'chroma-distSq' });
    this.alphaBuf = this.device.createBuffer({ size: distBytes, usage, label: 'chroma-alpha' });
    this.readbackBuf = this.device.createBuffer({
      size: rgbaBytes,
      usage: BUF.MAP_READ | BUF.COPY_DST,
      label: 'chroma-readback',
    });
    this.packedScratch = new Uint32Array(pixels);
    this.capacityPixels = pixels;
  }

  private destroyFrameBuffers() {
    this.rgbaBuf?.destroy();
    this.distABuf?.destroy();
    this.distBBuf?.destroy();
    this.distSqBuf?.destroy();
    this.alphaBuf?.destroy();
    this.readbackBuf?.destroy();
    this.rgbaBuf = null;
    this.distABuf = null;
    this.distBBuf = null;
    this.distSqBuf = null;
    this.alphaBuf = null;
    this.readbackBuf = null;
    this.capacityPixels = 0;
    this.packedScratch = null;
  }

  private makeBindGroup(): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuf } },
        { binding: 1, resource: { buffer: this.rgbaBuf! } },
        { binding: 2, resource: { buffer: this.distABuf! } },
        { binding: 3, resource: { buffer: this.distBBuf! } },
        { binding: 4, resource: { buffer: this.distSqBuf! } },
        { binding: 5, resource: { buffer: this.alphaBuf! } },
      ],
    });
  }

  private dispatch(
    encoder: GPUCommandEncoder,
    name: PipelineName,
    bindGroup: GPUBindGroup,
    pixels: number
  ) {
    const pass = encoder.beginComputePass({ label: name });
    pass.setPipeline(this.pipelines.get(name)!);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(pixels / WORKGROUP));
    pass.end();
  }

  /** Write uniforms then record + submit a command buffer (params must not change mid-submit). */
  private submitPass(
    width: number,
    height: number,
    settings: ChromaKeySettings,
    dilateMax: number,
    record: (encoder: GPUCommandEncoder, bindGroup: GPUBindGroup, pixels: number) => void
  ) {
    writeParams(this.paramsScratch, width, height, settings, dilateMax);
    this.device.queue.writeBuffer(this.paramsBuf, 0, this.paramsScratch);
    const pixels = width * height;
    const bindGroup = this.makeBindGroup();
    const encoder = this.device.createCommandEncoder();
    record(encoder, bindGroup, pixels);
    this.device.queue.submit([encoder.finish()]);
  }

  private recordDilate(
    encoder: GPUCommandEncoder,
    bindGroup: GPUBindGroup,
    pixels: number,
    steps: number
  ) {
    for (let s = 0; s < steps; s++) {
      this.dispatch(encoder, 'dilate_ab', bindGroup, pixels);
      this.dispatch(encoder, 'copy_ba', bindGroup, pixels);
    }
  }

  /**
   * GPU key a frame in place.
   * @param options.previewFast — skip optional quality passes that rarely matter while scrubbing
   *   (smoke cleanup); still runs flood-fill + core key + periphery + AA/fade/post when set.
   */
  private async processGpu(
    imageData: ImageData,
    settings: ChromaKeySettings,
    options: { previewFast?: boolean } = {}
  ): Promise<ImageData> {
    if (this.closed) throw new Error('Chroma processor is closed');
    if (this.deviceLost) throw new Error('WebGPU device lost');
    if (this.gpuFailed) throw new Error('WebGPU backend previously failed');

    const { width, height, data } = imageData;
    const pixels = width * height;
    const previewFast = !!options.previewFast;

    // Hybrid: exact CPU flood-fill from borders, then GPU for the rest
    this.floodKeyer.applySettings(settings);
    const bg = { r: settings.keyR, g: settings.keyG, b: settings.keyB };
    const tolerance = settings.similarity * 110;
    this.floodKeyer.edgeFloodFill(imageData, bg, tolerance);

    this.ensureCapacity(pixels);
    // Little-endian RGBA matches packed u32 layout — upload without a JS pack loop.
    this.device.queue.writeBuffer(
      this.rgbaBuf!,
      0,
      data.buffer as ArrayBuffer,
      data.byteOffset,
      data.byteLength
    );

    // Edge distance for OBS key (depth 4) + UV key + spill
    this.submitPass(width, height, settings, EDGE_DEPTH, (encoder, bg0, n) => {
      this.dispatch(encoder, 'init_edge_dist', bg0, n);
      this.recordDilate(encoder, bg0, n, EDGE_DEPTH);
      this.dispatch(encoder, 'chroma_dist', bg0, n);
      this.dispatch(encoder, 'chroma_key', bg0, n);
    });

    // Periphery (+ optional post/AA/fade) after alpha changed
    const needPost =
      settings.postSaturation !== 1 ||
      settings.postBrightness !== 1 ||
      settings.antiAlias ||
      settings.edgeFadeWidth > 0;
    const runSmoke = settings.smokeCleanup && !previewFast;

    this.submitPass(width, height, settings, 2, (encoder, bg0, n) => {
      this.dispatch(encoder, 'init_edge_dist', bg0, n);
      this.recordDilate(encoder, bg0, n, 2);
      this.dispatch(encoder, 'periphery', bg0, n);
      if (!runSmoke && needPost) {
        if (settings.postSaturation !== 1 || settings.postBrightness !== 1) {
          this.dispatch(encoder, 'post_process', bg0, n);
        }
        if (settings.antiAlias) {
          this.dispatch(encoder, 'snapshot_alpha', bg0, n);
          this.dispatch(encoder, 'anti_alias', bg0, n);
        }
        if (settings.edgeFadeWidth > 0) {
          this.dispatch(encoder, 'edge_fade', bg0, n);
        }
      }
    });

    if (runSmoke) {
      this.submitPass(width, height, settings, BODY_DEPTH_SMOKE, (encoder, bg0, n) => {
        this.dispatch(encoder, 'init_edge_dist', bg0, n);
        this.recordDilate(encoder, bg0, n, BODY_DEPTH_SMOKE);
        this.dispatch(encoder, 'smoke', bg0, n);
        if (needPost) {
          if (settings.postSaturation !== 1 || settings.postBrightness !== 1) {
            this.dispatch(encoder, 'post_process', bg0, n);
          }
          if (settings.antiAlias) {
            this.dispatch(encoder, 'snapshot_alpha', bg0, n);
            this.dispatch(encoder, 'anti_alias', bg0, n);
          }
          if (settings.edgeFadeWidth > 0) {
            this.dispatch(encoder, 'edge_fade', bg0, n);
          }
        }
      });
    }

    // Readback
    {
      const encoder = this.device.createCommandEncoder({ label: 'chroma-readback' });
      encoder.copyBufferToBuffer(this.rgbaBuf!, 0, this.readbackBuf!, 0, pixels * 4);
      this.device.queue.submit([encoder.finish()]);
    }

    await this.readbackBuf!.mapAsync(gpuMapModeRead());
    try {
      const mapped = new Uint8ClampedArray(this.readbackBuf!.getMappedRange(0, pixels * 4));
      data.set(mapped);
    } finally {
      this.readbackBuf!.unmap();
    }

    return imageData;
  }

  /**
   * Interactive preview path: same hybrid key, optimized for latency (skips smoke).
   * Mutates imageData in place.
   */
  processPreviewFrame(imageData: ImageData, settings: ChromaKeySettings): Promise<ImageData> {
    return this.enqueue(async () => {
      if (this.deviceLost || this.gpuFailed) {
        throw new Error('WebGPU unavailable for preview');
      }
      return this.processGpu(imageData, settings, { previewFast: true });
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  processRgba(imageData: ImageData, settings: ChromaKeySettings): Promise<ImageData> {
    return this.enqueue(async () => {
      try {
        return await this.processGpu(imageData, settings);
      } catch (err) {
        console.warn('[chroma-webgpu] frame failed, falling back to CPU:', err);
        this.gpuFailed = true;
        return (await this.ensureCpuFallback()).processRgba(imageData, settings);
      }
    });
  }

  /**
   * Process on GPU only — used by smoke/diagnose so CPU fallback cannot fake success.
   */
  processRgbaStrict(imageData: ImageData, settings: ChromaKeySettings): Promise<ImageData> {
    return this.enqueue(async () => {
      if (this.deviceLost) throw new Error('WebGPU device lost');
      return this.processGpu(imageData, settings);
    });
  }

  processToPng(imageData: ImageData, settings: ChromaKeySettings): Promise<Blob> {
    return this.enqueue(async () => {
      if (this.gpuFailed || this.deviceLost) {
        return (await this.ensureCpuFallback()).processToPng(imageData, settings);
      }
      try {
        await this.processGpu(imageData, settings);
      } catch (err) {
        console.warn('[chroma-webgpu] frame failed, falling back to CPU:', err);
        this.gpuFailed = true;
        return (await this.ensureCpuFallback()).processToPng(imageData, settings);
      }
      // imageData is already keyed — encode only (do not re-run CPU key)
      const { encodeImageDataPng } = await import('./chroma-backend');
      return encodeImageDataPng(imageData, this.encodeRgba);
    });
  }

  /**
   * GPU key + return raw RGBA (no PNG). Used by the fast server rawvideo path.
   */
  processToRawRgba(
    imageData: ImageData,
    settings: ChromaKeySettings
  ): Promise<{ width: number; height: number; buffer: ArrayBuffer }> {
    return this.enqueue(async () => {
      if (this.gpuFailed || this.deviceLost) {
        const fb = await this.ensureCpuFallback();
        if (fb.processToRawRgba) return fb.processToRawRgba(imageData, settings);
        const img = await fb.processRgba(imageData, settings);
        const d = img.data;
        const buffer =
          d.byteOffset === 0 && d.buffer.byteLength === d.byteLength
            ? (d.buffer as ArrayBuffer)
            : d.slice().buffer;
        return { width: img.width, height: img.height, buffer };
      }
      try {
        await this.processGpu(imageData, settings);
        const d = imageData.data;
        const buffer =
          d.byteOffset === 0 && d.buffer.byteLength === d.byteLength
            ? (d.buffer as ArrayBuffer)
            : d.slice().buffer;
        return { width: imageData.width, height: imageData.height, buffer };
      } catch (err) {
        console.warn('[chroma-webgpu] raw RGBA failed, falling back to CPU:', err);
        this.gpuFailed = true;
        const fb = await this.ensureCpuFallback();
        if (fb.processToRawRgba) return fb.processToRawRgba(imageData, settings);
        throw err;
      }
    });
  }

  dispose() {
    this.closed = true;
    this.destroyFrameBuffers();
    this.paramsBuf.destroy();
    this.device.destroy();
    this.cpuFallback?.dispose();
    this.cpuFallback = null;
  }
}

export type WebGpuInitStage =
  | 'api'
  | 'adapter'
  | 'device'
  | 'shader'
  | 'pipelines'
  | 'smoke'
  | 'ready';

export type WebGpuInitReport = {
  ok: boolean;
  /** Furthest stage reached (or failed at). */
  stage: WebGpuInitStage;
  message: string;
  adapterName?: string;
  vendor?: string;
  processor?: WebGpuChromaProcessor;
  /** Max |Δ| vs CPU on smoke fixture (informational). */
  parityMaxDelta?: number;
  /** % of pixels with any channel |Δ| > 2 vs CPU. */
  parityMismatchPct?: number;
};

async function requestBestAdapter(gpu: GPU): Promise<GPUAdapter | null> {
  const attempts: GPURequestAdapterOptions[] = [
    { powerPreference: 'high-performance' },
    { powerPreference: 'low-power' },
    {},
    { forceFallbackAdapter: true },
  ];
  for (const opts of attempts) {
    try {
      const adapter = await gpu.requestAdapter(opts);
      if (adapter) return adapter;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function readAdapterMeta(
  adapter: GPUAdapter
): Promise<{ name?: string; vendor?: string }> {
  try {
    const anyAdapter = adapter as GPUAdapter & {
      info?: GPUAdapterInfo;
      requestAdapterInfo?: () => Promise<GPUAdapterInfo>;
    };
    const info =
      anyAdapter.info ??
      (typeof anyAdapter.requestAdapterInfo === 'function'
        ? await anyAdapter.requestAdapterInfo()
        : undefined);
    if (!info) return {};
    const name = (info.description || info.device || '').trim() || undefined;
    const vendor = (info.vendor || '').trim() || undefined;
    return { name, vendor };
  } catch {
    return {};
  }
}

function makeSmokeFixture(): ImageData {
  const w = 64;
  const h = 64;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = 0;
      let g = 255;
      let b = 0;
      if (x >= 20 && x < 44 && y >= 16 && y < 48) {
        r = 200;
        g = 40;
        b = 40;
      }
      if (x >= 18 && x < 20 && y >= 16 && y < 48) {
        r = 40;
        g = 200;
        b = 40;
      }
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return new ImageData(data, w, h);
}

function parityStats(
  cpu: Uint8ClampedArray,
  gpu: Uint8ClampedArray
): { maxDelta: number; mismatchPct: number } {
  const n = Math.min(cpu.length, gpu.length);
  let maxDelta = 0;
  let badPixels = 0;
  const pixels = n / 4;
  for (let i = 0; i < n; i += 4) {
    let pixelBad = false;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(cpu[i + c]! - gpu[i + c]!);
      if (d > maxDelta) maxDelta = d;
      if (d > 2) pixelBad = true;
    }
    if (pixelBad) badPixels++;
  }
  return {
    maxDelta,
    mismatchPct: pixels > 0 ? (badPixels / pixels) * 100 : 0,
  };
}

/**
 * Functional smoke test: GPU must key green bg transparent and keep subject opaque.
 * CPU parity is measured for diagnostics but is not a hard gate (edge FP can differ).
 */
async function runSmokeTest(gpu: WebGpuChromaProcessor): Promise<{
  ok: boolean;
  message: string;
  parityMaxDelta?: number;
  parityMismatchPct?: number;
}> {
  const settings: ChromaKeySettings = {
    keyR: 0,
    keyG: 255,
    keyB: 0,
    similarity: 0.4,
    smoothness: 0.08,
    spillSuppression: 0.1,
    postSaturation: 1,
    postBrightness: 1,
    edgeFadeWidth: 0,
    antiAlias: false,
    smokeCleanup: false,
  };

  const cpuIn = makeSmokeFixture();
  const gpuIn = makeSmokeFixture();

  const keyer = new ChromaKey();
  keyer.applySettings(settings);
  keyer.processExportFrame(cpuIn);

  await gpu.processRgbaStrict(gpuIn, settings);

  const { maxDelta, mismatchPct } = parityStats(cpuIn.data, gpuIn.data);

  let transparent = 0;
  let opaque = 0;
  const d = gpuIn.data;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i]! === 0) transparent++;
    else if (d[i]! >= 200) opaque++;
  }

  // Corner should be keyed (green screen flood from border)
  const cornerA = d[3]!;
  // Center of red subject should stay solid
  const cx = (32 * 64 + 32) * 4 + 3;
  const centerA = d[cx]!;

  if (transparent < 100) {
    return {
      ok: false,
      message: `Smoke test failed: too few transparent pixels (${transparent}).`,
      parityMaxDelta: maxDelta,
      parityMismatchPct: mismatchPct,
    };
  }
  if (opaque < 50) {
    return {
      ok: false,
      message: `Smoke test failed: subject was keyed away (opaque=${opaque}).`,
      parityMaxDelta: maxDelta,
      parityMismatchPct: mismatchPct,
    };
  }
  if (cornerA > 16) {
    return {
      ok: false,
      message: `Smoke test failed: border green not keyed (alpha=${cornerA}).`,
      parityMaxDelta: maxDelta,
      parityMismatchPct: mismatchPct,
    };
  }
  if (centerA < 200) {
    return {
      ok: false,
      message: `Smoke test failed: subject center not opaque (alpha=${centerA}).`,
      parityMaxDelta: maxDelta,
      parityMismatchPct: mismatchPct,
    };
  }

  if (mismatchPct > 5) {
    console.warn(
      `[chroma-webgpu] CPU parity soft mismatch: max|Δ|=${maxDelta}, ${mismatchPct.toFixed(2)}% pixels (still enabling WebGPU)`
    );
  }

  return {
    ok: true,
    message: 'WebGPU chroma smoke test passed',
    parityMaxDelta: maxDelta,
    parityMismatchPct: mismatchPct,
  };
}

async function createWebGpuChromaProcessorDetailed(): Promise<WebGpuInitReport> {
  const nav = navigator as Navigator & { gpu?: GPU };
  if (!nav.gpu) {
    return {
      ok: false,
      stage: 'api',
      message:
        'navigator.gpu is missing. Enable WebGPU in the browser (Firefox/Waterfox: dom.webgpu.enabled) or use a Chromium build with WebGPU.',
    };
  }

  const BUF = gpuBufferUsage();
  const STAGE = gpuShaderStageCompute();

  let adapter: GPUAdapter | null = null;
  try {
    adapter = await requestBestAdapter(nav.gpu);
  } catch (err) {
    return {
      ok: false,
      stage: 'adapter',
      message: `requestAdapter threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!adapter) {
    return {
      ok: false,
      stage: 'adapter',
      message:
        'No WebGPU adapter returned. On Firefox/Waterfox check about:config (dom.webgpu.enabled) and GPU drivers; Chromium may need chrome://flags or hardware acceleration.',
    };
  }

  const { name: adapterName, vendor } = await readAdapterMeta(adapter);

  // Prefer not requesting huge limits — default limits handle 4K RGBA + scratch.
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({
      label: 'as-adventurer-chroma',
    });
  } catch (err) {
    try {
      device = await adapter.requestDevice();
    } catch (err2) {
      return {
        ok: false,
        stage: 'device',
        message: `requestDevice failed: ${err2 instanceof Error ? err2.message : String(err2)}`,
        adapterName,
        vendor,
      };
    }
  }

  // Capture async validation errors during pipeline build
  const uncaptured: string[] = [];
  const onUncaptured = (ev: Event) => {
    const e = ev as Event & { error?: { message?: string } };
    uncaptured.push(e.error?.message || 'uncaptured GPU error');
  };
  device.addEventListener('uncapturederror', onUncaptured);

  try {
    const module = device.createShaderModule({ code: WGSL, label: 'chroma-key' });
    if (module.getCompilationInfo) {
      try {
        const info = await module.getCompilationInfo();
        const errors = info.messages.filter((m) => m.type === 'error');
        if (errors.length) {
          const msg = errors.map((e) => `L${e.lineNum}: ${e.message}`).join('; ');
          device.destroy();
          return {
            ok: false,
            stage: 'shader',
            message: `WGSL compile error: ${msg}`,
            adapterName,
            vendor,
          };
        }
      } catch {
        /* some browsers throw on getCompilationInfo; continue to pipeline */
      }
    }

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: STAGE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: STAGE, buffer: { type: 'storage' } },
        { binding: 2, visibility: STAGE, buffer: { type: 'storage' } },
        { binding: 3, visibility: STAGE, buffer: { type: 'storage' } },
        { binding: 4, visibility: STAGE, buffer: { type: 'storage' } },
        { binding: 5, visibility: STAGE, buffer: { type: 'storage' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

    const names: PipelineName[] = [
      'init_edge_dist',
      'dilate_ab',
      'copy_ba',
      'chroma_dist',
      'chroma_key',
      'periphery',
      'smoke',
      'post_process',
      'snapshot_alpha',
      'anti_alias',
      'edge_fade',
    ];
    const pipelines = new Map<PipelineName, GPUComputePipeline>();
    for (const name of names) {
      try {
        const anyDevice = device as GPUDevice & {
          createComputePipelineAsync?: (d: GPUComputePipelineDescriptor) => Promise<GPUComputePipeline>;
        };
        const desc: GPUComputePipelineDescriptor = {
          layout: pipelineLayout,
          compute: { module, entryPoint: name },
          label: name,
        };
        const pipe = anyDevice.createComputePipelineAsync
          ? await anyDevice.createComputePipelineAsync(desc)
          : device.createComputePipeline(desc);
        pipelines.set(name, pipe);
      } catch (err) {
        device.destroy();
        return {
          ok: false,
          stage: 'pipelines',
          message: `Pipeline "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          adapterName,
          vendor,
        };
      }
    }

    if (uncaptured.length) {
      device.destroy();
      return {
        ok: false,
        stage: 'pipelines',
        message: `GPU validation: ${uncaptured.join('; ')}`,
        adapterName,
        vendor,
      };
    }

    const paramsBuf = device.createBuffer({
      size: PARAMS_BYTES,
      usage: BUF.UNIFORM | BUF.COPY_DST,
      label: 'chroma-params',
    });

    // Patch instance methods that close over buffer usage flags from globals —
    // construct processor then smoke-test.
    const processor = new WebGpuChromaProcessor(device, pipelines, bindGroupLayout, paramsBuf);

    try {
      const smoke = await runSmokeTest(processor);
      if (!smoke.ok) {
        processor.dispose();
        return {
          ok: false,
          stage: 'smoke',
          message: smoke.message,
          adapterName,
          vendor,
          parityMaxDelta: smoke.parityMaxDelta,
          parityMismatchPct: smoke.parityMismatchPct,
        };
      }
      return {
        ok: true,
        stage: 'ready',
        message: smoke.message,
        adapterName,
        vendor,
        processor,
        parityMaxDelta: smoke.parityMaxDelta,
        parityMismatchPct: smoke.parityMismatchPct,
      };
    } catch (err) {
      processor.dispose();
      return {
        ok: false,
        stage: 'smoke',
        message: `Smoke test error: ${err instanceof Error ? err.message : String(err)}`,
        adapterName,
        vendor,
      };
    }
  } finally {
    try {
      device.removeEventListener('uncapturederror', onUncaptured);
    } catch {
      /* device may already be destroyed */
    }
  }
}

export type TryCreateWebGpuOptions = {
  /** @deprecated Smoke test is always run; kept for API compat. */
  skipParityCheck?: boolean;
};

export async function tryCreateWebGpuChromaProcessor(
  _options: TryCreateWebGpuOptions = {}
): Promise<ChromaFrameProcessor | null> {
  const report = await createWebGpuChromaProcessorDetailed();
  if (!report.ok || !report.processor) {
    console.warn(`[chroma-webgpu] init failed at ${report.stage}: ${report.message}`);
    return null;
  }
  if (report.parityMaxDelta != null) {
    console.info(
      `[chroma-webgpu] ready (${report.adapterName || report.vendor || 'adapter'}); ` +
        `parity max|Δ|=${report.parityMaxDelta}, mismatch=${(report.parityMismatchPct ?? 0).toFixed(2)}%`
    );
  }
  return report.processor;
}

/** Full diagnostic init used by Settings status panel. */
export async function diagnoseWebGpuChroma(): Promise<WebGpuInitReport> {
  return createWebGpuChromaProcessorDetailed();
}

/** Long-lived GPU session for interactive export preview (not used for multi-frame export). */
let sharedPreviewGpu: WebGpuChromaProcessor | null = null;
let sharedPreviewGpuPromise: Promise<WebGpuChromaProcessor | null> | null = null;

/**
 * Get or create a shared WebGPU chroma processor for scrub/preview.
 * Returns null when WebGPU is unavailable — caller should use CPU ChromaKey.
 */
function isPreviewCpuOnlySetting(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    const p = localStorage.getItem('as_preview_accel');
    if (p === 'cpu') return true;
    if (p === 'auto') return false;
    return localStorage.getItem('as_export_accel') === 'cpu';
  } catch {
    return false;
  }
}

export type GetSharedPreviewOpts = {
  /** When true, allow GPU even if Preview mode is CPU (used for Export mode=GPU). */
  allowForExport?: boolean;
};

export async function getSharedPreviewWebGpu(
  opts: GetSharedPreviewOpts = {}
): Promise<WebGpuChromaProcessor | null> {
  // Settings → Preview CPU only: block unless export explicitly needs GPU.
  if (!opts.allowForExport && isPreviewCpuOnlySetting()) {
    disposeSharedPreviewWebGpu();
    return null;
  }

  if (sharedPreviewGpu?.isUsable) {
    return sharedPreviewGpu;
  }
  if (sharedPreviewGpuPromise) return sharedPreviewGpuPromise;

  sharedPreviewGpuPromise = (async () => {
    try {
      if (!opts.allowForExport && isPreviewCpuOnlySetting()) {
        return null;
      }

      if (sharedPreviewGpu) {
        try {
          sharedPreviewGpu.dispose();
        } catch {
          /* ignore */
        }
        sharedPreviewGpu = null;
      }
      const report = await createWebGpuChromaProcessorDetailed();
      if (!report.ok || !report.processor) {
        console.info('[chroma-webgpu] preview GPU unavailable:', report.message);
        return null;
      }
      if (!opts.allowForExport && isPreviewCpuOnlySetting()) {
        report.processor.dispose();
        return null;
      }
      sharedPreviewGpu = report.processor;
      console.info('[chroma-webgpu] preview GPU ready');
      return sharedPreviewGpu;
    } catch (err) {
      console.warn('[chroma-webgpu] preview GPU init failed:', err);
      return null;
    } finally {
      sharedPreviewGpuPromise = null;
    }
  })();

  return sharedPreviewGpuPromise;
}

export function disposeSharedPreviewWebGpu() {
  try {
    sharedPreviewGpu?.dispose();
  } catch {
    /* ignore */
  }
  sharedPreviewGpu = null;
  sharedPreviewGpuPromise = null;
}
