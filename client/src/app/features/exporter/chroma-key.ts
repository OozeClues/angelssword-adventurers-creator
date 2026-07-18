/**
 * Multi-pass chroma key processor (OBS-style UV distance + flood fill).
 *
 * Optimized for export throughput:
 *  - One YUV pass → distance map (no 5× neighbor recompute)
 *  - Interior uses squared distance (no sqrt)
 *  - Edge box-filter reads the distance map only
 *  - pow(x, 1.5) via LUT
 *  - Reused scratch buffers (edge BFS, distance map, AA)
 */

export type ChromaKeySettings = {
  keyR: number;
  keyG: number;
  keyB: number;
  similarity: number;
  smoothness: number;
  spillSuppression: number;
  postSaturation: number;
  postBrightness: number;
  edgeFadeWidth: number;
  antiAlias: boolean;
  smokeCleanup: boolean;
};

/** Shared pow(t, 1.5) LUT for t ∈ [0, 1]. */
const POW15_LUT_SIZE = 1024;
const POW15_LUT = new Float32Array(POW15_LUT_SIZE);
for (let i = 0; i < POW15_LUT_SIZE; i++) {
  POW15_LUT[i] = Math.pow(i / (POW15_LUT_SIZE - 1), 1.5);
}

function pow15(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return POW15_LUT[(t * (POW15_LUT_SIZE - 1) + 0.5) | 0];
}

export class ChromaKey {
  keyR = 0;
  keyG = 255;
  keyB = 0;
  similarity = 0.4;
  smoothness = 0.08;
  spillSuppression = 0.1;
  postSaturation = 1;
  postBrightness = 1;
  edgeFadeWidth = 0;
  antiAlias = false;
  smokeCleanup = false;

  /** Pre-computed key UV (BT.601, RGB normalized 0–1). */
  _keyU = 0;
  _keyV = 0;

  /** Scratch buffers reused across frames. */
  _edgeDistBuf: Uint8Array | null = null;
  _chromaDistBuf: Float32Array | null = null;
  _aaBuffer: Uint8Array | null = null;
  _bfsQueue: Int32Array | null = null;

  constructor() {
    this._updateKeyUV();
  }

  setKeyColor(r: number, g: number, b: number) {
    this.keyR = r;
    this.keyG = g;
    this.keyB = b;
    this._updateKeyUV();
  }

  setKeyColorHex(hex: string) {
    hex = hex.replace('#', '');
    this.keyR = parseInt(hex.substring(0, 2), 16);
    this.keyG = parseInt(hex.substring(2, 4), 16);
    this.keyB = parseInt(hex.substring(4, 6), 16);
    this._updateKeyUV();
  }

  getSettings(): ChromaKeySettings {
    return {
      keyR: this.keyR,
      keyG: this.keyG,
      keyB: this.keyB,
      similarity: this.similarity,
      smoothness: this.smoothness,
      spillSuppression: this.spillSuppression,
      postSaturation: this.postSaturation,
      postBrightness: this.postBrightness,
      edgeFadeWidth: this.edgeFadeWidth,
      antiAlias: this.antiAlias,
      smokeCleanup: this.smokeCleanup,
    };
  }

  applySettings(s: ChromaKeySettings) {
    this.keyR = s.keyR;
    this.keyG = s.keyG;
    this.keyB = s.keyB;
    this.similarity = s.similarity;
    this.smoothness = s.smoothness;
    this.spillSuppression = s.spillSuppression;
    this.postSaturation = s.postSaturation;
    this.postBrightness = s.postBrightness;
    this.edgeFadeWidth = s.edgeFadeWidth;
    this.antiAlias = s.antiAlias;
    this.smokeCleanup = s.smokeCleanup;
    this._updateKeyUV();
  }

  /**
   * Full export prep: process + optional anti-alias + edge fade.
   */
  processExportFrame(imageData: ImageData) {
    this.process(imageData);
    if (this.antiAlias) this.applyAntiAlias(imageData);
    this.applyEdgeFade(imageData, this.edgeFadeWidth);
    return imageData;
  }

  _updateKeyUV() {
    const r = this.keyR / 255;
    const g = this.keyG / 255;
    const b = this.keyB / 255;
    this._keyU = -0.148736 * r - 0.331264 * g + 0.5 * b;
    this._keyV = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }

  /**
   * Squared UV chroma distance (no sqrt). OBS GetChromaDist without sqrt.
   * RGB bytes 0–255; key UV precomputed in 0–1 space.
   */
  _getChromaDistSq(r: number, g: number, b: number): number {
    const inv255 = 1 / 255;
    const rf = r * inv255;
    const gf = g * inv255;
    const bf = b * inv255;
    const u = -0.148736 * rf - 0.331264 * gf + 0.5 * bf;
    const v = 0.5 * rf - 0.418688 * gf - 0.081312 * bf;
    const du = u - this._keyU;
    const dv = v - this._keyV;
    return du * du + dv * dv;
  }

  /** Linear UV chroma distance (kept for callers / tests). */
  _getChromaDist(r: number, g: number, b: number): number {
    return Math.sqrt(this._getChromaDistSq(r, g, b));
  }

  /**
   * Box-filtered linear distance from a precomputed *squared* distance map.
   * Neighbors with alpha 0 are skipped (flood-filled key pixels).
   */
  _boxFilterFromDistSq(
    x: number,
    y: number,
    data: Uint8ClampedArray,
    distSq: Float32Array,
    w: number,
    h: number
  ): number {
    const pix = y * w + x;
    const idx = pix * 4;
    let distSum = Math.sqrt(distSq[pix]);
    let totalWeight = 1;

    // left
    if (x > 0 && data[idx - 1] > 0) {
      distSum += Math.sqrt(distSq[pix - 1]) * 2;
      totalWeight += 2;
    }
    // right
    if (x < w - 1 && data[idx + 7] > 0) {
      distSum += Math.sqrt(distSq[pix + 1]) * 2;
      totalWeight += 2;
    }
    // up
    if (y > 0 && data[idx - w * 4 + 3] > 0) {
      distSum += Math.sqrt(distSq[pix - w]) * 2;
      totalWeight += 2;
    }
    // down
    if (y < h - 1 && data[idx + w * 4 + 3] > 0) {
      distSum += Math.sqrt(distSq[pix + w]) * 2;
      totalWeight += 2;
    }

    return distSum / totalWeight;
  }

  isBackgroundPixel(
    data: Uint8ClampedArray,
    idx: number,
    bgColor: { r: number; g: number; b: number },
    tolerance: number
  ): boolean {
    const dr = Math.abs(data[idx] - bgColor.r);
    const dg = Math.abs(data[idx + 1] - bgColor.g);
    const db = Math.abs(data[idx + 2] - bgColor.b);
    return (dr + dg + db) / 3 <= tolerance;
  }

  process(imageData: ImageData) {
    const bgColor = { r: this.keyR, g: this.keyG, b: this.keyB };
    const tolerance = this.similarity * 110;

    this.edgeFloodFill(imageData, bgColor, tolerance);
    this._obsChromaKey(imageData);
    this._peripheryBlackout(imageData, bgColor);

    if (this.smokeCleanup) {
      this._smokeCleanup(imageData, bgColor);
    }

    if (this.postSaturation !== 1 || this.postBrightness !== 1) {
      this._postProcess(imageData);
    }
  }

  edgeFloodFill(
    imageData: ImageData,
    bgColor: { r: number; g: number; b: number },
    tolerance: number
  ) {
    const { data, width, height } = imageData;
    const totalPixels = width * height;
    const visited = new Uint8Array(totalPixels);

    if (!this._bfsQueue || this._bfsQueue.length < totalPixels) {
      this._bfsQueue = new Int32Array(totalPixels);
    }
    const queue = this._bfsQueue;
    let qHead = 0;
    let qTail = 0;

    const pushIfBg = (pixelIdx: number) => {
      if (visited[pixelIdx] !== 0) return;
      if (this.isBackgroundPixel(data, pixelIdx * 4, bgColor, tolerance)) {
        visited[pixelIdx] = 1;
        queue[qTail++] = pixelIdx;
      }
    };

    for (let x = 0; x < width; x++) {
      pushIfBg(x);
      pushIfBg((height - 1) * width + x);
    }
    for (let y = 1; y < height - 1; y++) {
      pushIfBg(y * width);
      pushIfBg(y * width + (width - 1));
    }

    while (qHead < qTail) {
      const pixelIdx = queue[qHead++];
      const x = pixelIdx % width;
      const y = (pixelIdx - x) / width;

      if (x > 0) {
        const n = pixelIdx - 1;
        if (visited[n] === 0) {
          if (this.isBackgroundPixel(data, n * 4, bgColor, tolerance)) {
            visited[n] = 1;
            queue[qTail++] = n;
          } else {
            visited[n] = 2;
          }
        }
      }
      if (x < width - 1) {
        const n = pixelIdx + 1;
        if (visited[n] === 0) {
          if (this.isBackgroundPixel(data, n * 4, bgColor, tolerance)) {
            visited[n] = 1;
            queue[qTail++] = n;
          } else {
            visited[n] = 2;
          }
        }
      }
      if (y > 0) {
        const n = pixelIdx - width;
        if (visited[n] === 0) {
          if (this.isBackgroundPixel(data, n * 4, bgColor, tolerance)) {
            visited[n] = 1;
            queue[qTail++] = n;
          } else {
            visited[n] = 2;
          }
        }
      }
      if (y < height - 1) {
        const n = pixelIdx + width;
        if (visited[n] === 0) {
          if (this.isBackgroundPixel(data, n * 4, bgColor, tolerance)) {
            visited[n] = 1;
            queue[qTail++] = n;
          } else {
            visited[n] = 2;
          }
        }
      }
    }

    for (let i = 0; i < totalPixels; i++) {
      if (visited[i] === 1) {
        data[i * 4 + 3] = 0;
      }
    }
    return imageData;
  }

  /**
   * OBS-style chroma key with distance-map optimization.
   *
   * Pass A: squared UV distance for every opaque pixel (one YUV convert each).
   * Pass B: interior → binary key via dist²; edge → box-filter linear dist + smooth.
   */
  _obsChromaKey(imageData: ImageData) {
    const { data, width, height } = imageData;
    const total = width * height;
    const sim = this.similarity;
    const simSq = sim * sim;
    const smooth = Math.max(0.002, this.smoothness);
    const spill = Math.max(0.002, this.spillSuppression);
    const invSmooth = 1 / smooth;
    const invSpill = 1 / spill;

    const EDGE_DEPTH = 4;

    if (!this._edgeDistBuf || this._edgeDistBuf.length < total) {
      this._edgeDistBuf = new Uint8Array(total);
    }
    if (!this._chromaDistBuf || this._chromaDistBuf.length < total) {
      this._chromaDistBuf = new Float32Array(total);
    }
    const edgeDist = this._edgeDistBuf;
    const distSqMap = this._chromaDistBuf;
    edgeDist.fill(255);

    if (!this._bfsQueue || this._bfsQueue.length < total) {
      this._bfsQueue = new Int32Array(total);
    }
    const queue = this._bfsQueue;
    let qHead = 0;
    let qTail = 0;

    for (let i = 0; i < total; i++) {
      if (data[i * 4 + 3] === 0) {
        edgeDist[i] = 0;
        queue[qTail++] = i;
      }
    }

    while (qHead < qTail) {
      const pi = queue[qHead++];
      const dd = edgeDist[pi];
      if (dd >= EDGE_DEPTH) continue;
      const px = pi % width;
      const py = (pi - px) / width;
      const nd = dd + 1;
      if (px > 0 && edgeDist[pi - 1] > nd) {
        edgeDist[pi - 1] = nd;
        queue[qTail++] = pi - 1;
      }
      if (px < width - 1 && edgeDist[pi + 1] > nd) {
        edgeDist[pi + 1] = nd;
        queue[qTail++] = pi + 1;
      }
      if (py > 0 && edgeDist[pi - width] > nd) {
        edgeDist[pi - width] = nd;
        queue[qTail++] = pi - width;
      }
      if (py < height - 1 && edgeDist[pi + width] > nd) {
        edgeDist[pi + width] = nd;
        queue[qTail++] = pi + width;
      }
    }

    // Pass A: squared chroma distance (one UV conversion per opaque pixel)
    const keyU = this._keyU;
    const keyV = this._keyV;
    const inv255 = 1 / 255;
    for (let i = 0; i < total; i++) {
      const idx = i * 4;
      if (data[idx + 3] === 0) {
        distSqMap[i] = 0;
        continue;
      }
      const rf = data[idx] * inv255;
      const gf = data[idx + 1] * inv255;
      const bf = data[idx + 2] * inv255;
      const u = -0.148736 * rf - 0.331264 * gf + 0.5 * bf;
      const v = 0.5 * rf - 0.418688 * gf - 0.081312 * bf;
      const du = u - keyU;
      const dv = v - keyV;
      distSqMap[i] = du * du + dv * dv;
    }

    // Pass B: alpha + spill
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixIdx = y * width + x;
        const idx = pixIdx * 4;

        if (data[idx + 3] === 0) continue;

        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const depth = edgeDist[pixIdx];
        const dSq = distSqMap[pixIdx];

        let chromaDist: number;
        if (depth <= EDGE_DEPTH) {
          // Edge: box-filtered linear distance from the map
          chromaDist = this._boxFilterFromDistSq(x, y, data, distSqMap, width, height);
        } else {
          // Interior: binary key — no box filter, no sqrt unless spill needs it
          if (dSq <= simSq) {
            data[idx + 3] = 0;
            continue;
          }
          chromaDist = Math.sqrt(dSq);
        }

        const baseMask = chromaDist - sim;

        if (depth <= EDGE_DEPTH) {
          const fullMask = pow15(Math.max(0, Math.min(1, baseMask * invSmooth)));
          data[idx + 3] = Math.round(data[idx + 3] * fullMask);
          if (data[idx + 3] === 0) continue;
        }

        const spillVal = pow15(Math.max(0, Math.min(1, baseMask * invSpill)));
        if (spillVal < 0.999) {
          const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
          data[idx] = Math.max(0, Math.min(255, Math.round(lum + (r - lum) * spillVal)));
          data[idx + 1] = Math.max(0, Math.min(255, Math.round(lum + (g - lum) * spillVal)));
          data[idx + 2] = Math.max(0, Math.min(255, Math.round(lum + (b - lum) * spillVal)));
        }
      }
    }
  }

  _peripheryBlackout(
    imageData: ImageData,
    bgColor: { r: number; g: number; b: number }
  ) {
    const d = imageData.data;
    const w = imageData.width;
    const h = imageData.height;
    const total = w * h;
    const keyMax = Math.max(bgColor.r, bgColor.g, bgColor.b);
    const isKeyR = bgColor.r > keyMax * 0.7;
    const isKeyG = bgColor.g > keyMax * 0.7;
    const isKeyB = bgColor.b > keyMax * 0.7;

    if (!this._edgeDistBuf || this._edgeDistBuf.length < total) {
      this._edgeDistBuf = new Uint8Array(total);
    }
    const edgeDist = this._edgeDistBuf;
    edgeDist.fill(255);

    if (!this._bfsQueue || this._bfsQueue.length < total) {
      this._bfsQueue = new Int32Array(total);
    }
    const queue = this._bfsQueue;
    let qHead = 0;
    let qTail = 0;

    for (let i = 0; i < total; i++) {
      if (d[i * 4 + 3] === 0) {
        edgeDist[i] = 0;
        queue[qTail++] = i;
      }
    }

    while (qHead < qTail) {
      const pi = queue[qHead++];
      const dist = edgeDist[pi];
      if (dist >= 2) continue;
      const px = pi % w;
      const py = (pi - px) / w;
      const nd = dist + 1;
      if (px > 0 && edgeDist[pi - 1] > nd) {
        edgeDist[pi - 1] = nd;
        queue[qTail++] = pi - 1;
      }
      if (px < w - 1 && edgeDist[pi + 1] > nd) {
        edgeDist[pi + 1] = nd;
        queue[qTail++] = pi + 1;
      }
      if (py > 0 && edgeDist[pi - w] > nd) {
        edgeDist[pi - w] = nd;
        queue[qTail++] = pi - w;
      }
      if (py < h - 1 && edgeDist[pi + w] > nd) {
        edgeDist[pi + w] = nd;
        queue[qTail++] = pi + w;
      }
    }

    for (let i = 0; i < total; i++) {
      const dist = edgeDist[i];
      if (dist === 0 || dist > 2) continue;
      const idx = i * 4;
      if (d[idx + 3] < 200) continue;

      const r = d[idx];
      const g = d[idx + 1];
      const b = d[idx + 2];

      let contamination = 0;
      if (isKeyR && isKeyB && !isKeyG) {
        contamination = Math.max(Math.max(0, r - g), Math.max(0, b - g));
      } else if (isKeyR && isKeyG && !isKeyB) {
        contamination = Math.max(Math.max(0, r - b), Math.max(0, g - b));
      } else if (isKeyG && !isKeyR && !isKeyB) {
        contamination = Math.max(0, g - Math.max(r, b));
      } else if (isKeyB && !isKeyR && !isKeyG) {
        contamination = Math.max(0, b - Math.max(r, g));
      } else if (isKeyR && !isKeyG && !isKeyB) {
        contamination = Math.max(0, r - Math.max(g, b));
      }

      const threshold = dist === 1 ? 8 : 20;
      if (contamination <= threshold) continue;

      const distFade = dist === 1 ? 1.0 : 0.6;
      const strength = Math.min(1, (contamination - threshold) / 60) * distFade;
      const lum = r * 0.299 + g * 0.587 + b * 0.114;
      const darkTarget = Math.min(lum * 0.25, 35);
      d[idx] = Math.round(r * (1 - strength) + darkTarget * strength);
      d[idx + 1] = Math.round(g * (1 - strength) + darkTarget * strength);
      d[idx + 2] = Math.round(b * (1 - strength) + darkTarget * strength);
    }
  }

  _smokeCleanup(
    imageData: ImageData,
    bgColor: { r: number; g: number; b: number }
  ) {
    const d = imageData.data;
    const w = imageData.width;
    const h = imageData.height;
    const total = w * h;
    const keyCb = 128 + (-0.168736 * bgColor.r - 0.331264 * bgColor.g + 0.5 * bgColor.b);
    const keyCr = 128 + (0.5 * bgColor.r - 0.418688 * bgColor.g - 0.081312 * bgColor.b);
    const SMOKE_THRESHOLD = 40;
    const SMOKE_SOFTEDGE = 60;
    const BODY_DEPTH = 6;
    const smokeLimit = SMOKE_THRESHOLD + SMOKE_SOFTEDGE;
    const smokeLimitSq = smokeLimit * smokeLimit;
    const smokeThreshSq = SMOKE_THRESHOLD * SMOKE_THRESHOLD;

    if (!this._edgeDistBuf || this._edgeDistBuf.length < total) {
      this._edgeDistBuf = new Uint8Array(total);
    }
    const distFromTP = this._edgeDistBuf;
    distFromTP.fill(255);

    if (!this._bfsQueue || this._bfsQueue.length < total) {
      this._bfsQueue = new Int32Array(total);
    }
    const bfsQ = this._bfsQueue;
    let bfsHead = 0;
    let bfsTail = 0;

    for (let i = 0; i < total; i++) {
      if (d[i * 4 + 3] === 0) {
        distFromTP[i] = 0;
        bfsQ[bfsTail++] = i;
      }
    }

    while (bfsHead < bfsTail) {
      const pi = bfsQ[bfsHead++];
      const dd = distFromTP[pi];
      if (dd >= BODY_DEPTH) continue;
      const px = pi % w;
      const py = (pi - px) / w;
      const nd = dd + 1;
      if (px > 0 && distFromTP[pi - 1] > nd) {
        distFromTP[pi - 1] = nd;
        bfsQ[bfsTail++] = pi - 1;
      }
      if (px < w - 1 && distFromTP[pi + 1] > nd) {
        distFromTP[pi + 1] = nd;
        bfsQ[bfsTail++] = pi + 1;
      }
      if (py > 0 && distFromTP[pi - w] > nd) {
        distFromTP[pi - w] = nd;
        bfsQ[bfsTail++] = pi - w;
      }
      if (py < h - 1 && distFromTP[pi + w] > nd) {
        distFromTP[pi + w] = nd;
        bfsQ[bfsTail++] = pi + w;
      }
    }

    for (let j = 0; j < d.length; j += 4) {
      if (d[j + 3] < 1) continue;
      const pxIdx = j >> 2;
      const depth = distFromTP[pxIdx];
      if (depth > BODY_DEPTH) continue;

      const r = d[j];
      const g = d[j + 1];
      const b = d[j + 2];
      const cb = 128 + (-0.168736 * r - 0.331264 * g + 0.5 * b);
      const cr = 128 + (0.5 * r - 0.418688 * g - 0.081312 * b);
      const dcb = cb - keyCb;
      const dcr = cr - keyCr;
      const chromaDistSq = dcb * dcb + dcr * dcr;

      if (chromaDistSq >= smokeLimitSq) continue;

      let contamination: number;
      if (chromaDistSq < smokeThreshSq) {
        contamination = 1.0;
      } else {
        const chromaDist = Math.sqrt(chromaDistSq);
        contamination = 1.0 - (chromaDist - SMOKE_THRESHOLD) / SMOKE_SOFTEDGE;
      }
      contamination = Math.pow(contamination, 0.7);
      contamination *= Math.max(0, 1 - depth / BODY_DEPTH);
      if (contamination < 0.01) continue;

      const lum = r * 0.299 + g * 0.587 + b * 0.114;
      const origAlpha = d[j + 3];

      if (origAlpha < 200) {
        const darkVal = Math.min(lum * 0.5, 80);
        d[j] = Math.round(r * (1 - contamination * 0.7) + darkVal * (contamination * 0.7));
        d[j + 1] = Math.round(g * (1 - contamination * 0.7) + darkVal * (contamination * 0.7));
        d[j + 2] = Math.round(b * (1 - contamination * 0.7) + darkVal * (contamination * 0.7));
        d[j + 3] = Math.round(origAlpha * (1 - contamination * 0.3));
      } else {
        const darkVal = Math.min(lum * 0.2, 30);
        d[j] = Math.round(r * (1 - contamination) + darkVal * contamination);
        d[j + 1] = Math.round(g * (1 - contamination) + darkVal * contamination);
        d[j + 2] = Math.round(b * (1 - contamination) + darkVal * contamination);
        d[j + 3] = Math.round(origAlpha * (1 - contamination * 0.85));
      }
    }
  }

  _postProcess(imageData: ImageData) {
    const d = imageData.data;
    const sat = this.postSaturation;
    const bright = this.postBrightness;
    for (let j = 0; j < d.length; j += 4) {
      if (d[j + 3] === 0) continue;
      let r = d[j];
      let g = d[j + 1];
      let b = d[j + 2];

      if (bright !== 1) {
        r = Math.round(r * bright);
        g = Math.round(g * bright);
        b = Math.round(b * bright);
      }

      if (sat !== 1) {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        r = Math.round(lum + (r - lum) * sat);
        g = Math.round(lum + (g - lum) * sat);
        b = Math.round(lum + (b - lum) * sat);
      }

      d[j] = Math.max(0, Math.min(255, r));
      d[j + 1] = Math.max(0, Math.min(255, g));
      d[j + 2] = Math.max(0, Math.min(255, b));
    }
  }

  applyEdgeFade(imageData: ImageData, fadeWidth: number) {
    if (fadeWidth <= 0) return;
    const { data, width, height } = imageData;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        if (data[idx + 3] === 0) continue;

        const minDist = Math.min(x, width - 1 - x, y);
        if (minDist >= fadeWidth) continue;

        const t = minDist / fadeWidth;
        const edgeFactor = t * t;
        data[idx + 3] = Math.round(data[idx + 3] * edgeFactor);
      }
    }
  }

  applyAntiAlias(imageData: ImageData) {
    const { data, width, height } = imageData;
    const total = width * height;

    if (!this._aaBuffer || this._aaBuffer.length < total) {
      this._aaBuffer = new Uint8Array(total);
    }
    const origAlpha = this._aaBuffer;

    for (let i = 0; i < total; i++) {
      origAlpha[i] = data[i * 4 + 3];
    }

    const W = width;
    for (let y = 1; y < height - 1; y++) {
      const rowStart = y * W;
      for (let x = 1; x < W - 1; x++) {
        const i = rowStart + x;
        const alpha = origAlpha[i];
        if (alpha < 128) continue;

        const aUp = origAlpha[i - W];
        const aDown = origAlpha[i + W];
        const aLeft = origAlpha[i - 1];
        const aRight = origAlpha[i + 1];

        if (aUp >= 128 && aDown >= 128 && aLeft >= 128 && aRight >= 128) {
          if (
            origAlpha[i - W - 1] >= 128 &&
            origAlpha[i - W + 1] >= 128 &&
            origAlpha[i + W - 1] >= 128 &&
            origAlpha[i + W + 1] >= 128
          ) {
            continue;
          }
        }

        let opaqueW = 0;
        if (alpha >= 128) opaqueW += 2;
        if (aUp >= 128) opaqueW += 2;
        if (aDown >= 128) opaqueW += 2;
        if (aLeft >= 128) opaqueW += 2;
        if (aRight >= 128) opaqueW += 2;
        if (origAlpha[i - W - 1] >= 128) opaqueW += 1;
        if (origAlpha[i - W + 1] >= 128) opaqueW += 1;
        if (origAlpha[i + W - 1] >= 128) opaqueW += 1;
        if (origAlpha[i + W + 1] >= 128) opaqueW += 1;

        const smoothAlpha = Math.round((opaqueW / 14) * 255);
        if (smoothAlpha < alpha) {
          data[i * 4 + 3] = smoothAlpha;
        }
      }
    }
  }
}
