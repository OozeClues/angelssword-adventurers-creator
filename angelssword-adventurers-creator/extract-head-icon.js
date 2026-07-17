const sharp = require('sharp');

const inputPath = process.argv[2];
const outputPath = process.argv[3] || 'icon-head.png';

async function main() {
    const meta = await sharp(inputPath).metadata();
    const cols = 6, rows = 7;
    const cellW = Math.floor(meta.width / cols);
    const cellH = Math.floor(meta.height / rows);
    console.log(`  Sheet: ${meta.width}x${meta.height}, cell: ${cellW}x${cellH}`);

    // Row 5, col 0 — standing idle (smaller, more upright)
    const useRow = 5, useCol = 0;
    const cell = await sharp(inputPath)
        .extract({ left: useCol * cellW, top: useRow * cellH, width: cellW, height: cellH })
        .png().toBuffer();

    const { data, info } = await sharp(cell).raw().toBuffer({ resolveWithObject: true });
    
    // Find top of sprite (first opaque row)
    let topY = -1;
    outer: for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
            if (data[(y * info.width + x) * 4 + 3] > 10) { topY = y; break outer; }
        }
    }
    
    // Find bottom of sprite
    let botY = 0;
    for (let y = info.height - 1; y >= 0; y--) {
        for (let x = 0; x < info.width; x++) {
            if (data[(y * info.width + x) * 4 + 3] > 10) { botY = y; break; }
        }
        if (botY > 0) break;
    }
    
    const spriteH = botY - topY + 1;
    // Head = top 30% (just the head, ahoge, and hair)
    const headCutoff = topY + Math.round(spriteH * 0.30);
    
    // Find X bounds within head zone only
    let minX = info.width, maxX = 0;
    for (let y = topY; y <= headCutoff; y++) {
        for (let x = 0; x < info.width; x++) {
            if (data[(y * info.width + x) * 4 + 3] > 10) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
            }
        }
    }
    
    console.log(`  Sprite: y=${topY}-${botY} (${spriteH}px), head cutoff: y=${headCutoff}`);
    console.log(`  Head X: ${minX}-${maxX}`);
    
    const region = {
        left: Math.max(0, minX - 1),
        top: Math.max(0, topY),
        width: Math.min(maxX - minX + 3, cellW - Math.max(0, minX - 1)),
        height: headCutoff - topY + 2
    };

    const headBuf = await sharp(cell).extract(region).png().toBuffer();
    const hMeta = await sharp(headBuf).metadata();
    const sq = Math.max(hMeta.width, hMeta.height) + 2;

    await sharp(headBuf)
        .resize(sq, sq, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .resize(256, 256, { kernel: 'nearest', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toFile(outputPath);

    console.log(`  ✅ ${outputPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
