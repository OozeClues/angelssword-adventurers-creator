/**
 * ⚔️ AS Adventurer — Model Exporter Module
 * Angel's Sword Studios
 *
 * Chroma key removal, GIF/WebM export pipeline.
 * Ported from Fugi Maker EX with enhancements for the
 * AS Adventurer VTuber creation pipeline.
 *
 * Contains:
 *   - GifEncoder       GIF89a binary encoder with LZW compression
 *   - ColorQuantizer   Median Cut color quantization with transparency
 *   - GifDecoder       GIF89a binary decoder with compositing
 *   - ChromaKey        Multi-pass chroma key processor (4-step pipeline)
 *   - ModelExporter     Main UI controller + WebM/GIF export
 */

// ═══════════════════════════════════════════════════════════════════
//  GIF ENCODER
// ═══════════════════════════════════════════════════════════════════

class GifEncoder {
    constructor(width, height, loop = 0) {
        this.width = width;
        this.height = height;
        this.loop = loop; // 0 = infinite
        this.bufSize = 1024 * 256; // start with 256KB
        this.buf = new Uint8Array(this.bufSize);
        this.bufPos = 0;
        this.started = false;
        this.frameCount = 0;
    }

    /* ─── Low-level writers ─── */
    _grow(needed) {
        while (this.bufPos + needed > this.bufSize) {
            this.bufSize *= 2;
        }
        const newBuf = new Uint8Array(this.bufSize);
        newBuf.set(this.buf);
        this.buf = newBuf;
    }
    writeByte(v) {
        if (this.bufPos >= this.bufSize) this._grow(1024);
        this.buf[this.bufPos++] = v & 0xFF;
    }
    writeShort(v) { this.writeByte(v & 0xFF); this.writeByte((v >> 8) & 0xFF); }
    writeString(s) { for (let i = 0; i < s.length; i++) this.writeByte(s.charCodeAt(i)); }
    writeBytes(arr) { for (let i = 0; i < arr.length; i++) this.writeByte(arr[i]); }

    /* ─── GIF Structure ─── */
    writeHeader() {
        this.writeString('GIF89a');
    }

    writeLogicalScreenDescriptor() {
        this.writeShort(this.width);
        this.writeShort(this.height);
        // Packed: no GCT (0), color res 7 (111), no sort (0), GCT size 0 (000)
        this.writeByte(0x70); // 0111_0000
        this.writeByte(0);    // bg color index
        this.writeByte(0);    // pixel aspect ratio
    }

    writeNetscapeExtension() {
        this.writeByte(0x21); // Extension introducer
        this.writeByte(0xFF); // Application extension
        this.writeByte(0x0B); // Block size
        this.writeString('NETSCAPE2.0');
        this.writeByte(0x03); // Sub-block size
        this.writeByte(0x01); // Sub-block ID
        this.writeShort(this.loop);
        this.writeByte(0x00); // Block terminator
    }

    writeGraphicControlExtension(delayCentiseconds, transparentIndex, disposal = 2) {
        this.writeByte(0x21); // Extension introducer
        this.writeByte(0xF9); // GCE label
        this.writeByte(0x04); // Block size
        // Packed: reserved(000), disposal(DDD), no user input(0), transparent flag(1)
        const packed = ((disposal & 0x07) << 2) | 0x01;
        this.writeByte(packed);
        this.writeShort(delayCentiseconds);
        this.writeByte(transparentIndex);
        this.writeByte(0x00); // Block terminator
    }

    writeImageDescriptor(lctSizeField, left = 0, top = 0, w = this.width, h = this.height) {
        this.writeByte(0x2C); // Image separator
        this.writeShort(left);
        this.writeShort(top);
        this.writeShort(w);
        this.writeShort(h);
        // Packed: LCT flag(1), no interlace(0), no sort(0), reserved(00), LCT size
        this.writeByte(0x80 | (lctSizeField & 0x07));
    }

    writeColorTable(palette, tableSize) {
        for (let i = 0; i < tableSize; i++) {
            if (i < palette.length) {
                this.writeByte(palette[i][0]); // R
                this.writeByte(palette[i][1]); // G
                this.writeByte(palette[i][2]); // B
            } else {
                this.writeByte(0); this.writeByte(0); this.writeByte(0);
            }
        }
    }

    writeLZWData(indexedPixels, minCodeSize) {
        this.writeByte(minCodeSize);

        const clearCode = 1 << minCodeSize;
        const eoiCode = clearCode + 1;
        const maxCodeValue = 4096;

        let codeSize = minCodeSize + 1;
        let nextCode = eoiCode + 1;
        // Open-addressing hash table for LZW — much faster than Map
        const HASH_SIZE = 8192;
        const hashKeys = new Int32Array(HASH_SIZE).fill(-1);
        const hashVals = new Int32Array(HASH_SIZE);

        const subBlockData = [];
        let curByte = 0;
        let curBit = 0;

        const emitCode = (code) => {
            curByte |= (code << curBit);
            curBit += codeSize;
            while (curBit >= 8) {
                subBlockData.push(curByte & 0xFF);
                curByte >>>= 8;
                curBit -= 8;
            }
        };

        const resetTable = () => {
            hashKeys.fill(-1);
            codeSize = minCodeSize + 1;
            nextCode = eoiCode + 1;
        };

        // Emit clear code to start
        emitCode(clearCode);
        resetTable();

        if (indexedPixels.length === 0) {
            emitCode(eoiCode);
        } else {
            let w = indexedPixels[0];

            for (let i = 1; i < indexedPixels.length; i++) {
                const k = indexedPixels[i];
                const key = w * (clearCode + 2) + k;
                // Open-addressing lookup
                let slot = (key * 2654435761 >>> 0) & (HASH_SIZE - 1);
                let found = false;
                while (hashKeys[slot] !== -1) {
                    if (hashKeys[slot] === key) {
                        w = hashVals[slot];
                        found = true;
                        break;
                    }
                    slot = (slot + 1) & (HASH_SIZE - 1);
                }
                if (!found) {
                    emitCode(w);

                    if (nextCode < maxCodeValue) {
                        hashKeys[slot] = key;
                        hashVals[slot] = nextCode;
                        if (nextCode >= (1 << codeSize) && codeSize < 12) {
                            codeSize++;
                        }
                        nextCode++;
                    } else {
                        emitCode(clearCode);
                        resetTable();
                    }

                    w = k;
                }
            }

            emitCode(w);
            emitCode(eoiCode);
        }

        // Flush remaining bits
        if (curBit > 0) {
            subBlockData.push(curByte & 0xFF);
        }

        // Write sub-blocks (max 255 bytes each)
        this._grow(subBlockData.length + Math.ceil(subBlockData.length / 255) + 2);
        let pos = 0;
        while (pos < subBlockData.length) {
            const chunkSize = Math.min(255, subBlockData.length - pos);
            this.buf[this.bufPos++] = chunkSize;
            for (let j = 0; j < chunkSize; j++) {
                this.buf[this.bufPos++] = subBlockData[pos++];
            }
        }
        this.buf[this.bufPos++] = 0x00; // Block terminator
    }

    /* ─── High-level API ─── */
    begin() {
        this.bufSize = 1024 * 256;
        this.buf = new Uint8Array(this.bufSize);
        this.bufPos = 0;
        this.writeHeader();
        this.writeLogicalScreenDescriptor();
        this.writeNetscapeExtension();
        this.started = true;
    }

    addFrame(palette, indexedPixels, transparentIndex, delayCentiseconds) {
        if (!this.started) this.begin();

        // Calculate LCT parameters
        const minCodeSize = Math.max(2, Math.ceil(Math.log2(palette.length)));
        const tableSize = 1 << minCodeSize;
        const lctSizeField = minCodeSize - 1;

        // Pad palette to table size
        const paddedPalette = [...palette];
        while (paddedPalette.length < tableSize) {
            paddedPalette.push([0, 0, 0]);
        }

        this.writeGraphicControlExtension(delayCentiseconds, transparentIndex);
        this.writeImageDescriptor(lctSizeField);
        this.writeColorTable(paddedPalette, tableSize);
        this.writeLZWData(indexedPixels, minCodeSize);
    }

    /**
     * Add an optimized delta frame. Compares rgba to the previous frame,
     * only encodes changed pixels within the minimum bounding box.
     */
    addOptimizedFrame(rgba, palette, transparentIndex, delayCentiseconds) {
        if (!this.started) this.begin();
        const w = this.width, h = this.height;
        const numPixels = w * h;

        // Persistent color cache across frames (RGB key → palette index)
        if (!this._colorCache) this._colorCache = new Map();
        const cache = this._colorCache;

        // Map all pixels to palette indices with caching
        const indexed = new Uint8Array(numPixels);
        for (let i = 0; i < numPixels; i++) {
            const a = rgba[i * 4 + 3];
            if (a < 128) {
                indexed[i] = transparentIndex;
            } else {
                const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
                const key = (r << 16) | (g << 8) | b;
                let idx = cache.get(key);
                if (idx === undefined) {
                    idx = ColorQuantizer.nearestPaletteIndex(palette, r, g, b, transparentIndex);
                    cache.set(key, idx);
                }
                indexed[i] = idx;
            }
        }

        const minCodeSize = Math.max(2, Math.ceil(Math.log2(palette.length)));
        const tableSize = 1 << minCodeSize;
        const lctSizeField = minCodeSize - 1;
        const paddedPalette = [...palette];
        while (paddedPalette.length < tableSize) paddedPalette.push([0, 0, 0]);

        // Find bounding box of all OPAQUE pixels to avoid encoding empty borders
        let minX = w, minY = h, maxX = -1, maxY = -1;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (indexed[y * w + x] !== transparentIndex) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }

        // Disposal=2 (restore to background) — prevents ghosting
        this.writeGraphicControlExtension(delayCentiseconds, transparentIndex, 2);

        if (maxX < 0) {
            // Fully transparent frame — write tiny 1x1
            const tinyPixels = new Uint8Array([transparentIndex]);
            this.writeImageDescriptor(lctSizeField, 0, 0, 1, 1);
            this.writeColorTable(paddedPalette, tableSize);
            this.writeLZWData(tinyPixels, minCodeSize);
        } else {
            // Extract bounding box sub-image
            const bw = maxX - minX + 1;
            const bh = maxY - minY + 1;
            const subPixels = new Uint8Array(bw * bh);
            for (let y = 0; y < bh; y++) {
                for (let x = 0; x < bw; x++) {
                    subPixels[y * bw + x] = indexed[(minY + y) * w + (minX + x)];
                }
            }

            this.writeImageDescriptor(lctSizeField, minX, minY, bw, bh);
            this.writeColorTable(paddedPalette, tableSize);
            this.writeLZWData(subPixels, minCodeSize);
        }

        this.frameCount++;
    }

    finish() {
        this.writeByte(0x3B); // GIF trailer
        return this.buf.slice(0, this.bufPos);
    }
}


// ═══════════════════════════════════════════════════════════════════
//  COLOR QUANTIZER
// ═══════════════════════════════════════════════════════════════════

class ColorQuantizer {

    static quantize(rgba, maxColors) {
        const numPixels = rgba.length / 4;
        // Reserve one slot for transparent color
        const paletteSlots = Math.max(2, maxColors - 1);

        // Separate transparent vs opaque pixels
        const opaqueColors = [];
        const transparentMask = new Uint8Array(numPixels);

        for (let i = 0; i < numPixels; i++) {
            const a = rgba[i * 4 + 3];
            if (a < 128) {
                transparentMask[i] = 1;
            } else {
                opaqueColors.push(i);
            }
        }

        // Build palette from opaque pixels using median cut
        let palette;
        if (opaqueColors.length === 0) {
            palette = [[0, 0, 0]];
        } else {
            palette = ColorQuantizer.medianCut(rgba, opaqueColors, paletteSlots);
        }

        // Transparent color gets the last index
        const transparentIndex = palette.length;
        palette.push([0, 0, 0]); // transparent entry (color doesn't matter)

        // Map each pixel to nearest palette entry
        const indexedPixels = new Uint8Array(numPixels);
        for (let i = 0; i < numPixels; i++) {
            if (transparentMask[i]) {
                indexedPixels[i] = transparentIndex;
            } else {
                const r = rgba[i * 4];
                const g = rgba[i * 4 + 1];
                const b = rgba[i * 4 + 2];
                indexedPixels[i] = ColorQuantizer.nearestPaletteIndex(palette, r, g, b, transparentIndex);
            }
        }

        return { palette, indexedPixels, transparentIndex };
    }

    static medianCut(rgba, pixelIndices, targetColors) {
        // Build list of RGB values
        const colors = pixelIndices.map(i => [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]);

        if (colors.length === 0) return [[0, 0, 0]];
        if (targetColors <= 1) {
            return [ColorQuantizer.averageColors(colors)];
        }

        let boxes = [colors];

        while (boxes.length < targetColors) {
            // Find the box with the greatest color range
            let bestIdx = -1;
            let bestRange = -1;

            for (let i = 0; i < boxes.length; i++) {
                if (boxes[i].length <= 1) continue;
                const range = ColorQuantizer.maxRange(boxes[i]);
                if (range > bestRange) {
                    bestRange = range;
                    bestIdx = i;
                }
            }

            if (bestIdx === -1) break;

            const box = boxes[bestIdx];
            const channel = ColorQuantizer.longestChannel(box);

            // Sort by the longest channel
            box.sort((a, b) => a[channel] - b[channel]);

            const mid = Math.floor(box.length / 2);
            const box1 = box.slice(0, mid);
            const box2 = box.slice(mid);

            boxes.splice(bestIdx, 1, box1, box2);
        }

        return boxes.map(box => ColorQuantizer.averageColors(box));
    }

    static maxRange(colors) {
        let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
        for (const c of colors) {
            if (c[0] < rMin) rMin = c[0]; if (c[0] > rMax) rMax = c[0];
            if (c[1] < gMin) gMin = c[1]; if (c[1] > gMax) gMax = c[1];
            if (c[2] < bMin) bMin = c[2]; if (c[2] > bMax) bMax = c[2];
        }
        return Math.max(rMax - rMin, gMax - gMin, bMax - bMin);
    }

    static longestChannel(colors) {
        let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
        for (const c of colors) {
            if (c[0] < rMin) rMin = c[0]; if (c[0] > rMax) rMax = c[0];
            if (c[1] < gMin) gMin = c[1]; if (c[1] > gMax) gMax = c[1];
            if (c[2] < bMin) bMin = c[2]; if (c[2] > bMax) bMax = c[2];
        }
        const rRange = rMax - rMin, gRange = gMax - gMin, bRange = bMax - bMin;
        if (rRange >= gRange && rRange >= bRange) return 0;
        if (gRange >= bRange) return 1;
        return 2;
    }

    static averageColors(colors) {
        if (colors.length === 0) return [0, 0, 0];
        let rSum = 0, gSum = 0, bSum = 0;
        for (const c of colors) {
            rSum += c[0]; gSum += c[1]; bSum += c[2];
        }
        const n = colors.length;
        return [Math.round(rSum / n), Math.round(gSum / n), Math.round(bSum / n)];
    }

    static nearestPaletteIndex(palette, r, g, b, excludeIndex) {
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < palette.length; i++) {
            if (i === excludeIndex) continue;
            const dr = r - palette[i][0];
            const dg = g - palette[i][1];
            const db = b - palette[i][2];
            const dist = dr * dr + dg * dg + db * db;
            if (dist < bestDist) {
                bestDist = dist;
                bestIdx = i;
                if (dist === 0) return i; // exact match — skip rest
            }
        }
        return bestIdx;
    }
}


// ═══════════════════════════════════════════════════════════════════
//  GIF DECODER
// ═══════════════════════════════════════════════════════════════════

class GifDecoder {
    /**
     * Decode a GIF file into structured frame data.
     * @param {ArrayBuffer} arrayBuffer
     * @returns {{ width, height, frames: Array<{rgba, delay, left, top, width, height, disposalMethod}> }}
     */
    static decode(arrayBuffer) {
        const d = new Uint8Array(arrayBuffer);
        let p = 0;
        const u8 = () => d[p++];
        const u16 = () => { const v = d[p] | (d[p + 1] << 8); p += 2; return v; };

        // Header
        const sig = String.fromCharCode(d[0], d[1], d[2], d[3], d[4], d[5]);
        if (sig !== 'GIF87a' && sig !== 'GIF89a') throw new Error('Not a valid GIF file');
        p = 6;

        // Logical Screen Descriptor
        const width = u16();
        const height = u16();
        const packed = u8();
        const gctFlag = (packed >> 7) & 1;
        const gctSizePow = (packed & 7) + 1;
        const gctCount = 1 << gctSizePow;
        const bgIndex = u8();
        p++; // pixel aspect ratio

        // Global Color Table
        let gct = null;
        if (gctFlag) {
            gct = [];
            for (let i = 0; i < gctCount; i++) gct.push([u8(), u8(), u8()]);
        }

        const frames = [];
        let transIdx = -1, disposal = 0, delay = 100;

        while (p < d.length) {
            const block = u8();

            if (block === 0x21) { // Extension
                const label = u8();
                if (label === 0xF9) { // Graphic Control Extension
                    p++; // block size (always 4)
                    const gp = u8();
                    disposal = (gp >> 2) & 7;
                    const transFlag = gp & 1;
                    delay = u16() * 10; // centiseconds → ms
                    if (delay === 0) delay = 100;
                    transIdx = transFlag ? u8() : (p++, -1);
                    p++; // block terminator
                } else {
                    // Skip sub-blocks
                    while (true) { const sz = u8(); if (sz === 0) break; p += sz; }
                }
            } else if (block === 0x2C) { // Image Descriptor
                const left = u16(), top = u16(), imgW = u16(), imgH = u16();
                const imgPacked = u8();
                const lctFlag = (imgPacked >> 7) & 1;
                const interlaced = (imgPacked >> 6) & 1;
                const lctCount = lctFlag ? (1 << ((imgPacked & 7) + 1)) : 0;

                let ct = gct;
                if (lctFlag) {
                    ct = [];
                    for (let i = 0; i < lctCount; i++) ct.push([u8(), u8(), u8()]);
                }

                // LZW Decompress
                const minCodeSize = u8();
                const compressed = [];
                while (true) { const sz = u8(); if (sz === 0) break; for (let i = 0; i < sz; i++) compressed.push(d[p++]); }

                const indices = GifDecoder.lzwDecode(minCodeSize, compressed, imgW * imgH);

                // Build RGBA
                let rgba = new Uint8ClampedArray(imgW * imgH * 4);
                for (let i = 0; i < imgW * imgH; i++) {
                    const idx = i < indices.length ? indices[i] : 0;
                    if (idx === transIdx) {
                        // transparent
                    } else if (ct && idx < ct.length) {
                        rgba[i * 4] = ct[idx][0]; rgba[i * 4 + 1] = ct[idx][1]; rgba[i * 4 + 2] = ct[idx][2]; rgba[i * 4 + 3] = 255;
                    }
                }

                // Deinterlace
                if (interlaced) {
                    const de = new Uint8ClampedArray(imgW * imgH * 4);
                    const passes = [{ s: 0, d: 8 }, { s: 4, d: 8 }, { s: 2, d: 4 }, { s: 1, d: 2 }];
                    let row = 0;
                    for (const ps of passes) {
                        for (let y = ps.s; y < imgH; y += ps.d) {
                            de.set(rgba.subarray(row * imgW * 4, (row + 1) * imgW * 4), y * imgW * 4);
                            row++;
                        }
                    }
                    rgba = de;
                }

                frames.push({ left, top, width: imgW, height: imgH, rgba, delay, disposalMethod: disposal, transparentIndex: transIdx });
                transIdx = -1; disposal = 0;
            } else if (block === 0x3B) { break; } // Trailer
            else { break; } // Unknown
        }

        return { width, height, frames };
    }

    static lzwDecode(minCodeSize, compressed, pixelCount) {
        const clearCode = 1 << minCodeSize;
        const eoiCode = clearCode + 1;
        let codeSize = minCodeSize + 1;
        let nextCode = eoiCode + 1;

        // Code table: each entry is an array of pixel indices
        let table = [];
        const resetTable = () => {
            table = [];
            for (let i = 0; i < clearCode; i++) table.push([i]);
            table.push([]); // clear
            table.push([]); // eoi
            codeSize = minCodeSize + 1;
            nextCode = eoiCode + 1;
        };
        resetTable();

        // Bit reader
        let bytePos = 0, bitPos = 0;
        const readCode = () => {
            let code = 0;
            for (let i = 0; i < codeSize; i++) {
                if (bytePos >= compressed.length) return -1;
                if (compressed[bytePos] & (1 << bitPos)) code |= (1 << i);
                bitPos++;
                if (bitPos >= 8) { bitPos = 0; bytePos++; }
            }
            return code;
        };

        const output = [];
        let prev = -1;

        while (output.length < pixelCount) {
            const code = readCode();
            if (code === -1 || code === eoiCode) break;
            if (code === clearCode) { resetTable(); prev = -1; continue; }

            let entry;
            if (code < table.length) {
                entry = table[code];
            } else if (code === nextCode && prev >= 0) {
                entry = [...table[prev], table[prev][0]];
            } else break;

            for (let i = 0; i < entry.length; i++) output.push(entry[i]);

            if (prev >= 0 && nextCode < 4096) {
                table.push([...table[prev], entry[0]]);
                nextCode++;
                if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
            }
            prev = code;
        }
        return output.length > pixelCount ? output.slice(0, pixelCount) : output;
    }

    /**
     * Composite decoded frames into full RGBA canvases, respecting disposal methods.
     */
    static compositeFrames(gif) {
        const { width, height, frames } = gif;
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');

        const result = [];
        let prevImageData = null;

        for (const frame of frames) {
            // Disposal: 2 = restore to bg (clear), 3 = restore to previous
            if (frame.disposalMethod === 2) {
                ctx.clearRect(0, 0, width, height);
            } else if (frame.disposalMethod === 3 && prevImageData) {
                ctx.putImageData(prevImageData, 0, 0);
            }

            // Save state before drawing if disposal 3
            if (frame.disposalMethod === 3) {
                prevImageData = ctx.getImageData(0, 0, width, height);
            }

            // Draw frame patch
            const patch = new ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height);
            ctx.putImageData(patch, frame.left, frame.top);

            // Capture composited frame
            const full = ctx.getImageData(0, 0, width, height);
            result.push({ rgba: new Uint8ClampedArray(full.data), delay: frame.delay });
        }
        return result;
    }
}


// ═══════════════════════════════════════════════════════════════════
//  CHROMA KEY — Multi-pass processor (4-step pipeline)
// ═══════════════════════════════════════════════════════════════════

class ChromaKey {
    constructor() {
        this.keyR = 0;
        this.keyG = 255;
        this.keyB = 0;
        this.similarity = 0.40;     // 0-1 (OBS default: 400/1000)
        this.smoothness = 0.08;     // 0-1 (OBS default: 80/1000)
        this.spillSuppression = 0.10; // 0-1 (OBS default: 100/1000)
        this.postSaturation = 1;    // 0-2
        this.postBrightness = 1;    // 0.5-1.5
        this.edgeFadeWidth = 0;     // 0-200 pixels (0 = off)
        this.antiAlias = false;     // smooth jagged edges
        this.smokeCleanup = false;  // neutralize key-colored VFX (smoke, etc.)

        // Pre-computed YUV key color (updated when key color changes)
        this._keyU = 0;
        this._keyV = 0;
        this._updateKeyUV();
    }

    setKeyColor(r, g, b) {
        this.keyR = r;
        this.keyG = g;
        this.keyB = b;
        this._updateKeyUV();
    }

    setKeyColorHex(hex) {
        hex = hex.replace('#', '');
        this.keyR = parseInt(hex.substr(0, 2), 16);
        this.keyG = parseInt(hex.substr(2, 2), 16);
        this.keyB = parseInt(hex.substr(4, 2), 16);
        this._updateKeyUV();
    }

    /**
     * Pre-compute the key color in YUV space (U and V components).
     * Uses the BT.601 YUV matrix (same as OBS).
     */
    _updateKeyUV() {
        const r = this.keyR / 255, g = this.keyG / 255, b = this.keyB / 255;
        this._keyU = -0.148736 * r - 0.331264 * g + 0.5 * b;
        this._keyV =  0.5 * r - 0.418688 * g - 0.081312 * b;
    }

    /**
     * OBS CORE: Chroma Distance
     * Ported from OBS chroma_key_filter.effect GetChromaDist()
     * Converts RGB to YUV, returns Euclidean distance in UV plane to key color.
     */
    _getChromaDist(r, g, b) {
        const rf = r / 255, gf = g / 255, bf = b / 255;
        const u = -0.148736 * rf - 0.331264 * gf + 0.5 * bf;
        const v =  0.5 * rf - 0.418688 * gf - 0.081312 * bf;
        const du = u - this._keyU;
        const dv = v - this._keyV;
        return Math.sqrt(du * du + dv * dv);
    }

    /**
     * OBS CORE: Box-Filtered Chroma Distance
     * Ported from OBS GetBoxFilteredChromaDist()
     * Samples 4 cardinal neighbors + center pixel, weighted average.
     * This smooths the chroma distance across a neighborhood, preventing
     * single-pixel noise and producing smoother edges (less jaggies).
     *
     * IMPORTANT: After our flood fill step, alpha=0 pixels still contain
     * key-color RGB data. We must skip them — otherwise their low chroma
     * distance contaminates the average and makes foreground edge pixels
     * incorrectly transparent.
     *
     * Weighting: valid neighbors x 2 + center x 1, normalized.
     */
    _getBoxFilteredDist(x, y, data, w, h) {
        const idx = (y * w + x) * 4;
        const centerDist = this._getChromaDist(data[idx], data[idx + 1], data[idx + 2]);

        let distSum = centerDist; // Center weighted 1x
        let totalWeight = 1;

        // 4 cardinal neighbors — only include if opaque (not flood-filled)
        const offsets = [
            x > 0 ? idx - 4 : -1,
            x < w - 1 ? idx + 4 : -1,
            y > 0 ? idx - w * 4 : -1,
            y < h - 1 ? idx + w * 4 : -1
        ];

        for (const ni of offsets) {
            if (ni >= 0 && data[ni + 3] > 0) {
                distSum += this._getChromaDist(data[ni], data[ni + 1], data[ni + 2]) * 2;
                totalWeight += 2;
            }
        }

        return distSum / totalWeight;
    }

    /**
     * Check if a pixel matches the background color within tolerance.
     */
    isBackgroundPixel(data, idx, bgColor, tolerance) {
        const dr = Math.abs(data[idx] - bgColor.r);
        const dg = Math.abs(data[idx + 1] - bgColor.g);
        const db = Math.abs(data[idx + 2] - bgColor.b);
        return (dr + dg + db) / 3 <= tolerance;
    }

    // ═══════════════════════════════════════════════════════════════
    //  MAIN PROCESS — Clean 4-step pipeline
    // ═══════════════════════════════════════════════════════════════

    process(imageData) {
        const bgColor = { r: this.keyR, g: this.keyG, b: this.keyB };
        const tolerance = this.similarity * 110;

        // Step 1: Edge flood fill — remove background connected to borders
        this.edgeFloodFill(imageData, bgColor, tolerance);

        // Step 2: OBS chroma key — box-filtered alpha mask + spill suppression
        this._obsChromaKey(imageData);

        // Step 3: Periphery outline blackout — anime-specific edge cleanup
        this._peripheryBlackout(imageData, bgColor);

        // Step 4: Smoke cleanup — optional toggle for VFX elements
        if (this.smokeCleanup) {
            this._smokeCleanup(imageData, bgColor);
        }

        // Post-processing: saturation + brightness
        if (this.postSaturation !== 1 || this.postBrightness !== 1) {
            this._postProcess(imageData);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  STEP 1: Edge Flood Fill
    //  BFS from image borders — removes background connected to edges.
    //  OBS doesn't need this (it processes every pixel in real-time),
    //  but we need it because we export to transparent PNG where
    //  interior pockets of key color (e.g. between legs) must be
    //  handled separately from outer background.
    // ═══════════════════════════════════════════════════════════════

    edgeFloodFill(imageData, bgColor, tolerance) {
        const { data, width, height } = imageData;
        const totalPixels = width * height;
        const visited = new Uint8Array(totalPixels);
        const queue = [];

        // Seed from all edge pixels matching background
        for (let x = 0; x < width; x++) {
            const topIdx = x;
            const botIdx = (height - 1) * width + x;
            if (this.isBackgroundPixel(data, topIdx * 4, bgColor, tolerance)) {
                queue.push(topIdx); visited[topIdx] = 1;
            }
            if (this.isBackgroundPixel(data, botIdx * 4, bgColor, tolerance)) {
                queue.push(botIdx); visited[botIdx] = 1;
            }
        }
        for (let y = 1; y < height - 1; y++) {
            const leftIdx = y * width;
            const rightIdx = y * width + (width - 1);
            if (this.isBackgroundPixel(data, leftIdx * 4, bgColor, tolerance)) {
                queue.push(leftIdx); visited[leftIdx] = 1;
            }
            if (this.isBackgroundPixel(data, rightIdx * 4, bgColor, tolerance)) {
                queue.push(rightIdx); visited[rightIdx] = 1;
            }
        }

        // BFS flood fill
        let head = 0;
        while (head < queue.length) {
            const pixelIdx = queue[head++];
            const x = pixelIdx % width;
            const y = Math.floor(pixelIdx / width);
            const neighbors = [];
            if (x > 0) neighbors.push(pixelIdx - 1);
            if (x < width - 1) neighbors.push(pixelIdx + 1);
            if (y > 0) neighbors.push(pixelIdx - width);
            if (y < height - 1) neighbors.push(pixelIdx + width);
            for (const nIdx of neighbors) {
                if (visited[nIdx] === 0) {
                    if (this.isBackgroundPixel(data, nIdx * 4, bgColor, tolerance)) {
                        visited[nIdx] = 1;
                        queue.push(nIdx);
                    } else {
                        visited[nIdx] = 2;
                    }
                }
            }
        }

        // Apply transparency to background pixels
        for (let i = 0; i < totalPixels; i++) {
            if (visited[i] === 1) {
                data[i * 4 + 3] = 0;
            }
        }
        return imageData;
    }

    // ═══════════════════════════════════════════════════════════════
    //  STEP 2: OBS Chroma Key
    //  Direct port of OBS Studio's ProcessChromaKey shader.
    //
    //  For each opaque pixel:
    //  1. Compute box-filtered chroma distance (smooth edges)
    //  2. Alpha mask: fullMask = pow(clamp((dist-sim)/smooth, 0, 1), 1.5)
    //  3. Spill: spillVal = pow(clamp((dist-sim)/spill, 0, 1), 1.5)
    //     rgb = lerp(luminance, rgb, spillVal)
    //
    //  Replaces old Steps 2-3.6 with a single clean pass.
    // ═══════════════════════════════════════════════════════════════

    _obsChromaKey(imageData) {
        const { data, width, height } = imageData;
        const total = width * height;
        const sim = this.similarity;
        const smooth = Math.max(0.002, this.smoothness);
        const spill = Math.max(0.002, this.spillSuppression);

        // Build distance-from-transparent map (BFS, max depth 4).
        // Smoothness alpha is ONLY applied to pixels near edges (depth 1-4).
        // Interior pixels use binary keying — this prevents video compression
        // noise from making the entire character semi-transparent.
        const EDGE_DEPTH = 4;
        const edgeDist = new Uint8Array(total);
        edgeDist.fill(255);
        const queue = [];
        for (let i = 0; i < total; i++) {
            if (data[i * 4 + 3] === 0) { edgeDist[i] = 0; queue.push(i); }
        }
        let head = 0;
        while (head < queue.length) {
            const pi = queue[head++];
            const dd = edgeDist[pi];
            if (dd >= EDGE_DEPTH) continue;
            const px = pi % width, py = (pi - px) / width;
            if (px > 0     && edgeDist[pi - 1] > dd + 1) { edgeDist[pi - 1] = dd + 1; queue.push(pi - 1); }
            if (px < width - 1 && edgeDist[pi + 1] > dd + 1) { edgeDist[pi + 1] = dd + 1; queue.push(pi + 1); }
            if (py > 0     && edgeDist[pi - width] > dd + 1) { edgeDist[pi - width] = dd + 1; queue.push(pi - width); }
            if (py < height - 1 && edgeDist[pi + width] > dd + 1) { edgeDist[pi + width] = dd + 1; queue.push(pi + width); }
        }

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;

                // Skip already-transparent pixels (from flood fill)
                if (data[idx + 3] === 0) continue;

                const r = data[idx], g = data[idx + 1], b = data[idx + 2];
                const pixIdx = y * width + x;
                const depth = edgeDist[pixIdx];

                // Box-filtered chroma distance (smooth edges like OBS)
                const chromaDist = this._getBoxFilteredDist(x, y, data, width, height);

                // OBS formula: baseMask = chromaDist - similarity
                const baseMask = chromaDist - sim;

                // Alpha masking — edge-aware
                if (depth <= EDGE_DEPTH) {
                    // EDGE PIXEL: Apply full OBS smoothness formula
                    // fullMask = pow(saturate(baseMask / smoothness), 1.5)
                    const fullMask = Math.pow(Math.max(0, Math.min(1, baseMask / smooth)), 1.5);
                    data[idx + 3] = Math.round(data[idx + 3] * fullMask);
                } else {
                    // INTERIOR PIXEL: Binary keying only
                    // If chroma distance <= similarity, it's key color — remove it
                    if (baseMask <= 0) {
                        data[idx + 3] = 0;
                    }
                    // Otherwise keep fully opaque — no smoothness fade
                }

                // Spill suppression applies everywhere (color only, no alpha change)
                // spillVal = pow(saturate(baseMask / spill), 1.5)
                const spillVal = Math.pow(Math.max(0, Math.min(1, baseMask / spill)), 1.5);

                if (spillVal < 0.999) {
                    // BT.709 luminance
                    const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
                    data[idx]     = Math.max(0, Math.min(255, Math.round(lum + (r - lum) * spillVal)));
                    data[idx + 1] = Math.max(0, Math.min(255, Math.round(lum + (g - lum) * spillVal)));
                    data[idx + 2] = Math.max(0, Math.min(255, Math.round(lum + (b - lum) * spillVal)));
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  STEP 3: Periphery Outline Blackout (anime-specific)
    //  Darkens key-contaminated pixels within 2px of transparent edges.
    //  In anime art, edges are always dark outlines — any remaining
    //  key color contamination at boundaries should become outline.
    // ═══════════════════════════════════════════════════════════════

    _peripheryBlackout(imageData, bgColor) {
        const d = imageData.data;
        const w = imageData.width;
        const h = imageData.height;
        const total = w * h;
        const keyMax = Math.max(bgColor.r, bgColor.g, bgColor.b);
        const isKeyR = bgColor.r > keyMax * 0.7;
        const isKeyG = bgColor.g > keyMax * 0.7;
        const isKeyB = bgColor.b > keyMax * 0.7;

        // Build distance-from-transparent map (BFS, max depth 2)
        const edgeDist = new Uint8Array(total);
        edgeDist.fill(255);
        const queue = [];
        for (let i = 0; i < total; i++) {
            if (d[i * 4 + 3] === 0) { edgeDist[i] = 0; queue.push(i); }
        }
        let head = 0;
        while (head < queue.length) {
            const pi = queue[head++];
            const dist = edgeDist[pi];
            if (dist >= 2) continue;
            const px = pi % w, py = (pi - px) / w;
            if (px > 0     && edgeDist[pi - 1] > dist + 1) { edgeDist[pi - 1] = dist + 1; queue.push(pi - 1); }
            if (px < w - 1 && edgeDist[pi + 1] > dist + 1) { edgeDist[pi + 1] = dist + 1; queue.push(pi + 1); }
            if (py > 0     && edgeDist[pi - w] > dist + 1) { edgeDist[pi - w] = dist + 1; queue.push(pi - w); }
            if (py < h - 1 && edgeDist[pi + w] > dist + 1) { edgeDist[pi + w] = dist + 1; queue.push(pi + w); }
        }

        for (let i = 0; i < total; i++) {
            const dist = edgeDist[i];
            if (dist === 0 || dist > 2) continue;
            const idx = i * 4;
            if (d[idx + 3] < 200) continue; // Skip semi-transparent (wings, hair)

            const r = d[idx], g = d[idx + 1], b = d[idx + 2];

            // Check for key color contamination in channel pattern
            let contamination = 0;
            if (isKeyR && isKeyB && !isKeyG) {
                // Magenta: R and/or B elevated vs G
                const exR = Math.max(0, r - g);
                const exB = Math.max(0, b - g);
                contamination = Math.max(exR, exB);
            } else if (isKeyR && isKeyG && !isKeyB) {
                const exR = Math.max(0, r - b);
                const exG = Math.max(0, g - b);
                contamination = Math.max(exR, exG);
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
            d[idx]     = Math.round(r * (1 - strength) + darkTarget * strength);
            d[idx + 1] = Math.round(g * (1 - strength) + darkTarget * strength);
            d[idx + 2] = Math.round(b * (1 - strength) + darkTarget * strength);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  STEP 4: Smoke Cleanup (optional toggle)
    //  Converts remaining key-colored elements (smoke, VFX) into
    //  semi-transparent dark gray. Uses YCbCr chroma distance.
    //  Protected body zone prevents interior damage.
    // ═══════════════════════════════════════════════════════════════

    _smokeCleanup(imageData, bgColor) {
        const d = imageData.data;
        const w = imageData.width;
        const h = imageData.height;
        const total = w * h;
        const keyCb = 128 + (-0.168736 * bgColor.r - 0.331264 * bgColor.g + 0.5 * bgColor.b);
        const keyCr = 128 + (0.5 * bgColor.r - 0.418688 * bgColor.g - 0.081312 * bgColor.b);
        const SMOKE_THRESHOLD = 40;
        const SMOKE_SOFTEDGE = 60;
        const BODY_DEPTH = 6;

        // BFS: distance from nearest transparent pixel
        const distFromTP = new Uint8Array(total);
        distFromTP.fill(255);
        const bfsQ = [];
        for (let i = 0; i < total; i++) {
            if (d[i * 4 + 3] === 0) { distFromTP[i] = 0; bfsQ.push(i); }
        }
        let bfsHead = 0;
        while (bfsHead < bfsQ.length) {
            const pi = bfsQ[bfsHead++];
            const dd = distFromTP[pi];
            if (dd >= BODY_DEPTH) continue;
            const px = pi % w, py = (pi - px) / w;
            if (px > 0     && distFromTP[pi - 1] > dd + 1) { distFromTP[pi - 1] = dd + 1; bfsQ.push(pi - 1); }
            if (px < w - 1 && distFromTP[pi + 1] > dd + 1) { distFromTP[pi + 1] = dd + 1; bfsQ.push(pi + 1); }
            if (py > 0     && distFromTP[pi - w] > dd + 1) { distFromTP[pi - w] = dd + 1; bfsQ.push(pi - w); }
            if (py < h - 1 && distFromTP[pi + w] > dd + 1) { distFromTP[pi + w] = dd + 1; bfsQ.push(pi + w); }
        }

        for (let j = 0; j < d.length; j += 4) {
            if (d[j + 3] < 1) continue;
            const pxIdx = j >> 2;
            const depth = distFromTP[pxIdx];
            if (depth > BODY_DEPTH) continue;

            const r = d[j], g = d[j + 1], b = d[j + 2];
            const cb = 128 + (-0.168736 * r - 0.331264 * g + 0.5 * b);
            const cr = 128 + (0.5 * r - 0.418688 * g - 0.081312 * b);
            const dcb = cb - keyCb, dcr = cr - keyCr;
            const chromaDist = Math.sqrt(dcb * dcb + dcr * dcr);

            if (chromaDist >= SMOKE_THRESHOLD + SMOKE_SOFTEDGE) continue;

            let contamination;
            if (chromaDist < SMOKE_THRESHOLD) {
                contamination = 1.0;
            } else {
                contamination = 1.0 - (chromaDist - SMOKE_THRESHOLD) / SMOKE_SOFTEDGE;
            }
            contamination = Math.pow(contamination, 0.7);
            contamination *= Math.max(0, 1 - depth / BODY_DEPTH);
            if (contamination < 0.01) continue;

            const lum = r * 0.299 + g * 0.587 + b * 0.114;
            const origAlpha = d[j + 3];

            if (origAlpha < 200) {
                // Semi-transparent pixel (wings, hair, VFX details):
                // Desaturate key color instead of removing alpha.
                const darkVal = Math.min(lum * 0.5, 80);
                d[j]     = Math.round(r * (1 - contamination * 0.7) + darkVal * (contamination * 0.7));
                d[j + 1] = Math.round(g * (1 - contamination * 0.7) + darkVal * (contamination * 0.7));
                d[j + 2] = Math.round(b * (1 - contamination * 0.7) + darkVal * (contamination * 0.7));
                d[j + 3] = Math.round(origAlpha * (1 - contamination * 0.3));
            } else {
                // Fully opaque key-colored pixel (actual smoke):
                const darkVal = Math.min(lum * 0.2, 30);
                d[j]     = Math.round(r * (1 - contamination) + darkVal * contamination);
                d[j + 1] = Math.round(g * (1 - contamination) + darkVal * contamination);
                d[j + 2] = Math.round(b * (1 - contamination) + darkVal * contamination);
                d[j + 3] = Math.round(origAlpha * (1 - contamination * 0.85));
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  POST-PROCESSING: Saturation + Brightness
    // ═══════════════════════════════════════════════════════════════

    _postProcess(imageData) {
        const d = imageData.data;
        const sat = this.postSaturation;
        const bright = this.postBrightness;
        for (let j = 0; j < d.length; j += 4) {
            if (d[j + 3] === 0) continue;
            let r = d[j], g = d[j + 1], b = d[j + 2];

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

            d[j]     = Math.max(0, Math.min(255, r));
            d[j + 1] = Math.max(0, Math.min(255, g));
            d[j + 2] = Math.max(0, Math.min(255, b));
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  EDGE FADE — Fade alpha near left/right/top borders
    // ═══════════════════════════════════════════════════════════════

    applyEdgeFade(imageData, fadeWidth) {
        if (fadeWidth <= 0) return;
        const { data, width, height } = imageData;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                if (data[idx + 3] === 0) continue;

                // Calculate minimum distance to left, right, or top edge
                let edgeFactor = 1;
                const leftDist = x;
                const rightDist = width - 1 - x;
                const topDist = y;
                // No bottom fade — screen naturally cuts off there

                const minDist = Math.min(leftDist, rightDist, topDist);

                if (minDist < fadeWidth) {
                    // Smooth fade using squared curve for natural falloff
                    const t = minDist / fadeWidth;
                    edgeFactor = t * t; // Quadratic ease-in
                }

                if (edgeFactor < 1) {
                    data[idx + 3] = Math.round(data[idx + 3] * edgeFactor);
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  ANTI-ALIASING — Smooth jagged alpha edges via 3x3 kernel
    //  O(n) single pass, ~1-3ms per 1080p frame.
    // ═══════════════════════════════════════════════════════════════

    applyAntiAlias(imageData) {
        const { data, width, height } = imageData;
        const total = width * height;

        // Reuse cached buffer to avoid per-frame allocation (GC pressure)
        if (!this._aaBuffer || this._aaBuffer.length < total) {
            this._aaBuffer = new Uint8Array(total);
        }
        const origAlpha = this._aaBuffer;

        // Copy alpha channel
        for (let i = 0; i < total; i++) {
            origAlpha[i] = data[i * 4 + 3];
        }

        // Pre-compute row offsets
        const W = width;

        for (let y = 1; y < height - 1; y++) {
            const rowStart = y * W;
            for (let x = 1; x < W - 1; x++) {
                const i = rowStart + x;
                const alpha = origAlpha[i];

                // Skip transparent and semi-transparent pixels
                if (alpha < 128) continue;

                // Fast cardinal-only edge check (avoid full kernel for interior)
                const aUp    = origAlpha[i - W];
                const aDown  = origAlpha[i + W];
                const aLeft  = origAlpha[i - 1];
                const aRight = origAlpha[i + 1];

                if (aUp >= 128 && aDown >= 128 && aLeft >= 128 && aRight >= 128) {
                    // Also check diagonals
                    if (origAlpha[i - W - 1] >= 128 && origAlpha[i - W + 1] >= 128 &&
                        origAlpha[i + W - 1] >= 128 && origAlpha[i + W + 1] >= 128) {
                        continue; // Fully interior pixel, skip
                    }
                }

                // Unrolled 3x3 weighted kernel
                // Cardinal neighbors (weight 2), diagonals (weight 1), center (weight 2)
                // Total max weight = 4 cardinals*2 + 4 diagonals*1 + 1 center*2 = 14
                let opaqueW = 0;
                if (alpha >= 128)                      opaqueW += 2; // center
                if (aUp >= 128)                        opaqueW += 2; // up
                if (aDown >= 128)                      opaqueW += 2; // down
                if (aLeft >= 128)                      opaqueW += 2; // left
                if (aRight >= 128)                     opaqueW += 2; // right
                if (origAlpha[i - W - 1] >= 128)       opaqueW += 1; // top-left
                if (origAlpha[i - W + 1] >= 128)       opaqueW += 1; // top-right
                if (origAlpha[i + W - 1] >= 128)       opaqueW += 1; // bottom-left
                if (origAlpha[i + W + 1] >= 128)       opaqueW += 1; // bottom-right

                const smoothAlpha = Math.round((opaqueW / 14) * 255);

                // Only reduce alpha, never increase it
                if (smoothAlpha < alpha) {
                    data[i * 4 + 3] = smoothAlpha;
                }
            }
        }
    }
}

class ModelExporter {
    constructor() {
        // Mode limits
        this.MODE_LIMITS = {
            adventurer: { format: 'webm', maxFrames: Infinity, maxWidth: Infinity, maxHeight: Infinity },
            normal:     { format: 'gif',  maxFrames: 120,      maxWidth: 1000,     maxHeight: 1000 },
            premium:    { format: 'gif',  maxFrames: 600,      maxWidth: 4000,     maxHeight: 4000 }
        };

        this.mode = 'adventurer';
        this.chromaKey = new ChromaKey();
        this.previewMode = 'checker';
        this.eyedropperActive = false;

        // Video state
        this.video = null;
        this.videoLoaded = false;
        this.videoWidth = 0;
        this.videoHeight = 0;
        this.fps = 30;
        this.duration = 0;
        this.totalFrames = 0;
        this.currentFrame = 0;
        this.isPlaying = false;
        this.playTimer = null;

        // Canvas
        this.previewCanvas = null;
        this.previewCtx = null;
        this.workCanvas = null;
        this.workCtx = null;

        // Scale/offset
        this.videoScale = 1;
        this.videoOffset = 0;

        // Crop
        this.cropEnabled = false;
        this.cropRatio = '1:1';
        this.cropX = 0;
        this.cropY = 0;
        this.cropW = 0;
        this.cropH = 0;
        this.cropSize = 0;

        // Export state
        this.isExporting = false;
        this._exportCancelled = false;
        this.lastExportBlob = null;
        this.lastExportFormat = null;

        // Ping-pong / reverse (from Video Prep handoff)
        this.pingPongMode = false;
        this.reverseMode = false;

        this.init();
    }

    init() {
        this.previewCanvas = document.getElementById('exCanvas');
        this.previewCtx = this.previewCanvas.getContext('2d', { willReadFrequently: true });

        this.workCanvas = document.createElement('canvas');
        this.workCtx = this.workCanvas.getContext('2d', { willReadFrequently: true });

        this.video = document.createElement('video');
        this.video.muted = true;
        this.video.playsInline = true;
        this.video.preload = 'metadata'; // Don't buffer entire video (reduces GPU video decode load)
        this.video.pause(); // Ensure no playback — we only use it as a frame source

        this.bindUpload();
        this.bindModeToggle();
        this.bindColorSwatches();
        this.bindSliders();
        this.bindPreviewModes();
        this.bindPlayback();
        this.bindCropOverlay();
        this.bindExportSettings();
        this.bindFilenamePresets();
        this.bindExportButton();
        this.bindEyedropper();
        this.bindAutoDetect();
        this.bindHandoff();

        this.loadPersistedSliders();
        this.updateModeLimitsDisplay();
    }

    // ─── UPLOAD ───
    bindUpload() {
        window.initUploadZone('exUploadZone', 'exFileInput', (files) => {
            const file = files[0];
            if (!file || !file.type.startsWith('video/')) {
                window.showToast('Please upload a video file', 'error');
                return;
            }
            this.loadVideo(file);
        });
    }

    loadVideo(fileOrBlob) {
        const url = URL.createObjectURL(fileOrBlob);
        this.video.src = url;

        this.video.addEventListener('loadedmetadata', () => {
            this.videoWidth = this.video.videoWidth;
            this.videoHeight = this.video.videoHeight;
            this.duration = this.video.duration;
            this.fps = 30; // default assumption
            this.totalFrames = Math.floor(this.duration * this.fps);
            this.currentFrame = 0;

            // Set canvas size
            this.previewCanvas.width = this.videoWidth;
            this.previewCanvas.height = this.videoHeight;
            this.workCanvas.width = this.videoWidth;
            this.workCanvas.height = this.videoHeight;

            // Enable stages
            document.getElementById('exStage2').classList.remove('disabled');
            document.getElementById('exStage3').classList.remove('disabled');

            // Set scrubber
            const scrubber = document.getElementById('exScrubber');
            scrubber.max = this.totalFrames - 1;
            scrubber.value = 0;

            // Set export range defaults
            document.getElementById('exStartFrame').value = 0;
            document.getElementById('exEndFrame').value = this.totalFrames - 1;
            document.getElementById('exWidth').value = this.videoWidth;
            document.getElementById('exHeight').value = this.videoHeight;

            this.videoLoaded = true;
            this.updateFrameInfo();
            this.updateVideoInfo();
            this.updateSizeEstimate();

            // Seek to frame 0 so the browser decodes a visible frame for the canvas
            this.video.currentTime = 0;
            this.video.addEventListener('seeked', () => {
                this.updatePreview();
                // Auto-detect chroma key color on load
                document.getElementById('exAutoDetect')?.click();
                window.showToast(`Video loaded: ${this.videoWidth}×${this.videoHeight}, ${this.totalFrames} frames`, 'success');
            }, { once: true });
        }, { once: true });

        this.video.load();
    }

    loadVideoFromUrl(url) {
        this.video.src = url;

        this.video.addEventListener('loadedmetadata', () => {
            this.videoWidth = this.video.videoWidth;
            this.videoHeight = this.video.videoHeight;
            this.duration = this.video.duration;
            this.fps = this.detectedFps || 30;
            this.totalFrames = Math.floor(this.duration * this.fps);
            this.currentFrame = 0;

            this.previewCanvas.width = this.videoWidth;
            this.previewCanvas.height = this.videoHeight;
            this.workCanvas.width = this.videoWidth;
            this.workCanvas.height = this.videoHeight;

            document.getElementById('exStage2').classList.remove('disabled');
            document.getElementById('exStage3').classList.remove('disabled');

            const scrubber = document.getElementById('exScrubber');
            scrubber.max = this.totalFrames - 1;
            scrubber.value = 0;

            document.getElementById('exStartFrame').value = 0;
            document.getElementById('exEndFrame').value = this.totalFrames - 1;
            document.getElementById('exWidth').value = this.videoWidth;
            document.getElementById('exHeight').value = this.videoHeight;

            this.videoLoaded = true;
            this.updateFrameInfo();
            this.updateVideoInfo();
            this.updateSizeEstimate();

            // Seek to frame 0 so the browser decodes a visible frame for the canvas
            this.video.currentTime = 0;
            this.video.addEventListener('seeked', () => {
                this.updatePreview();
                // Auto-detect chroma key color on load
                document.getElementById('exAutoDetect')?.click();
                window.showToast(`Video loaded: ${this.videoWidth}×${this.videoHeight}, ${this.totalFrames} frames`, 'success');
            }, { once: true });
        }, { once: true });

        this.video.load();
    }

    // ─── HANDOFF FROM VIDEO PREP ───
    bindHandoff() {
        const fromVP = document.getElementById('exFromVideoPrep');
        const handoff = window.ASAdventurer.handoff;

        // Check for handoff data periodically or on tab switch
        const checkHandoff = async () => {
            if (handoff.videoPrepData) {
                const data = handoff.videoPrepData;

                // Video Prep sends videoSrc (a URL string) not a blob
                const videoSource = data.blob || data.videoSrc;
                if (videoSource) {
                    // If it's a URL string, fetch it as a blob first
                    if (typeof videoSource === 'string') {
                        try {
                            const resp = await fetch(videoSource);
                            const blob = await resp.blob();
                            this.loadVideo(blob);
                        } catch (e) {
                            // Fallback: load video directly from URL
                            console.warn('[ModelExporter] Could not fetch video blob, loading from URL:', e.message);
                            this.loadVideoFromUrl(videoSource);
                        }
                    } else {
                        // It's already a Blob/File
                        this.loadVideo(videoSource);
                    }
                    if (fromVP) fromVP.classList.remove('hidden');

                    // Apply handoff settings
                    if (data.keyColor) {
                        const rgb = window.hexToRgb(data.keyColor);
                        if (rgb) {
                            this.chromaKey.setKeyColor(rgb.r, rgb.g, rgb.b);
                            this._selectSwatch(data.keyColor);
                        }
                    }

                    if (data.loopMode === 'pingpong') {
                        this.pingPongMode = true;
                        this.reverseMode = false;
                    } else if (data.loopMode === 'reverse') {
                        this.pingPongMode = false;
                        this.reverseMode = true;
                    } else {
                        this.pingPongMode = false;
                        this.reverseMode = false;
                    }

                    // Store FPS from Video Prep if available
                    if (data.fps) {
                        this.detectedFps = data.fps;
                    }

                    // Consume handoff data
                    handoff.videoPrepData = null;
                    window.showToast('Video received from Video Prep!', 'success');
                }
            }
        };

        // Listen for tab switches to the exporter tab (manual clicks)
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-tab="tab-exporter"]');
            if (btn) setTimeout(checkHandoff, 100);
        });

        // Auto-detect when videoPrepData is set (covers programmatic switchTab)
        let _vpData = handoff.videoPrepData || null;
        Object.defineProperty(handoff, 'videoPrepData', {
            get() { return _vpData; },
            set(val) {
                _vpData = val;
                if (val) setTimeout(checkHandoff, 200);
            },
            configurable: true,
            enumerable: true
        });

        // Also check on init in case data was set before this module loaded
        setTimeout(checkHandoff, 500);
    }

    _selectSwatch(hex) {
        const container = document.getElementById('exColorSwatches');
        container.querySelectorAll('.color-swatch').forEach(s => {
            s.classList.toggle('selected', s.dataset.color === hex.toUpperCase());
        });
    }

    // ─── EXPORT MODE TOGGLE ───
    bindModeToggle() {
        window.initModeSelector('exportModeToggle', (mode) => {
            this.mode = mode;
            this.updateModeLimitsDisplay();
            this.updateSizeEstimate();
        });
    }

    updateModeLimitsDisplay() {
        const el = document.getElementById('exModeLimits');
        const limits = this.MODE_LIMITS[this.mode];
        const names = { adventurer: 'Adventurer', normal: 'F. Normal', premium: 'F. Premium' };

        const maxFrames = limits.maxFrames === Infinity ? 'Unlimited' : limits.maxFrames;
        const maxRes = limits.maxWidth === Infinity ? 'Unlimited' : `${limits.maxWidth}×${limits.maxHeight}`;

        el.innerHTML = `
            <div><strong class="text-gold">${names[this.mode]}</strong></div>
            <div>Format: ${limits.format.toUpperCase()}</div>
            <div>Max Frames: ${maxFrames}</div>
            <div>Max Resolution: ${maxRes}</div>
        `;

        // Update format display
        const estFormat = document.getElementById('exEstFormat');
        if (estFormat) estFormat.textContent = `Format: ${limits.format.toUpperCase()}`;
    }

    // ─── COLOR SWATCHES ───
    bindColorSwatches() {
        window.initColorSwatches('exColorSwatches', (color) => {
            const rgb = window.hexToRgb(color);
            this.chromaKey.setKeyColor(rgb.r, rgb.g, rgb.b);
            this.updatePreview();
        });
    }

    // ─── EYEDROPPER ───
    bindEyedropper() {
        const eyedropperBtn = document.getElementById('exEyedropper');

        eyedropperBtn.addEventListener('click', () => {
            this.eyedropperActive = !this.eyedropperActive;
            document.getElementById('exCanvasContainer').classList.toggle('eyedropper-mode', this.eyedropperActive);
            eyedropperBtn.classList.toggle('active', this.eyedropperActive);
        });

        this.previewCanvas.addEventListener('click', (e) => {
            if (!this.eyedropperActive || !this.videoLoaded) return;

            const rect = this.previewCanvas.getBoundingClientRect();
            const scaleX = this.previewCanvas.width / rect.width;
            const scaleY = this.previewCanvas.height / rect.height;
            const x = Math.floor((e.clientX - rect.left) * scaleX);
            const y = Math.floor((e.clientY - rect.top) * scaleY);

            // Sample from original video frame (not the keyed preview)
            this.workCtx.drawImage(this.video, 0, 0, this.videoWidth, this.videoHeight);
            const pixel = this.workCtx.getImageData(x, y, 1, 1).data;

            const hex = '#' + [pixel[0], pixel[1], pixel[2]].map(c => c.toString(16).padStart(2, '0')).join('');
            this.chromaKey.setKeyColor(pixel[0], pixel[1], pixel[2]);
            this._selectSwatch(hex);

            // Deactivate eyedropper
            this.eyedropperActive = false;
            document.getElementById('exCanvasContainer').classList.remove('eyedropper-mode');
            eyedropperBtn.classList.remove('active');

            this.updatePreview();
            window.showToast(`Key color set to ${hex.toUpperCase()}`, 'success');
        });
    }

    // ─── AUTO DETECT ───
    bindAutoDetect() {
        const btn = document.getElementById('exAutoDetect');
        btn.addEventListener('click', () => {
            if (!this.videoLoaded) return;

            // Sample corners + edges of the frame to detect the most common color
            this.workCtx.drawImage(this.video, 0, 0, this.videoWidth, this.videoHeight);
            const w = this.videoWidth, h = this.videoHeight;

            const samplePoints = [];
            // Top and bottom edges
            for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 50))) {
                samplePoints.push([x, 0], [x, h - 1]);
            }
            // Left and right edges
            for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 50))) {
                samplePoints.push([0, y], [w - 1, y]);
            }

            // Count colors
            const colorCounts = {};
            for (const [x, y] of samplePoints) {
                const pixel = this.workCtx.getImageData(x, y, 1, 1).data;
                // Quantize to reduce noise
                const qr = Math.min(255, Math.round(pixel[0] / 16) * 16);
                const qg = Math.min(255, Math.round(pixel[1] / 16) * 16);
                const qb = Math.min(255, Math.round(pixel[2] / 16) * 16);
                const key = `${qr},${qg},${qb}`;
                colorCounts[key] = (colorCounts[key] || 0) + 1;
            }

            // Find most common
            let bestKey = null, bestCount = 0;
            for (const [key, count] of Object.entries(colorCounts)) {
                if (count > bestCount) { bestCount = count; bestKey = key; }
            }

            if (bestKey) {
                const [r, g, b] = bestKey.split(',').map(Number);
                this.chromaKey.setKeyColor(r, g, b);
                const hex = '#' + [r, g, b].map(c => Math.min(255, c).toString(16).padStart(2, '0')).join('');
                this._selectSwatch(hex);
                this.updatePreview();
                window.showToast(`Auto-detected key color: ${hex.toUpperCase()}`, 'success');
            }
        });
    }

    // ─── SLIDERS ───
    bindSliders() {
        const debounced = window.debounce(() => this.updatePreview(), 150);

        // Similarity
        const simSlider = document.getElementById('exSimilarity');
        simSlider.addEventListener('input', () => {
            document.getElementById('exSimilarityVal').textContent = simSlider.value + '%';
            this.chromaKey.similarity = parseInt(simSlider.value) / 100;
            this.persistSliders();
            debounced();
        });

        // Smoothness
        const smoothSlider = document.getElementById('exSmoothness');
        smoothSlider.addEventListener('input', () => {
            document.getElementById('exSmoothnessVal').textContent = smoothSlider.value + '%';
            this.chromaKey.smoothness = parseInt(smoothSlider.value) / 100;
            this.persistSliders();
            debounced();
        });

        // Spill Suppression
        const spillSlider = document.getElementById('exSpillSuppress');
        spillSlider.addEventListener('input', () => {
            document.getElementById('exSpillSuppressVal').textContent = spillSlider.value + '%';
            this.chromaKey.spillSuppression = parseInt(spillSlider.value) / 100;
            this.persistSliders();
            debounced();
        });

        // Scale
        const scaleSlider = document.getElementById('exScale');
        scaleSlider.addEventListener('input', () => {
            document.getElementById('exScaleVal').textContent = scaleSlider.value + '%';
            this.videoScale = parseInt(scaleSlider.value) / 100;
            this.persistSliders();
            debounced();
        });

        // Vertical Offset
        const vOffsetSlider = document.getElementById('exVOffset');
        vOffsetSlider.addEventListener('input', () => {
            document.getElementById('exVOffsetVal').textContent = vOffsetSlider.value + 'px';
            this.videoOffset = parseInt(vOffsetSlider.value);
            this.persistSliders();
            debounced();
        });

        // Saturation
        const satSlider = document.getElementById('exSaturation');
        satSlider.addEventListener('input', () => {
            document.getElementById('exSaturationVal').textContent = satSlider.value + '%';
            this.chromaKey.postSaturation = parseInt(satSlider.value) / 100;
            this.persistSliders();
            debounced();
        });

        // Brightness
        const brightSlider = document.getElementById('exBrightness');
        brightSlider.addEventListener('input', () => {
            document.getElementById('exBrightnessVal').textContent = brightSlider.value + '%';
            this.chromaKey.postBrightness = parseInt(brightSlider.value) / 100;
            this.persistSliders();
            debounced();
        });

        // Reference Image for saturation matching
        const refFileInput = document.getElementById('exRefImage');
        const refBtn = document.getElementById('exRefImageBtn');
        const refMatchBtn = document.getElementById('exRefMatchBtn');
        const refThumb = document.getElementById('exRefThumb');
        const refClearBtn = document.getElementById('exRefClearBtn');
        this._refImageData = null; // stored reference ImageData

        if (refBtn) {
            refBtn.addEventListener('click', () => refFileInput.click());
            refFileInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const img = new Image();
                img.onload = () => {
                    // Draw to offscreen canvas to get pixel data
                    const c = document.createElement('canvas');
                    c.width = img.width;
                    c.height = img.height;
                    const ctx = c.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    this._refImageData = ctx.getImageData(0, 0, img.width, img.height);

                    // Show thumbnail + buttons
                    refThumb.src = c.toDataURL();
                    refThumb.style.display = '';
                    refMatchBtn.style.display = '';
                    refClearBtn.style.display = '';
                    URL.revokeObjectURL(img.src);
                };
                img.src = URL.createObjectURL(file);
            });
        }

        if (refClearBtn) {
            refClearBtn.addEventListener('click', () => {
                this._refImageData = null;
                refThumb.style.display = 'none';
                refMatchBtn.style.display = 'none';
                refClearBtn.style.display = 'none';
                refFileInput.value = '';
            });
        }

        if (refMatchBtn) {
            refMatchBtn.addEventListener('click', () => {
                if (!this._refImageData || !this.videoLoaded) return;
                const bgColor = { r: this.chromaKey.keyR, g: this.chromaKey.keyG, b: this.chromaKey.keyB };
                const refAvgSat = this._computeAvgSaturation(this._refImageData, bgColor);

                // Get current processed output saturation
                const w = this.videoWidth, h = this.videoHeight;
                this.workCtx.clearRect(0, 0, w, h);
                const scale = this.videoScale || 1;
                const vOffset = this.videoOffset || 0;
                const sw = Math.round(w * scale), sh = Math.round(h * scale);
                const dx = Math.round((w - sw) / 2), dy = Math.round((h - sh) / 2) + vOffset;
                this.workCtx.drawImage(this.video, 0, 0, this.video.videoWidth, this.video.videoHeight, dx, dy, sw, sh);
                const outData = this.workCtx.getImageData(0, 0, w, h);
                // Process without post-saturation to get base output
                const savedSat = this.chromaKey.postSaturation;
                this.chromaKey.postSaturation = 1;
                this.chromaKey.process(outData);
                this.chromaKey.postSaturation = savedSat;
                const outAvgSat = this._computeAvgSaturation(outData, bgColor, true);

                if (outAvgSat > 0.001) {
                    const ratio = refAvgSat / outAvgSat;
                    const newSatPercent = Math.round(Math.max(0, Math.min(200, ratio * 100)));
                    const satSlider = document.getElementById('exSaturation');
                    satSlider.value = newSatPercent;
                    document.getElementById('exSaturationVal').textContent = newSatPercent + '%';
                    this.chromaKey.postSaturation = newSatPercent / 100;
                    this.persistSliders();
                    this.updatePreview();
                    console.log(`[RefMatch] ref=${refAvgSat.toFixed(3)} out=${outAvgSat.toFixed(3)} ratio=${ratio.toFixed(2)} → sat=${newSatPercent}%`);
                }
            });
        }

        // Edge Fade
        const fadeSlider = document.getElementById('exEdgeFade');
        if (fadeSlider) {
            fadeSlider.addEventListener('input', () => {
                document.getElementById('exEdgeFadeVal').textContent = fadeSlider.value + 'px';
                this.chromaKey.edgeFadeWidth = parseInt(fadeSlider.value);
                this.persistSliders();
                debounced();
            });
        }

        // Anti-Aliasing toggle
        const aaToggle = document.getElementById('exAntiAlias');
        if (aaToggle) {
            aaToggle.addEventListener('change', () => {
                this.chromaKey.antiAlias = aaToggle.checked;
                this.persistSliders();
                debounced();
            });
        }

        // Smoke Cleanup toggle
        const smokeToggle = document.getElementById('exSmokeCleanup');
        if (smokeToggle) {
            smokeToggle.addEventListener('change', () => {
                this.chromaKey.smokeCleanup = smokeToggle.checked;
                this.persistSliders();
                debounced();
            });
        }
    }

    persistSliders() {
        const data = {
            similarity: document.getElementById('exSimilarity').value,
            smoothness: document.getElementById('exSmoothness').value,
            spillSuppress: document.getElementById('exSpillSuppress').value,
            scale: document.getElementById('exScale').value,
            vOffset: document.getElementById('exVOffset').value,
            saturation: document.getElementById('exSaturation').value,
            brightness: document.getElementById('exBrightness').value,
            edgeFade: document.getElementById('exEdgeFade')?.value || '0',
            antiAlias: document.getElementById('exAntiAlias')?.checked || false,
            smokeCleanup: document.getElementById('exSmokeCleanup')?.checked || false,
        };
        localStorage.setItem('ex_slider_values', JSON.stringify(data));
    }

    loadPersistedSliders() {
        try {
            const raw = localStorage.getItem('ex_slider_values');
            if (!raw) return;
            const data = JSON.parse(raw);

            const setSlider = (id, valId, suffix, value, apply) => {
                const slider = document.getElementById(id);
                const display = document.getElementById(valId);
                if (slider && value !== undefined) {
                    slider.value = value;
                    if (display) display.textContent = value + suffix;
                    if (apply) apply(value);
                }
            };

            setSlider('exSimilarity', 'exSimilarityVal', '%', data.similarity, v => this.chromaKey.similarity = v / 100);
            setSlider('exSmoothness', 'exSmoothnessVal', '%', data.smoothness, v => this.chromaKey.smoothness = v / 100);
            setSlider('exSpillSuppress', 'exSpillSuppressVal', '%', data.spillSuppress, v => this.chromaKey.spillSuppression = v / 100);
            setSlider('exScale', 'exScaleVal', '%', data.scale, v => this.videoScale = v / 100);
            setSlider('exVOffset', 'exVOffsetVal', 'px', data.vOffset, v => this.videoOffset = parseInt(v));
            setSlider('exSaturation', 'exSaturationVal', '%', data.saturation, v => this.chromaKey.postSaturation = v / 100);
            setSlider('exBrightness', 'exBrightnessVal', '%', data.brightness, v => this.chromaKey.postBrightness = v / 100);
            setSlider('exEdgeFade', 'exEdgeFadeVal', 'px', data.edgeFade, v => this.chromaKey.edgeFadeWidth = parseInt(v));

            // Restore anti-alias toggle
            const aaToggle = document.getElementById('exAntiAlias');
            if (aaToggle && data.antiAlias !== undefined) {
                aaToggle.checked = data.antiAlias;
                this.chromaKey.antiAlias = data.antiAlias;
            }

            // Restore smoke cleanup toggle
            const smokeToggle = document.getElementById('exSmokeCleanup');
            if (smokeToggle && data.smokeCleanup !== undefined) {
                smokeToggle.checked = data.smokeCleanup;
                this.chromaKey.smokeCleanup = data.smokeCleanup;
            }
        } catch (e) {
            // ignore
        }
    }

    // ─── PREVIEW MODES ───
    bindPreviewModes() {
        const container = document.getElementById('exPreviewModes');
        container.addEventListener('click', (e) => {
            const btn = e.target.closest('.preview-mode-btn');
            if (!btn) return;

            container.querySelectorAll('.preview-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            this.previewMode = btn.dataset.mode;

            const area = document.getElementById('exCanvasContainer');
            area.classList.remove('preview-checker');
            area.style.backgroundColor = '';

            if (this.previewMode === 'checker') {
                area.classList.add('preview-checker');
            } else if (this.previewMode === 'black') {
                area.style.backgroundColor = '#000';
            } else if (this.previewMode === 'white') {
                area.style.backgroundColor = '#fff';
            } else {
                area.style.backgroundColor = '#1a1a1a';
            }

            this.updatePreview();
        });
    }

    // ─── PLAYBACK ───
    bindPlayback() {
        const playBtn = document.getElementById('exPlayBtn');
        const scrubber = document.getElementById('exScrubber');
        const prevBtn = document.getElementById('exPrevFrame');
        const nextBtn = document.getElementById('exNextFrame');

        playBtn.addEventListener('click', () => {
            if (this.isPlaying) {
                this.stopPlayback();
            } else {
                this.startPlayback();
            }
        });

        scrubber.addEventListener('input', () => {
            if (this.isPlaying) this.stopPlayback();
            this.currentFrame = parseInt(scrubber.value);
            this.seekToFrame(this.currentFrame);
        });

        prevBtn.addEventListener('click', () => {
            if (this.isPlaying) this.stopPlayback();
            this.currentFrame = Math.max(0, this.currentFrame - 1);
            document.getElementById('exScrubber').value = this.currentFrame;
            this.seekToFrame(this.currentFrame);
        });

        nextBtn.addEventListener('click', () => {
            if (this.isPlaying) this.stopPlayback();
            this.currentFrame = Math.min(this.totalFrames - 1, this.currentFrame + 1);
            document.getElementById('exScrubber').value = this.currentFrame;
            this.seekToFrame(this.currentFrame);
        });
    }

    startPlayback() {
        if (!this.videoLoaded) return;
        this.isPlaying = true;
        document.getElementById('exPlayBtn').textContent = '⏸';

        const frameInterval = 1000 / this.fps;
        this.playTimer = setInterval(() => {
            this.currentFrame++;
            if (this.currentFrame >= this.totalFrames) {
                this.currentFrame = 0;
            }
            this.seekToFrame(this.currentFrame);
            document.getElementById('exScrubber').value = this.currentFrame;
        }, frameInterval);
    }

    stopPlayback() {
        this.isPlaying = false;
        document.getElementById('exPlayBtn').textContent = '▶️';
        if (this.playTimer) {
            clearInterval(this.playTimer);
            this.playTimer = null;
        }
    }

    seekToFrame(frameNum) {
        const time = frameNum / this.fps;
        const targetTime = Math.min(time, this.duration - 0.001);
        this.updateFrameInfo();

        if (Math.abs(this.video.currentTime - targetTime) < 0.001) {
            this.previewCtx.drawImage(this.video, 0, 0, this.videoWidth, this.videoHeight);
            this._debouncedKeyPreview();
            return;
        }

        this.video.currentTime = targetTime;
        this.video.addEventListener('seeked', () => {
            this.previewCtx.drawImage(this.video, 0, 0, this.videoWidth, this.videoHeight);
            this._debouncedKeyPreview();
        }, { once: true });
    }

    // Debounced keyed preview — only runs ChromaKey 200ms after last seek
    _debouncedKeyPreview() {
        if (this._keyPreviewTimer) clearTimeout(this._keyPreviewTimer);
        this._keyPreviewTimer = setTimeout(() => {
            this.updatePreview();
        }, 200);
    }

    updateFrameInfo() {
        document.getElementById('exFrameInfo').textContent = `${this.currentFrame} / ${Math.max(0, this.totalFrames - 1)}`;
    }

    // Compute average HSL saturation of an ImageData, excluding key-colored pixels
    // bgColor: { r, g, b } — the key color to exclude from analysis
    // skipTransparent: if true, skip alpha=0 pixels (for processed output)
    _computeAvgSaturation(imageData, bgColor, skipTransparent = false) {
        const d = imageData.data;
        const keyCb = 128 + (-0.168736 * bgColor.r - 0.331264 * bgColor.g + 0.5 * bgColor.b);
        const keyCr = 128 + (0.5 * bgColor.r - 0.418688 * bgColor.g - 0.081312 * bgColor.b);
        const keyExcludeRange = 40; // Exclude pixels within this chroma distance of key

        let totalSat = 0, count = 0;
        for (let j = 0; j < d.length; j += 4) {
            if (skipTransparent && d[j + 3] < 10) continue;
            if (!skipTransparent && d[j + 3] < 200) continue; // For ref: only solid pixels

            const r = d[j] / 255, g = d[j + 1] / 255, b = d[j + 2] / 255;
            const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
            const lum = (maxC + minC) / 2;

            // Skip near-black and near-white (saturation is meaningless)
            if (lum < 0.05 || lum > 0.95) continue;

            // Skip key-colored pixels
            const cb = 128 + (-0.168736 * d[j] - 0.331264 * d[j+1] + 0.5 * d[j+2]);
            const cr = 128 + (0.5 * d[j] - 0.418688 * d[j+1] - 0.081312 * d[j+2]);
            const chromaDist = Math.sqrt((cb - keyCb) ** 2 + (cr - keyCr) ** 2);
            if (chromaDist < keyExcludeRange) continue;

            // HSL saturation
            const sat = maxC === minC ? 0 : (maxC - minC) / (1 - Math.abs(2 * lum - 1));
            totalSat += Math.min(1, sat); // clamp
            count++;
        }
        return count > 0 ? totalSat / count : 0;
    }

    // ─── PREVIEW RENDERING ───
    updatePreview() {
        if (!this.videoLoaded) return;

        const w = this.videoWidth;
        const h = this.videoHeight;
        const scale = this.videoScale || 1;
        const vOffset = this.videoOffset || 0;

        if (this.previewMode === 'original') {
            this.previewCtx.clearRect(0, 0, w, h);
            const sw = Math.round(w * scale);
            const sh = Math.round(h * scale);
            const dx = Math.round((w - sw) / 2);
            const dy = Math.round((h - sh) / 2) + vOffset;
            this.previewCtx.drawImage(this.video, 0, 0, this.video.videoWidth, this.video.videoHeight, dx, dy, sw, sh);
            return;
        }

        // Draw video scaled + centered to work canvas
        this.workCtx.clearRect(0, 0, w, h);
        const sw = Math.round(w * scale);
        const sh = Math.round(h * scale);
        const dx = Math.round((w - sw) / 2);
        const dy = Math.round((h - sh) / 2) + vOffset;
        this.workCtx.drawImage(this.video, 0, 0, this.video.videoWidth, this.video.videoHeight, dx, dy, sw, sh);
        const imageData = this.workCtx.getImageData(0, 0, w, h);

        // Apply chroma key
        this.chromaKey.process(imageData);

        // Apply anti-aliasing if enabled
        if (this.chromaKey.antiAlias) {
            this.chromaKey.applyAntiAlias(imageData);
        }

        // Apply edge fade if enabled
        this.chromaKey.applyEdgeFade(imageData, this.chromaKey.edgeFadeWidth);

        // Clear preview and render
        this.previewCtx.clearRect(0, 0, w, h);
        this.previewCtx.putImageData(imageData, 0, 0);
    }

    // ─── CROP OVERLAY ───
    bindCropOverlay() {
        const container = document.getElementById('exCropRatio');
        if (!container) return;

        const overlay = document.getElementById('exCropOverlay');
        const region = document.getElementById('exCropRegion');

        window.initModeSelector('exCropRatio', (ratio) => {
            if (ratio === 'off') {
                this.cropEnabled = false;
                overlay.classList.add('hidden');
                if (this.videoLoaded) {
                    document.getElementById('exWidth').value = this.videoWidth;
                    document.getElementById('exHeight').value = this.videoHeight;
                }
            } else {
                this.cropEnabled = true;
                this.cropRatio = ratio;
                if (this.videoLoaded) {
                    this.resetCropToCenter();
                    this.syncExportDimsToCrop();
                    this.updateCropOverlay();
                    overlay.classList.remove('hidden');
                }
            }
            this.updateSizeEstimate();
        });

        // Draggable crop region
        let dragging = false;
        let dragStartX = 0, dragStartY = 0;
        let startCropX = 0, startCropY = 0;

        region.addEventListener('mousedown', (e) => {
            if (!this.cropEnabled) return;
            dragging = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            startCropX = this.cropX;
            startCropY = this.cropY;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const canvas = this.previewCanvas;
            const canvasRect = canvas.getBoundingClientRect();
            const scaleX = this.videoWidth / canvasRect.width;
            const scaleY = this.videoHeight / canvasRect.height;

            const dx = (e.clientX - dragStartX) * scaleX;
            const dy = (e.clientY - dragStartY) * scaleY;

            this.cropX = Math.round(Math.max(0, Math.min(this.videoWidth - this.cropW, startCropX + dx)));
            this.cropY = Math.round(Math.max(0, Math.min(this.videoHeight - this.cropH, startCropY + dy)));

            this.updateCropOverlay();
        });

        document.addEventListener('mouseup', () => {
            if (dragging) {
                dragging = false;
                this.syncExportDimsToCrop();
            }
        });
    }

    resetCropToCenter() {
        if (!this.videoLoaded) return;
        const ratio = this.cropRatio;
        let rw, rh;
        if (ratio === '1:1') { rw = 1; rh = 1; }
        else if (ratio === '4:3') { rw = 4; rh = 3; }
        else if (ratio === '3:4') { rw = 3; rh = 4; }
        else if (ratio === '16:9') { rw = 16; rh = 9; }
        else if (ratio === '9:16') { rw = 9; rh = 16; }
        else { rw = 1; rh = 1; }

        // Fit the largest crop region of the desired ratio inside the video
        const videoAspect = this.videoWidth / this.videoHeight;
        const cropAspect = rw / rh;

        if (cropAspect >= videoAspect) {
            // Ratio is wider — fit to width
            this.cropW = this.videoWidth;
            this.cropH = Math.round(this.videoWidth / cropAspect);
        } else {
            // Ratio is taller — fit to height
            this.cropH = this.videoHeight;
            this.cropW = Math.round(this.videoHeight * cropAspect);
        }

        // Center the crop
        this.cropX = Math.round((this.videoWidth - this.cropW) / 2);
        this.cropY = Math.round((this.videoHeight - this.cropH) / 2);
    }

    syncExportDimsToCrop() {
        if (!this.cropEnabled || !this.videoLoaded) return;
        // Set export dimensions to match the crop region
        const widthInput = document.getElementById('exWidth');
        const heightInput = document.getElementById('exHeight');
        if (widthInput && heightInput) {
            widthInput.value = this.cropW;
            heightInput.value = this.cropH;
        }
        this.updateSizeEstimate();
    }

    updateCropOverlay() {
        if (!this.cropEnabled || !this.videoLoaded) return;

        const overlay = document.getElementById('exCropOverlay');
        const region = document.getElementById('exCropRegion');

        // Convert video coords to percentage-based positioning (works regardless of canvas CSS size)
        const pctLeft = (this.cropX / this.videoWidth) * 100;
        const pctTop = (this.cropY / this.videoHeight) * 100;
        const pctWidth = (this.cropW / this.videoWidth) * 100;
        const pctHeight = (this.cropH / this.videoHeight) * 100;

        region.style.left = pctLeft + '%';
        region.style.top = pctTop + '%';
        region.style.width = pctWidth + '%';
        region.style.height = pctHeight + '%';

        overlay.classList.remove('hidden');
    }

    // ─── EXPORT SETTINGS ───
    bindExportSettings() {
        // Aspect lock
        const aspectLock = document.getElementById('exAspectLock');
        const widthInput = document.getElementById('exWidth');
        const heightInput = document.getElementById('exHeight');

        widthInput.addEventListener('change', () => {
            if (aspectLock.checked && this.videoLoaded) {
                const ratio = this.videoHeight / this.videoWidth;
                heightInput.value = Math.round(parseInt(widthInput.value) * ratio);
            }
            this.updateSizeEstimate();
        });

        heightInput.addEventListener('change', () => {
            if (aspectLock.checked && this.videoLoaded) {
                const ratio = this.videoWidth / this.videoHeight;
                widthInput.value = Math.round(parseInt(heightInput.value) * ratio);
            }
            this.updateSizeEstimate();
        });

        // Frame range changes
        ['exStartFrame', 'exEndFrame', 'exFrameSkip', 'exFPS'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', () => this.updateSizeEstimate());
        });
    }

    // ─── FILENAME PRESETS ───
    bindFilenamePresets() {
        const container = document.getElementById('exFilenamePresets');
        const filenameInput = document.getElementById('exFilename');

        container.addEventListener('click', (e) => {
            const btn = e.target.closest('.filename-preset-btn');
            if (!btn) return;

            const preset = btn.dataset.preset;
            const charName = window.ASAdventurer.characterName || 'character';
            const safeName = charName.toLowerCase().replace(/[^a-z0-9]/g, '_');

            if (preset === 'custom') {
                filenameInput.focus();
                filenameInput.select();
            } else {
                filenameInput.value = `${safeName}_${preset}`;
            }

            // Highlight active preset
            container.querySelectorAll('.filename-preset-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    }

    // ─── EXPORT BUTTON ───
    bindExportButton() {
        const exportBtn = document.getElementById('exExportBtn');
        const cancelBtn = document.getElementById('exCancelBtn');

        exportBtn.addEventListener('click', () => {
            this.startExport();
        });

        cancelBtn.addEventListener('click', () => {
            this._exportCancelled = true;
        });
    }

    // ─── SIZE ESTIMATE ───
    updateSizeEstimate() {
        const estFrames = document.getElementById('exEstFrames');
        const estSize = document.getElementById('exEstSize');

        if (!this.videoLoaded) {
            estFrames.textContent = 'Frames: --';
            estSize.textContent = 'Est. Size: --';
            return;
        }

        const count = this.getOutputFrameCount();
        estFrames.textContent = `Frames: ${count}`;

        const limits = this.MODE_LIMITS[this.mode];
        const w = parseInt(document.getElementById('exWidth').value) || this.videoWidth;
        const h = parseInt(document.getElementById('exHeight').value) || this.videoHeight;

        if (limits.format === 'gif') {
            // Rough GIF estimate: ~0.3 bytes per pixel per frame (with LZW + transparency)
            const est = count * w * h * 0.3;
            estSize.textContent = `Est. Size: ~${this.formatBytes(est)}`;
        } else {
            // WebM: ~0.1 bytes per pixel per frame
            const est = count * w * h * 0.1;
            estSize.textContent = `Est. Size: ~${this.formatBytes(est)}`;
        }
    }

    updateVideoInfo() {
        const el = document.getElementById('exInfo');
        if (!this.videoLoaded) {
            el.innerHTML = '<div>No video loaded</div>';
            return;
        }

        el.innerHTML = `
            <div><strong>Resolution:</strong> ${this.videoWidth}×${this.videoHeight}</div>
            <div><strong>Duration:</strong> ${this.duration.toFixed(2)}s</div>
            <div><strong>Frames:</strong> ${this.totalFrames}</div>
            <div><strong>FPS:</strong> ${this.fps}</div>
        `;
    }

    getOutputFrameCount() {
        const start = parseInt(document.getElementById('exStartFrame').value) || 0;
        const end = parseInt(document.getElementById('exEndFrame').value) || 0;
        const skip = Math.max(1, (parseInt(document.getElementById('exFrameSkip').value) || 0) + 1);

        let count = 0;
        for (let f = start; f <= end; f += skip) count++;

        if (this.pingPongMode && count > 2) {
            count = count + (count - 2);
        }

        return count;
    }

    formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }

    // ═══════════════════════════════════════════════════════════════
    //  EXPORT — Main entry point
    // ═══════════════════════════════════════════════════════════════

    async startExport() {
        if (this.isExporting || !this.videoLoaded) return;

        const limits = this.MODE_LIMITS[this.mode];

        if (limits.format === 'webm') {
            return this.startExportWebM();
        } else {
            return this.startExportGIF();
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  WEBM EXPORT
    // ═══════════════════════════════════════════════════════════════

    async startExportWebM() {
        const limits = this.MODE_LIMITS[this.mode];
        const outputFrames = this.getOutputFrameCount();

        if (outputFrames <= 0) {
            window.showToast('No frames to export. Check start/end range.', 'error');
            return;
        }

        const width = Math.min(parseInt(document.getElementById('exWidth').value) || this.videoWidth, limits.maxWidth);
        const height = Math.min(parseInt(document.getElementById('exHeight').value) || this.videoHeight, limits.maxHeight);
        const exportFps = parseInt(document.getElementById('exFPS').value) || this.fps;
        const startFrame = parseInt(document.getElementById('exStartFrame').value) || 0;
        const endFrame = parseInt(document.getElementById('exEndFrame').value) || 0;
        const skip = Math.max(1, (parseInt(document.getElementById('exFrameSkip').value) || 0) + 1);
        const videoScale = this.videoScale || 1;
        const videoOffset = this.videoOffset || 0;

        // Build frame list
        const frameList = [];
        for (let f = startFrame; f <= endFrame; f += skip) frameList.push(f);
        if (this.pingPongMode && frameList.length > 2) {
            for (let i = frameList.length - 2; i >= 1; i--) frameList.push(frameList[i]);
        } else if (this.reverseMode && frameList.length > 1) {
            frameList.reverse();
        }
        const totalFrames = frameList.length;

        this.isExporting = true;
        this._exportCancelled = false;
        document.getElementById('exExportBtn').disabled = true;

        const progressContainer = document.getElementById('exProgress');
        const progressFill = document.getElementById('exProgressFill');
        const progressText = document.getElementById('exProgressText');
        const cancelBtn = document.getElementById('exCancelBtn');
        progressContainer.classList.add('active');
        progressFill.style.width = '0%';
        progressText.textContent = 'Starting WebM export...';
        cancelBtn.style.display = 'inline-flex';

        this.stopPlayback();

        try {
            // Create canvas for frame processing
            const recCanvas = document.createElement('canvas');
            recCanvas.width = width;
            recCanvas.height = height;
            const recCtx = recCanvas.getContext('2d', { willReadFrequently: true });

            // ── Phase 1: Extract all frames with chroma key ──
            progressText.textContent = 'Extracting frames...';
            const frameImages = [];

            const drawScaled = () => {
                recCtx.clearRect(0, 0, width, height);
                const sw = Math.round(width * videoScale);
                const sh = Math.round(height * videoScale);
                const dx = Math.round((width - sw) / 2);
                const dy = Math.round((height - sh) / 2) + videoOffset;
                if (this.cropEnabled) {
                    recCtx.drawImage(this.video, this.cropX, this.cropY, this.cropW, this.cropH, dx, dy, sw, sh);
                } else {
                    recCtx.drawImage(this.video, 0, 0, this.video.videoWidth, this.video.videoHeight, dx, dy, sw, sh);
                }
            };

            for (let fi = 0; fi < totalFrames; fi++) {
                if (this._exportCancelled) break;

                const f = frameList[fi];
                await this.seekToAsync(f / this.fps);

                drawScaled();
                const imageData = recCtx.getImageData(0, 0, width, height);
                this.chromaKey.process(imageData);
                if (this.chromaKey.antiAlias) this.chromaKey.applyAntiAlias(imageData);
                this.chromaKey.applyEdgeFade(imageData, this.chromaKey.edgeFadeWidth);
                frameImages.push(imageData);

                const pct = ((fi + 1) / totalFrames) * 50;
                progressFill.style.width = pct + '%';
                progressText.textContent = `Extracting frame ${fi + 1} / ${totalFrames}...`;
            }

            if (this._exportCancelled) throw new Error('cancelled');

            // ── Phase 2: Record frames at correct frame rate ──
            // Uses a Web Worker timer to avoid browser throttling when tab is unfocused
            progressText.textContent = 'Encoding WebM...';

            const isFirefox = navigator.userAgent.includes('Firefox');

            // Firefox doesn't support track.requestFrame(), so we use
            // captureStream(fps) which auto-captures on canvas changes.
            // Chrome uses captureStream(0) + requestFrame() for precision.
            const stream = recCanvas.captureStream(isFirefox ? exportFps : 0);
            const track = stream.getVideoTracks()[0];

            let mimeType = 'video/webm; codecs=vp9';
            if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm; codecs=vp8';
            if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm';

            const recorder = new MediaRecorder(stream, {
                mimeType,
                videoBitsPerSecond: 8_000_000
            });

            const chunks = [];
            recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
            const recorderDone = new Promise(resolve => { recorder.onstop = resolve; });

            // Draw first processed frame before starting recorder
            if (frameImages.length > 0) {
                recCtx.putImageData(frameImages[0], 0, 0);
            }
            recorder.start();
            const frameDelay = 1000 / exportFps;

            // Worker-based timer (immune to background tab throttling)
            const workerBlob = new Blob([
                `let iv; self.onmessage = e => { if (e.data.cmd === 'start') { iv = setInterval(() => self.postMessage('tick'), e.data.ms); } else { clearInterval(iv); self.close(); } };`
            ], { type: 'application/javascript' });
            const timerWorker = new Worker(URL.createObjectURL(workerBlob));
            let frameIdx = 0;

            await new Promise((resolve) => {
                timerWorker.onmessage = () => {
                    if (this._exportCancelled || frameIdx >= frameImages.length) {
                        timerWorker.postMessage('stop');
                        resolve();
                        return;
                    }

                    // Clear and redraw to trigger Firefox's auto-capture
                    recCtx.clearRect(0, 0, recCanvas.width, recCanvas.height);
                    recCtx.putImageData(frameImages[frameIdx], 0, 0);

                    // Chrome: manually push frame. Firefox: auto-captured by stream.
                    if (track.requestFrame) track.requestFrame();

                    const pct = 50 + ((frameIdx + 1) / frameImages.length) * 50;
                    progressFill.style.width = pct + '%';
                    progressText.textContent = `Encoding frame ${frameIdx + 1} / ${frameImages.length}...`;
                    frameIdx++;
                };
                timerWorker.postMessage({ cmd: 'start', ms: frameDelay });
            });

            recorder.stop();
            await recorderDone;

            if (this._exportCancelled) {
                progressText.textContent = 'Export cancelled.';
                window.showToast('Export cancelled', 'info');
            } else {
                const webmBlob = new Blob(chunks, { type: 'video/webm' });
                this.lastExportBlob = webmBlob;
                this.lastExportFormat = 'webm';

                const sizeStr = this.formatBytes(webmBlob.size);
                progressText.textContent = `Done! ${sizeStr} · ${outputFrames} frames · ${width}×${height}`;
                window.showToast(`WebM exported successfully! (${sizeStr})`, 'success');

                // Auto-download
                this.downloadBlob(webmBlob, 'webm');

                // Play notification sound
                if (window.notificationSound) window.notificationSound.play();
            }

        } catch (err) {
            if (err.message === 'cancelled') {
                progressText.textContent = 'Export cancelled.';
                window.showToast('Export cancelled', 'info');
            } else {
                console.error('WebM export error:', err);
                window.showToast('Export failed: ' + err.message, 'error');
                progressText.textContent = 'Export failed.';
            }
        }

        cancelBtn.style.display = 'none';
        this.isExporting = false;
        this._exportCancelled = false;
        document.getElementById('exExportBtn').disabled = false;
    }

    // ═══════════════════════════════════════════════════════════════
    //  GIF EXPORT (with Web Worker encoding)
    // ═══════════════════════════════════════════════════════════════

    async startExportGIF() {
        const limits = this.MODE_LIMITS[this.mode];
        const outputFrames = this.getOutputFrameCount();

        if (outputFrames > limits.maxFrames) {
            window.showToast(`Frame count (${outputFrames}) exceeds ${this.mode} limit (${limits.maxFrames})`, 'error');
            return;
        }
        if (outputFrames <= 0) {
            window.showToast('No frames to export. Check start/end range.', 'error');
            return;
        }

        const width = Math.min(parseInt(document.getElementById('exWidth').value) || this.videoWidth, limits.maxWidth);
        const height = Math.min(parseInt(document.getElementById('exHeight').value) || this.videoHeight, limits.maxHeight);
        const maxColors = 128;
        const exportFps = parseInt(document.getElementById('exFPS').value) || this.fps;
        const delayCentiseconds = Math.max(2, Math.round(100 / exportFps));
        const startFrame = parseInt(document.getElementById('exStartFrame').value) || 0;
        const endFrame = parseInt(document.getElementById('exEndFrame').value) || 0;
        const skip = Math.max(1, (parseInt(document.getElementById('exFrameSkip').value) || 0) + 1);
        const videoScale = this.videoScale || 1;
        const videoOffset = this.videoOffset || 0;

        // Build frame list
        const frameList = [];
        for (let f = startFrame; f <= endFrame; f += skip) frameList.push(f);
        if (this.pingPongMode && frameList.length > 2) {
            for (let i = frameList.length - 2; i >= 1; i--) frameList.push(frameList[i]);
        } else if (this.reverseMode && frameList.length > 1) {
            frameList.reverse();
        }
        const totalFrames = frameList.length;

        this.isExporting = true;
        this._exportCancelled = false;
        document.getElementById('exExportBtn').disabled = true;

        const progressContainer = document.getElementById('exProgress');
        const progressFill = document.getElementById('exProgressFill');
        const progressText = document.getElementById('exProgressText');
        const cancelBtn = document.getElementById('exCancelBtn');
        progressContainer.classList.add('active');
        progressFill.style.width = '0%';
        progressText.textContent = 'Starting GIF export...';
        cancelBtn.style.display = 'inline-flex';

        this.stopPlayback();

        try {
            // Create output canvas at export dimensions
            const outCanvas = document.createElement('canvas');
            outCanvas.width = width;
            outCanvas.height = height;
            const outCtx = outCanvas.getContext('2d', { willReadFrequently: true });

            const drawVideoScaled = (ctx, w, h) => {
                ctx.clearRect(0, 0, w, h);
                const sw = Math.round(w * videoScale);
                const sh = Math.round(h * videoScale);
                const dx = Math.round((w - sw) / 2);
                const dy = Math.round((h - sh) / 2) + videoOffset;
                if (this.cropEnabled) {
                    ctx.drawImage(this.video, this.cropX, this.cropY, this.cropW, this.cropH, dx, dy, sw, sh);
                } else {
                    ctx.drawImage(this.video, 0, 0, this.video.videoWidth, this.video.videoHeight, dx, dy, sw, sh);
                }
            };

            // ── Phase 1: Build global palette from sampled frames ──
            progressText.textContent = 'Building palette...';
            const sampleCount = Math.min(6, totalFrames);
            const sampleStep = Math.max(1, Math.floor(totalFrames / sampleCount));
            const sampledPixels = [];
            let paletteSourceData = null;

            for (let si = 0; si < totalFrames; si += sampleStep) {
                const f = frameList[si];
                await this.seekToAsync(f / this.fps);
                drawVideoScaled(outCtx, width, height);
                const sd = outCtx.getImageData(0, 0, width, height);
                this.chromaKey.process(sd);
                for (let pi = 0; pi < sd.data.length; pi += 4) {
                    if (sd.data[pi + 3] >= 128) sampledPixels.push(pi / 4);
                }
                if (si === 0) { paletteSourceData = sd.data; }
            }

            const paletteSlots = Math.max(2, maxColors - 1);
            const allSampledColors = sampledPixels.length > 0 ? sampledPixels : [0];
            const globalPalette = ColorQuantizer.medianCut(
                paletteSourceData || new Uint8Array(4), allSampledColors, paletteSlots);
            const transparentIndex = globalPalette.length;
            globalPalette.push([0, 0, 0]);

            // ── Phase 2: Extract & process all UNIQUE frames ──
            progressText.textContent = 'Extracting frames...';

            const uniqueFrames = [];
            for (let f = startFrame; f <= endFrame; f += skip) uniqueFrames.push(f);

            const frameCache = new Map();
            const cache = new Map();

            for (let ui = 0; ui < uniqueFrames.length; ui++) {
                if (this._exportCancelled) break;

                const f = uniqueFrames[ui];
                await this.seekToAsync(f / this.fps);

                drawVideoScaled(outCtx, width, height);
                const imageData = outCtx.getImageData(0, 0, width, height);
                this.chromaKey.process(imageData);
                if (this.chromaKey.antiAlias) this.chromaKey.applyAntiAlias(imageData);
                this.chromaKey.applyEdgeFade(imageData, this.chromaKey.edgeFadeWidth);

                const rgba = imageData.data;
                const numPx = width * height;
                const indexed = new Uint8Array(numPx);
                let minX = width, minY = height, maxX = -1, maxY = -1;

                for (let i = 0; i < numPx; i++) {
                    const a = rgba[i * 4 + 3];
                    if (a < 128) {
                        indexed[i] = transparentIndex;
                    } else {
                        const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
                        const key = (r << 16) | (g << 8) | b;
                        let idx = cache.get(key);
                        if (idx === undefined) {
                            idx = ColorQuantizer.nearestPaletteIndex(globalPalette, r, g, b, transparentIndex);
                            cache.set(key, idx);
                        }
                        indexed[i] = idx;
                        const x = i % width, y = (i - x) / width;
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }

                frameCache.set(f, { indexed, minX, minY, maxX, maxY });

                const pct = ((ui + 1) / uniqueFrames.length) * 50;
                progressFill.style.width = pct + '%';
                progressText.textContent = `Extracting frame ${ui + 1} / ${uniqueFrames.length}...`;

                if ((ui + 1) % 8 === 0) await new Promise(r => setTimeout(r, 0));
            }

            if (this._exportCancelled) {
                progressText.textContent = 'Export cancelled.';
                window.showToast('Export cancelled', 'info');
                cancelBtn.style.display = 'none';
                this.isExporting = false;
                document.getElementById('exExportBtn').disabled = false;
                return;
            }

            // ── Phase 3: Encode GIF in Web Worker ──
            progressText.textContent = 'Encoding GIF...';

            const workerFrames = [];
            for (let fi = 0; fi < totalFrames; fi++) {
                const f = frameList[fi];
                const frame = frameCache.get(f);
                workerFrames.push({
                    indexed: frame.indexed,
                    minX: frame.minX, minY: frame.minY,
                    maxX: frame.maxX, maxY: frame.maxY
                });
            }

            const gifData = await new Promise((resolve, reject) => {
                // Create inline Web Worker with GIF encoder
                const workerCode = `
                    'use strict';
                    // ── Minimal GIF Encoder for Worker ──
                    class WGif {
                        constructor(w, h) {
                            this.w = w; this.h = h;
                            this.sz = 256 * 1024;
                            this.buf = new Uint8Array(this.sz);
                            this.pos = 0;
                        }
                        _grow(n) {
                            while (this.pos + n > this.sz) this.sz *= 2;
                            const nb = new Uint8Array(this.sz);
                            nb.set(this.buf);
                            this.buf = nb;
                        }
                        wb(v) { if (this.pos >= this.sz) this._grow(1024); this.buf[this.pos++] = v & 0xFF; }
                        ws(v) { this.wb(v & 0xFF); this.wb((v >> 8) & 0xFF); }
                        wstr(s) { for (let i = 0; i < s.length; i++) this.wb(s.charCodeAt(i)); }

                        writeHeader() {
                            this.wstr('GIF89a');
                            this.ws(this.w); this.ws(this.h);
                            this.wb(0x70); this.wb(0); this.wb(0);
                            // Netscape loop
                            this.wb(0x21); this.wb(0xFF); this.wb(0x0B);
                            this.wstr('NETSCAPE2.0');
                            this.wb(0x03); this.wb(0x01); this.ws(0); this.wb(0x00);
                        }

                        writeGCE(delay, tidx) {
                            this.wb(0x21); this.wb(0xF9); this.wb(0x04);
                            this.wb(((2 & 0x07) << 2) | 0x01);
                            this.ws(delay); this.wb(tidx); this.wb(0x00);
                        }

                        writeImgDesc(lctSz, left, top, w, h) {
                            this.wb(0x2C);
                            this.ws(left); this.ws(top); this.ws(w); this.ws(h);
                            this.wb(0x80 | (lctSz & 0x07));
                        }

                        writePalette(pal, tsz) {
                            for (let i = 0; i < tsz; i++) {
                                if (i < pal.length) { this.wb(pal[i][0]); this.wb(pal[i][1]); this.wb(pal[i][2]); }
                                else { this.wb(0); this.wb(0); this.wb(0); }
                            }
                        }

                        writeLZW(pixels, minCS) {
                            this.wb(minCS);
                            const cc = 1 << minCS, eoi = cc + 1, maxCV = 4096;
                            let cs = minCS + 1, nc = eoi + 1;
                            const HSZ = 8192;
                            const hk = new Int32Array(HSZ).fill(-1);
                            const hv = new Int32Array(HSZ);
                            const sbd = [];
                            let cb = 0, cbit = 0;
                            const emit = (code) => {
                                cb |= (code << cbit); cbit += cs;
                                while (cbit >= 8) { sbd.push(cb & 0xFF); cb >>>= 8; cbit -= 8; }
                            };
                            const reset = () => { hk.fill(-1); cs = minCS + 1; nc = eoi + 1; };
                            emit(cc); reset();
                            if (pixels.length === 0) { emit(eoi); }
                            else {
                                let w = pixels[0];
                                for (let i = 1; i < pixels.length; i++) {
                                    const k = pixels[i];
                                    const key = w * (cc + 2) + k;
                                    let slot = (key * 2654435761 >>> 0) & (HSZ - 1);
                                    let found = false;
                                    while (hk[slot] !== -1) {
                                        if (hk[slot] === key) { w = hv[slot]; found = true; break; }
                                        slot = (slot + 1) & (HSZ - 1);
                                    }
                                    if (!found) {
                                        emit(w);
                                        if (nc < maxCV) {
                                            hk[slot] = key; hv[slot] = nc;
                                            if (nc >= (1 << cs) && cs < 12) cs++;
                                            nc++;
                                        } else { emit(cc); reset(); }
                                        w = k;
                                    }
                                }
                                emit(w); emit(eoi);
                            }
                            if (cbit > 0) sbd.push(cb & 0xFF);
                            this._grow(sbd.length + Math.ceil(sbd.length / 255) + 2);
                            let p = 0;
                            while (p < sbd.length) {
                                const csz = Math.min(255, sbd.length - p);
                                this.buf[this.pos++] = csz;
                                for (let j = 0; j < csz; j++) this.buf[this.pos++] = sbd[p++];
                            }
                            this.buf[this.pos++] = 0x00;
                        }

                        finish() { this.wb(0x3B); return this.buf.slice(0, this.pos); }
                    }

                    self.onmessage = function(e) {
                        const { frames, palette, transparentIndex, delay, width, height, totalFrames } = e.data;

                        const gif = new WGif(width, height);
                        gif.writeHeader();

                        const minCS = Math.max(2, Math.ceil(Math.log2(palette.length)));
                        const tsz = 1 << minCS;
                        const lctSz = minCS - 1;
                        const ppal = [...palette];
                        while (ppal.length < tsz) ppal.push([0, 0, 0]);

                        for (let fi = 0; fi < totalFrames; fi++) {
                            const fr = frames[fi];
                            const indexed = new Uint8Array(fr.indexed);

                            gif.writeGCE(delay, transparentIndex);

                            if (fr.maxX < 0) {
                                gif.writeImgDesc(lctSz, 0, 0, 1, 1);
                                gif.writePalette(ppal, tsz);
                                gif.writeLZW(new Uint8Array([transparentIndex]), minCS);
                            } else {
                                const bw = fr.maxX - fr.minX + 1;
                                const bh = fr.maxY - fr.minY + 1;
                                const sub = new Uint8Array(bw * bh);
                                for (let y = 0; y < bh; y++) {
                                    for (let x = 0; x < bw; x++) {
                                        sub[y * bw + x] = indexed[(fr.minY + y) * width + (fr.minX + x)];
                                    }
                                }
                                gif.writeImgDesc(lctSz, fr.minX, fr.minY, bw, bh);
                                gif.writePalette(ppal, tsz);
                                gif.writeLZW(sub, minCS);
                            }

                            if ((fi + 1) % 10 === 0 || fi === totalFrames - 1) {
                                self.postMessage({ type: 'progress', frame: fi + 1, total: totalFrames });
                            }
                        }

                        const result = gif.finish();
                        self.postMessage({ type: 'done', data: result.buffer }, [result.buffer]);
                    };
                `;

                const blob = new Blob([workerCode], { type: 'application/javascript' });
                const workerUrl = URL.createObjectURL(blob);
                const worker = new Worker(workerUrl);

                worker.onmessage = (e) => {
                    if (e.data.type === 'progress') {
                        const pct = 50 + (e.data.frame / e.data.total) * 50;
                        progressFill.style.width = pct + '%';
                        progressText.textContent = `Encoding frame ${e.data.frame} / ${e.data.total}...`;
                    } else if (e.data.type === 'done') {
                        URL.revokeObjectURL(workerUrl);
                        worker.terminate();
                        resolve(new Uint8Array(e.data.data));
                    }
                };

                worker.onerror = (err) => {
                    URL.revokeObjectURL(workerUrl);
                    worker.terminate();
                    reject(new Error('Worker encoding failed: ' + err.message));
                };

                // Serialize frames for transfer
                const serFrames = workerFrames.map(f => ({
                    indexed: new Uint8Array(f.indexed),
                    minX: f.minX, minY: f.minY,
                    maxX: f.maxX, maxY: f.maxY
                }));

                worker.postMessage({
                    frames: serFrames,
                    palette: globalPalette,
                    transparentIndex,
                    delay: delayCentiseconds,
                    width, height,
                    totalFrames
                });
            });

            this.lastExportBlob = new Blob([gifData], { type: 'image/gif' });
            this.lastExportFormat = 'gif';

            const sizeStr = this.formatBytes(gifData.length);
            progressText.textContent = `Done! ${sizeStr} · ${outputFrames} frames · ${width}×${height}`;
            window.showToast(`GIF exported successfully! (${sizeStr})`, 'success');

            // Auto-download
            this.downloadBlob(this.lastExportBlob, 'gif');

            // Play notification sound
            if (window.notificationSound) window.notificationSound.play();

        } catch (err) {
            if (err.message === 'cancelled') {
                progressText.textContent = 'Export cancelled.';
                window.showToast('Export cancelled', 'info');
            } else {
                console.error('GIF export error:', err);
                window.showToast('Export failed: ' + err.message, 'error');
                progressText.textContent = 'Export failed.';
            }
        }

        cancelBtn.style.display = 'none';
        this.isExporting = false;
        this._exportCancelled = false;
        document.getElementById('exExportBtn').disabled = false;
    }

    // ─── DOWNLOAD ───
    downloadBlob(blob, ext) {
        const filenameInput = document.getElementById('exFilename');
        let name = filenameInput.value.trim() || 'output';
        // Remove any existing extension
        name = name.replace(/\.(webm|gif|mp4)$/i, '');

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name}.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    // ─── SEEK HELPER ───
    seekToAsync(time) {
        return new Promise((resolve) => {
            const targetTime = Math.min(Math.max(0, time), this.duration - 0.001);

            if (Math.abs(this.video.currentTime - targetTime) < 0.001) {
                resolve();
                return;
            }

            const timeout = setTimeout(() => {
                resolve();
            }, 2000);

            this.video.addEventListener('seeked', () => {
                clearTimeout(timeout);
                resolve();
            }, { once: true });

            this.video.currentTime = targetTime;
        });
    }
}


// ═══════════════════════════════════════════════════════════════════
//  INITIALIZE
// ═══════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    window.modelExporter = new ModelExporter();
    console.log('📦 Model Exporter initialized');
});
