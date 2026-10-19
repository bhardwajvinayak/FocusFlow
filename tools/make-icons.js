// tools/make-icons.js
// Dev-only helper: generates placeholder PNG icons without any dependencies.
// Usage (from the project root):  node tools/make-icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 32, 48, 128];
const OUTPUT_DIR = path.join(__dirname, '..', 'assets', 'icons');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    let c = (crc ^ buffer[i]) & 0xff;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function insideRoundedSquare(x, y, size, radius) {
  const dx = Math.max(radius - (x + 0.5), 0, x + 0.5 - (size - radius));
  const dy = Math.max(radius - (y + 0.5), 0, y + 0.5 - (size - radius));
  return dx * dx + dy * dy <= radius * radius;
}

function makeIcon(size) {
  const rowLength = size * 4 + 1; // 1 filter byte + RGBA pixels
  const raw = Buffer.alloc(rowLength * size);
  const center = (size - 1) / 2;
  const dotRadius = size * 0.28;
  const cornerRadius = size * 0.22;

  for (let y = 0; y < size; y++) {
    const rowStart = y * rowLength;
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const i = rowStart + 1 + x * 4;
      if (!insideRoundedSquare(x, y, size, cornerRadius)) {
        raw[i] = raw[i + 1] = raw[i + 2] = raw[i + 3] = 0; // transparent corner
        continue;
      }
      const isDot = Math.hypot(x - center, y - center) <= dotRadius;
      const [r, g, b] = isDot ? [255, 255, 255] : [79, 70, 229];
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = 255;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
for (const size of SIZES) {
  const filePath = path.join(OUTPUT_DIR, `icon${size}.png`);
  fs.writeFileSync(filePath, makeIcon(size));
  console.log(`Created ${filePath}`);
}