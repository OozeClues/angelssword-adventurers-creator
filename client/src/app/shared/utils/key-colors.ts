export interface KeyColor {
  hex: string;
  name: string;
  r: number;
  g: number;
  b: number;
}

export const KEY_COLORS: KeyColor[] = [
  { hex: '#00FF00', name: 'Green', r: 0, g: 255, b: 0 },
  { hex: '#FF00FF', name: 'Magenta', r: 255, g: 0, b: 255 },
  { hex: '#0000FF', name: 'Blue', r: 0, g: 0, b: 255 },
  { hex: '#FFFF00', name: 'Yellow', r: 255, g: 255, b: 0 },
  { hex: '#00FFFF', name: 'Cyan', r: 0, g: 255, b: 255 },
];

export type SwatchBadge = 'default' | 'best' | 'avoid';

export interface SwatchScore {
  hex: string;
  badge: SwatchBadge;
  selected: boolean;
}

export function scoreKeyColorsFromImageData(data: Uint8ClampedArray, width: number, height: number): SwatchScore[] {
  const minDist = new Float64Array(KEY_COLORS.length).fill(Infinity);

  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    if (data[idx + 3] < 128) continue;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    for (let c = 0; c < KEY_COLORS.length; c++) {
      const dr = r - KEY_COLORS[c].r;
      const dg = g - KEY_COLORS[c].g;
      const db = b - KEY_COLORS[c].b;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      if (dist < minDist[c]) minDist[c] = dist;
    }
  }

  let bestIdx = 0;
  let bestSep = -1;
  for (let c = 0; c < KEY_COLORS.length; c++) {
    if (minDist[c] > bestSep) {
      bestSep = minDist[c];
      bestIdx = c;
    }
  }

  return KEY_COLORS.map((k, idx) => ({
    hex: k.hex,
    badge: idx === bestIdx ? 'best' : minDist[idx] < 80 ? 'avoid' : 'default',
    selected: idx === bestIdx,
  }));
}

export function scoreKeyColorsFromReferenceImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number
): SwatchScore[] | null {
  const cornerSamples: { r: number; g: number; b: number }[] = [];
  const s = 5;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const idx = (y * width + x) * 4;
      cornerSamples.push({ r: data[idx], g: data[idx + 1], b: data[idx + 2] });
    }
  }

  const bgR = cornerSamples.map((c) => c.r).sort((a, b) => a - b)[Math.floor(cornerSamples.length / 2)];
  const bgG = cornerSamples.map((c) => c.g).sort((a, b) => a - b)[Math.floor(cornerSamples.length / 2)];
  const bgB = cornerSamples.map((c) => c.b).sort((a, b) => a - b)[Math.floor(cornerSamples.length / 2)];

  const fgPixels: { r: number; g: number; b: number }[] = [];
  const step = 3;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3];
      if (a < 128) continue;
      const bgDist = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
      if (bgDist < 40) continue;
      fgPixels.push({ r, g, b });
    }
  }

  if (fgPixels.length < 10) return null;

  const scores = KEY_COLORS.map((key) => {
    let minD = Infinity;
    for (const px of fgPixels) {
      const dist = Math.abs(px.r - key.r) + Math.abs(px.g - key.g) + Math.abs(px.b - key.b);
      if (dist < minD) minD = dist;
    }
    return { key, minDist: minD };
  });

  scores.sort((a, b) => b.minDist - a.minDist);
  const bestHex = scores[0].key.hex;

  return KEY_COLORS.map((k) => {
    const score = scores.find((s) => s.key.hex === k.hex)!;
    return {
      hex: k.hex,
      badge: k.hex === bestHex ? 'best' : score.minDist < 80 ? 'avoid' : 'default',
      selected: k.hex === bestHex,
    };
  });
}

export function rgbToLab(r: number, g: number, b: number): { L: number; a: number; b: number } {
  let rr = r / 255;
  let gg = g / 255;
  let bb = b / 255;
  rr = rr > 0.04045 ? Math.pow((rr + 0.055) / 1.055, 2.4) : rr / 12.92;
  gg = gg > 0.04045 ? Math.pow((gg + 0.055) / 1.055, 2.4) : gg / 12.92;
  bb = bb > 0.04045 ? Math.pow((bb + 0.055) / 1.055, 2.4) : bb / 12.92;

  let x = (rr * 0.4124 + gg * 0.3576 + bb * 0.1805) / 0.95047;
  let y = (rr * 0.2126 + gg * 0.7152 + bb * 0.0722) / 1.0;
  let z = (rr * 0.0193 + gg * 0.1192 + bb * 0.9505) / 1.08883;

  x = x > 0.008856 ? Math.cbrt(x) : 7.787 * x + 16 / 116;
  y = y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116;
  z = z > 0.008856 ? Math.cbrt(z) : 7.787 * z + 16 / 116;

  return {
    L: 116 * y - 16,
    a: 500 * (x - y),
    b: 200 * (y - z),
  };
}
