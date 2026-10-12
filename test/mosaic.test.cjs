// Tests du détecteur/inverseur de mosaïque (fns extraites de app.worker.ts).
// Usage : node test/mosaic.test.cjs  (ou via npm test)
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const assert = require('node:assert');

// Compile les fns pures (luminance, mosaicBlockSize, mosaicUndo) hors du worker.
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src', 'app', 'app.worker.ts'), 'utf8');
const start = src.indexOf('function luminance(');
const end = src.indexOf('/**\n * SR — Real-ESRGAN');
const fnSrc = src.slice(start, end).replace(/(^|\n)(function )/g, '$1export $2');
fs.writeFileSync('/tmp/fns.ts', fnSrc + '\n');
execSync(`npx --prefix "${root}" esbuild /tmp/fns.ts --bundle --format=cjs --platform=node --outfile=/tmp/fns.cjs --log-level=warning`);
const { luminance, mosaicBlockSize, mosaicUndo } = require('/tmp/fns.cjs');

globalThis.ImageData = class {
  constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); }
};

// 1. Grille synthétique 16px (blocs à luminances variées, tous contrastés)
{
  const w = 320, h = 320, B = 16;
  const grid = new ImageData(w, h);
  for (let by = 0; by < h; by += B) for (let bx = 0; bx < w; bx += B) {
    const v = (30 + (((bx * 7 + by * 13) % 17) * 10)) | 0;
    for (let y = by; y < by + B && y < h; y++) for (let x = bx; x < bx + B && x < w; x++) {
      const i = (y * w + x) * 4;
      grid.data[i] = v; grid.data[i + 1] = v; grid.data[i + 2] = v; grid.data[i + 3] = 255;
    }
  }
  const size = mosaicBlockSize(luminance(grid.data, w, h), w, h);
  assert.strictEqual(size, B, `mosaicBlockSize doit détecter B=${B} (got ${size})`);

  const undone = mosaicUndo(grid);
  assert.strictEqual(undone.data[0], 30, 'bloc (0,0) = 30');
  assert.strictEqual(undone.data[4 * w + 4], undone.data[0], 'pixels du même bloc uniformes');
  assert.notStrictEqual(undone.data[(B + 1) * 4], undone.data[0], 'blocs adjacents distincts');
  console.log('1. grille 16px détectée + inversée ✓');
}

// 2. Grille 32px
{
  const S = 512, G = 32;
  const g = new ImageData(S, S);
  for (let y = 0; y < S; y += G) for (let x = 0; x < S; x += G) {
    const v = (20 + ((x * 3 + y * 5) % 23) * 8) | 0;
    for (let yy = y; yy < y + G; yy++) for (let xx = x; xx < x + G; xx++) {
      const i = (yy * S + xx) * 4;
      g.data[i] = v; g.data[i + 1] = v; g.data[i + 2] = v; g.data[i + 3] = 255;
    }
  }
  assert.strictEqual(mosaicBlockSize(luminance(g.data, S, S), S, S), G, 'grille 32px');
  console.log('2. grille 32px détectée ✓');
}

// 3. Dégradé lisse (aucune grille) → 0 (pas d'anti-mosaïque)
{
  const S = 512;
  const g = new ImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const v = (x / S * 200 + 20) | 0; // dégradé continu : delta entre pixels < seuil
    g.data[i] = v; g.data[i + 1] = v; g.data[i + 2] = v; g.data[i + 3] = 255;
  }
  assert.strictEqual(mosaicBlockSize(luminance(g.data, S, S), S, S), 0, 'dégradé ≠ mosaïque');
  console.log('3. dégradé lisse non détecté ✓ (zéro dégradé sur photos normales)');
}

// 4. forceMosaic=true applique l'undo même sans grille détectée
{
  const S = 256;
  const g = new ImageData(S, S);
  for (let i = 0; i < S * S; i++) { const j = i * 4; g.data[j] = 100; g.data[j+1] = 100; g.data[j+2] = 100; g.data[j+3] = 255; }
  const undone = mosaicUndo(g, true);
  assert.strictEqual(undone.data[0], 100, 'forceMosaic sur image unie = inchangée');
  console.log('4. forceMosaic sûr sur image unie ✓');
}

console.log('✔ tests mosaïque OK');
