#!/usr/bin/env node
/**
 * Copie le runtime WebGPU d'onnxruntime-web (node_modules) dans public/ort/
 * pour que les binaires .wasm/.mjs/.js servés par le bundler restent
 * identiques à ce que le worker attend (voir src/app/app.worker.ts).
 *
 * Les fichiers sont .gitignore (public/ort) : ils sont reconstruits à
 * chaque `npm install` — donc aussi sur les builds Vercel.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
// onnxruntime-web 1.30 : les fichiers .wasm/.mjs sont à la racine de dist/.
const src = path.join(root, 'node_modules', 'onnxruntime-web', 'dist');
const dst = path.join(root, 'public', 'ort');

// Runtime threadé SIMD — c'est ce que le worker charge (env.wasm.wasmPath = '/ort/').
const files = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  // Variantes fallback (certaines build ORT référencent un .mjs pair).
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
];

fs.mkdirSync(dst, { recursive: true });

let copied = 0;
for (const name of files) {
  const from = path.join(src, name);
  if (!fs.existsSync(from)) continue;
  fs.copyFileSync(from, path.join(dst, name));
  copied++;
}

console.log(`[postinstall-ort] ${copied} fichier(s) copié(s) dans public/ort/`);
