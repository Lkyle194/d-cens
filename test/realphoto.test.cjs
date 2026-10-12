// Test le détecteur de mosaïque sur la VRAIE photo de l'utilisateur.
// Compile luminance+mosaicBlockSize (extraites du worker) avec esbuild, puis les évalue.
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'app.worker.ts'), 'utf8');
const start = src.indexOf('function luminance(');
const end = src.indexOf('/** Inverse la mosaïque');
const fnSrc = src.slice(start, end);
fs.writeFileSync('/tmp/fns.ts', fnSrc.replace(/(^|\n)(function )/g, '$1export $2') + '\n');
execSync('npx esbuild /tmp/fns.ts --bundle --format=cjs --platform=node --outfile=/tmp/fns.cjs --log-level=warning');
const { luminance, mosaicBlockSize } = require('/tmp/fns.cjs');

globalThis.ImageData = class {
  constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); }
};

// file.raw = RGBA brut ; header : w (4 octets BE) + h (4 octets BE) + données
function photoToImageData(file) {
  const buf = fs.readFileSync(file);
  const w = buf.readUInt32BE(0);
  const h = buf.readUInt32BE(4);
  const id = new ImageData(w, h);
  const u8 = new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length);
  id.data.set(u8.subarray(8, w * h * 4));
  return id;
}
function pngToRaw(pngFile, rawFile) {
  execSync(`python3 -c "
from PIL import Image
im = Image.open('${pngFile}').convert('RGBA')
import struct
open('${rawFile}', 'wb').write(struct.pack('>II', im.width, im.height) + im.tobytes())
"`);
}

// 1. La vraie photo (downscalée long-edge 1200 comme l'UI)
execSync('python3 -c "from PIL import Image; im=Image.open(\'/tmp/photo_only.png\').convert(\'RGB\'); w,h=im.size; k=min(1,1200/max(w,h)); im2=im.resize((max(8,int(w*k)),max(8,int(h*k))),Image.BILINEAR); im2.convert(\'RGBA\').save(\'/tmp/photo_rgba.png\')"');
pngToRaw('/tmp/photo_rgba.png', '/tmp/photo_rgba.raw');
const id = photoToImageData('/tmp/photo_rgba.raw');
console.log('photo dims:', id.width, id.height);
const B = mosaicBlockSize(luminance(id.data, id.width, id.height), id.width, id.height);
console.log('→ vraie photo mosaïquée : bloc =', B, B ? `px (anti-mosaïque s'appliquera)` : '(non détectée — ok si photo lisse)');

// 2. Contrôle : image lissée (blur gaussien) sans mosaïque → ne doit PAS être détectée
execSync('python3 -c "from PIL import Image, ImageFilter; im=Image.open(\'/tmp/photo_only.png\').convert(\'RGB\').filter(ImageFilter.GaussianBlur(6)); w,h=im.size; k=min(1,1200/max(w,h)); im2=im.resize((max(8,int(w*k)),max(8,int(h*k))),Image.BILINEAR); im2.convert(\'RGBA\').save(\'/tmp/photo_smooth.png\')"');
pngToRaw('/tmp/photo_smooth.png', '/tmp/photo_smooth.raw');
const id2 = photoToImageData('/tmp/photo_smooth.raw');
const B2 = mosaicBlockSize(luminance(id2.data, id2.width, id2.height), id2.width, id2.height);
console.log('→ photo lissée (sans mosaïque) : bloc =', B2, B2 ? 'px (!! FAUX POSITIF — à durcir)' : '(non détectée ✓)');

// 3. Contrôle : grille synthétique 32px → doit être détectée
const S = 512, G = 32;
const g = new ImageData(S, S);
for (let y = 0; y < S; y += G) for (let x = 0; x < S; x += G) {
  const r = 40 + (x * 7) % 150, gg = 40 + (y * 13) % 150, b = 40 + ((x + y) * 5) % 100;
  for (let yy = y; yy < y + G && yy < S; yy++) for (let xx = x; xx < x + G && xx < S; xx++) {
    const i = (yy * S + xx) * 4;
    g.data[i] = r; g.data[i + 1] = gg; g.data[i + 2] = b; g.data[i + 3] = 255;
  }
}
const B3 = mosaicBlockSize(luminance(g.data, S, S), S, S);
console.log('→ grille synthétique 32px : bloc =', B3, B3 === G ? '✓' : '(! attendu 32)');
