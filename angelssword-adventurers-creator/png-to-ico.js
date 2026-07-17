/**
 * Convert a PNG to a multi-size .ico file.
 * Creates 16x16, 32x32, 48x48, and 256x256 entries.
 * Usage: node png-to-ico.js input.png output.ico
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
  console.error('Usage: node png-to-ico.js <input.png> <output.ico>');
  process.exit(1);
}

async function main() {
  const sizes = [16, 32, 48, 256];
  const pngBuffers = [];

  for (const size of sizes) {
    const buf = await sharp(inputPath)
      .resize(size, size, { 
        kernel: size <= 48 ? 'nearest' : 'lanczos3',
        fit: 'contain', 
        background: { r: 0, g: 0, b: 0, alpha: 0 } 
      })
      .png()
      .toBuffer();
    pngBuffers.push(buf);
  }

  // ICO Header: 6 bytes
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);           // Reserved
  header.writeUInt16LE(1, 2);           // Type: 1 = ICO
  header.writeUInt16LE(sizes.length, 4); // Image count

  // Directory entries: 16 bytes each
  const dirSize = 16 * sizes.length;
  let dataOffset = 6 + dirSize;
  const entries = [];

  for (let i = 0; i < sizes.length; i++) {
    const entry = Buffer.alloc(16);
    const s = sizes[i] >= 256 ? 0 : sizes[i]; // 0 = 256
    entry.writeUInt8(s, 0);                     // Width
    entry.writeUInt8(s, 1);                     // Height
    entry.writeUInt8(0, 2);                     // Color palette
    entry.writeUInt8(0, 3);                     // Reserved
    entry.writeUInt16LE(1, 4);                  // Color planes
    entry.writeUInt16LE(32, 6);                 // Bits per pixel
    entry.writeUInt32LE(pngBuffers[i].length, 8);  // Image data size
    entry.writeUInt32LE(dataOffset, 12);            // Offset to image data
    entries.push(entry);
    dataOffset += pngBuffers[i].length;
  }

  const ico = Buffer.concat([header, ...entries, ...pngBuffers]);
  fs.writeFileSync(outputPath, ico);

  console.log(`  ✅ Created ${path.basename(outputPath)} (${sizes.join(', ')}px, ${ico.length} bytes)`);
}

main().catch(e => { console.error(e); process.exit(1); });
