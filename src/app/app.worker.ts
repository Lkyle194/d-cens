/**
 * D-Cens — Worker d'inférence (Étapes 2 & 3).
 *
 * Isole onnxruntime-web du thread UI. Protocol :
 *  main -> worker : { type:'run', mode, data, w, h, targetW, targetH, modelBytes }
 *  worker -> main : { type:'ready' } | { type:'progress', p, label, provider } |
 *                    { type:'result', data, w, h, provider, faces? } | { type:'error', message }
 *
 * Les poids sont chargés + mis en cache IndexedDB par le thread principal (Étape 4)
 * puis transmis au worker ; le worker est réentrant (un run à la fois).
 */
/// <reference lib="webworker" />

// Import statique : esbuild intègre le runtime ort.all (wasm embarqué en base64)
// directement dans le bundle du worker. `import.meta.url` -> le .mjs du worker,
// et `wasmPath = import.meta.url + 'ort/'` pointe vers les assets /ort/ (COEP ok).
import * as ortLib from 'onnxruntime-web/all';

declare const self: DedicatedWorkerGlobalScope;

type ModelId = 'super-resolution' | 'face-restore' | 'demosaic';
type RunMode = 'sr' | 'face' | 'demosaic';

interface RunMsg {
  type: 'run';
  model: ModelId;
  mode: RunMode;
  /** ImageData RGBA de l'image source (long edge bornée côté UI). */
  data: ArrayBuffer;
  w: number;
  h: number;
  targetW: number;
  targetH: number;
  /** Forcer l'anti-mosaïque même si le détecteur de grille ne la voit pas. */
  forceMosaic?: boolean;
  /** Poids bruts déjà chargés/cachés par le thread principal. */
  modelBytes: { key: string; bytes: ArrayBuffer }[];
}

const post = (m: object) => self.postMessage(m);
const log = (s: string) => post({ type: 'log', message: s });

const ort = (ortLib as any).default ?? ortLib;
ort.env.wasm.numThreads = 1;
// Garde-fou : runtime wasm sous /ort/ (assets) au cas où l'embed base64 échouerait.
// Chemin absolu : les assets /ort/ sont servis à la racine du site (prod + dev).
ort.env.wasm.wasmPath = '/ort/';

async function getOrt(): Promise<any> {
  return ort;
}

let provider: string | null = null;
async function pickProvider(): Promise<string> {
  if (provider) return provider;
  if (typeof navigator !== 'undefined' && (navigator as any).gpu) {
    try {
      const adapter = await (navigator as any).gpu.requestAdapter();
      if (adapter) {
        provider = 'webgpu';
        return provider;
      }
    } catch {
      /* WebGL */
    }
  }
  provider = 'webgl';
  return provider;
}

const sessions = new Map<string, any>();

async function getSession(key: string, ep: string): Promise<any> {
  const cacheKey = key + '#' + ep;
  if (sessions.has(cacheKey)) return sessions.get(cacheKey);
  const lib = await getOrt();
  const bytes = findBytes(key);
  const t0 = performance.now();
  const session = await lib.InferenceSession.create(new Uint8Array(bytes), {
    executionProviders: [ep],
    graphOptimizationLevel: 'all',
  });
  log(`session "${key}" prête (${((performance.now() - t0) / 1000) | 0}s) via ${ep}`);
  sessions.set(cacheKey, session);
  return session;
}

let LAST_BYTES: { key: string; bytes: ArrayBuffer }[] = [];
function findBytes(key: string): ArrayBuffer {
  const hit = LAST_BYTES.find((b) => b.key === key);
  if (!hit) throw new Error('Poids introuvable : ' + key);
  return hit.bytes;
}

/** RGBA -> NCHW Float32 [0,1]. */
function rgbaToTensorNchw(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Float32Array {
  const out = new Float32Array(3 * h * w);
  const c0 = 0 * h * w;
  const c1 = 1 * h * w;
  const c2 = 2 * h * w;
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    out[c0 + i] = rgba[j] / 255;
    out[c1 + i] = rgba[j + 1] / 255;
    out[c2 + i] = rgba[j + 2] / 255;
  }
  return out;
}

/** NCHW Float32 [0,1] -> ImageData RGBA. */
function nchwToImageData(t: Float32Array, w: number, h: number): ImageData {
  const img = new ImageData(w, h);
  const d = img.data;
  const c0 = 0 * w * h;
  const c1 = 1 * w * h;
  const c2 = 2 * w * h;
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    d[j] = Math.max(0, Math.min(255, Math.round(t[c0 + i] * 255)));
    d[j + 1] = Math.max(0, Math.min(255, Math.round(t[c1 + i] * 255)));
    d[j + 2] = Math.max(0, Math.min(255, Math.round(t[c2 + i] * 255)));
    d[j + 3] = 255;
  }
  return img;
}

function newCanvas(w: number, h: number): OffscreenCanvas {
  return new OffscreenCanvas(Math.max(1, w | 0), Math.max(1, h | 0));
}

let srcCanvasCache: { id: ImageData; canvas: OffscreenCanvas } | null = null;
function srcCanvasOf(src: ImageData): OffscreenCanvas {
  if (!srcCanvasCache || srcCanvasCache.id !== src) {
    const c = newCanvas(src.width, src.height);
    c.getContext('2d')!.putImageData(src, 0, 0);
    srcCanvasCache = { id: src, canvas: c };
  }
  return srcCanvasCache.canvas;
}

function downscaleTo(img: ImageData, w: number, h: number): ImageData {
  const c = newCanvas(img.width, img.height);
  c.getContext('2d')!.putImageData(img, 0, 0);
  const t = newCanvas(w, h);
  const tc = t.getContext('2d')!;
  tc.imageSmoothingEnabled = true;
  tc.imageSmoothingQuality = 'high';
  tc.drawImage(c, 0, 0, img.width, img.height, 0, 0, w, h);
  return tc.getImageData(0, 0, w, h);
}

/**
 * Anti-mosaïque : l'image source est censurée par une grille de blocs (chaque
 * bloc = couleur moyenne de la zone d'origine -> détails détruits). La SR ne
 * peut pas les retrouver : elle hallucine. On inverse donc la mosaïque (moyenne
 * par bloc -> bloc lisse) avant l'upscale, ce qui donne un rendu propre au lieu
 * du "grain" de la double SR.
 */
function luminance(rgba: Uint8ClampedArray, w: number, h: number): Float32Array {
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    L[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  }
  return L;
}

/**
 * Détecte la taille du bloc de mosaïque. Conditions :
 *  1. une discontinuité de grille périodique (médiane des espacements) sur un
 *     des deux axes — un seul axe suffit (grilles CARRÉES : même période X/Y) ;
 *     deux axes détectés -> concordance ±15 % exigée.
 *  2. VÉRIFICATION DE PHASE : les bords doivent s'aligner sur une même phase
 *     modulo B (grille régulière). Une photo ordinaire (bords aléatoires :
 *     rambarde, volets…) échoue ce test → pas d'anti-mosaïque, zéro dégradé.
 */
function mosaicBlockSize(L: Float32Array, w: number, h: number): number {
  const TH = 8; // seuil de discontinuité de luminance (delta, pas ratio)
  // Positions des bords le long de chaque axe, échantillonné.
  const xs: number[] = []; // bords verticaux (x) vus sur des lignes
  const ys: number[] = []; // bords horizontaux (y) vus sur des colonnes
  const ystep = Math.max(1, (h / 12) | 0);
  const xstep = Math.max(1, (w / 12) | 0);
  for (let y = 0; y < h; y += ystep) {
    for (let x = 1; x < w; x++) if (Math.abs(L[y * w + x] - L[y * w + x - 1]) > TH) xs.push(x);
  }
  for (let x = 0; x < w; x += xstep) {
    for (let y = 1; y < h; y++) if (Math.abs(L[y * w + x] - L[(y - 1) * w + x]) > TH) ys.push(y);
  }

  const phasePeak = (positions: number[], B: number): number => {
    const PHASES = 8;
    const hist = new Array<number>(PHASES).fill(0);
    for (const p of positions) hist[Math.min(PHASES - 1, ((p % B) / (B / PHASES)) | 0)]++;
    return Math.max(...hist);
  };
  // Période candidate = médiane des espacements entre bords consécutifs.
  const medianGap = (positions: number[]): number => {
    const s = [...positions].sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < s.length; i++) {
      const d = s[i] - s[i - 1];
      if (d >= 8 && d <= 400) gaps.push(d);
    }
    if (!gaps.length) return 0;
    gaps.sort((a, b) => a - b);
    const B = gaps[(gaps.length / 2) | 0];
    return B >= 8 && B <= 256 ? B : 0;
  };

  // Un axe peut suffire : les mosaïques sont des grilles CARRÉES — si les
  // bords d'un axe sont trop doux (délétion de contraste directionnelle,
  // downscale), l'autre porte la grille et on déduit la période.
  const bx = xs.length >= 32 ? medianGap(xs) : 0;
  const by = ys.length >= 32 ? medianGap(ys) : 0;
  let B = 0;
  if (bx && by) {
    if (Math.abs(bx - by) > Math.max(bx, by) * 0.15) return 0;
    B = Math.round((bx + by) / 2);
  } else if (bx || by) {
    B = bx || by;
  }
  if (!B) return 0;
  const okX = xs.length >= 32 ? phasePeak(xs, B) >= xs.length * 0.55 : true;
  const okY = ys.length >= 32 ? phasePeak(ys, B) >= ys.length * 0.55 : true;
  return okX && okY ? B : 0;
}

/**
 * Inverse la mosaïque : moyenne de chaque bloc -> bloc uniforme (puis la SR
 * lisse les bords). Sans forceMosaic, ne s'applique que si la grille est
 * DÉTECTÉE ; sinon src est retourné tel quel (zéro coût, zéro dégradation).
 */
function mosaicUndo(src: ImageData, forceMosaic = false): ImageData {
  const w = src.width, h = src.height;
  let B = mosaicBlockSize(luminance(src.data, w, h), w, h);
  if (!B && forceMosaic) B = 12; // taille de bloc par défaut (mosaïque "molle")
  if (!B) return src;
  const out = new ImageData(w, h);
  const od = out.data, sd = src.data;
  for (let by = 0; by < h; by += B) {
    const y1 = Math.min(h, by + B);
    for (let bx = 0; bx < w; bx += B) {
      const x1 = Math.min(w, bx + B);
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = by; y < y1; y++) for (let x = bx; x < x1; x++) {
        const i = (y * w + x) * 4;
        r += sd[i]; g += sd[i + 1]; b += sd[i + 2]; n++;
      }
      r /= n; g /= n; b /= n;
      for (let y = by; y < y1; y++) for (let x = bx; x < x1; x++) {
        const i = (y * w + x) * 4;
        od[i] = Math.round(r); od[i + 1] = Math.round(g); od[i + 2] = Math.round(b); od[i + 3] = 255;
      }
    }
  }
  return out;
}

/**
 * SR — Real-ESRGAN general x4v3, forme statique 384 -> 1536.
 * Anti-mosaïque (inversion de grille) en amont, tiling (pas 256, marge 64 px),
 * padding par clamp, fondage pondéré aux bords de tuile.
 */
async function runSuperResolution(
  src: ImageData,
  outW: number,
  outH: number,
  ep: string,
  forceMosaic = false,
): Promise<ImageData> {
  // Anti-mosaïque AUTOMATIQUE (si la grille est détectée) ou FORCÉE par le
  // toggle UI ; sinon src est traité tel quel.
  post({ type: 'progress', p: 0.02, label: 'demosaic' });
  const clean = mosaicUndo(src, forceMosaic);
  const lib = await getOrt();
  const session = await getSession('realesr-general-x4v3-static384', ep);
  const sw = clean.width;
  const sh = clean.height;
  const sc = outW / sw;
  const TILE = 384;
  const STEP = 256;
  const PAD = 64;

  const out = new ImageData(outW, outH);
  const accum = new Float32Array(outW * outH * 3);
  const weight = new Float32Array(outW * outH);

  const tiles: { x: number; y: number }[] = [];
  for (let ty = -PAD; ty < sh; ty += STEP) for (let tx = -PAD; tx < sw; tx += STEP) tiles.push({ x: tx, y: ty });

  const sImg = new ImageData(TILE, TILE);
  const od = new Float32Array(3 * 1536 * 1536);
  let done = 0;
  for (const t of tiles) {
    for (let y = 0; y < TILE; y++) {
      const sy = Math.max(0, Math.min(sh - 1, t.y + y));
      for (let x = 0; x < TILE; x++) {
        const sx = Math.max(0, Math.min(sw - 1, t.x + x));
        const si = (sy * sw + sx) * 4;
        const di = (y * TILE + x) * 4;
        sImg.data[di] = clean.data[si];
        sImg.data[di + 1] = clean.data[si + 1];
        sImg.data[di + 2] = clean.data[si + 2];
        sImg.data[di + 3] = 255;
      }
    }
    const tensor = rgbaToTensorNchw(sImg.data, TILE, TILE);
    const res = await session.run({ input: new lib.Tensor('float32', tensor, [1, 3, TILE, TILE]) });
    void (res.output.data as Float32Array);
    od.set(res.output.data as Float32Array);
    const ox = Math.round(t.x * sc);
    const oy = Math.round(t.y * sc);
    const x0 = Math.max(0, ox);
    const x1 = Math.min(outW, ox + 1536);
    const y0 = Math.max(0, oy);
    const y1 = Math.min(outH, oy + 1536);
    for (let y = y0; y < y1; y++) {
      const ly = y - oy;
      const fy = Math.min(ly, 1535 - ly, 128) / 128;
      for (let x = x0; x < x1; x++) {
        const lx = x - ox;
        const fx = Math.min(lx, 1535 - lx, 128) / 128;
        const wgt = Math.min(1, Math.min(fx, fy));
        const oi = (y * outW + x) * 3;
        const di = (ly * 1536 + lx) * 3;
        accum[oi] += od[di] * wgt;
        accum[oi + 1] += od[di + 1] * wgt;
        accum[oi + 2] += od[di + 2] * wgt;
        weight[y * outW + x] += wgt;
      }
    }
    if (++done % 4 === 0) post({ type: 'progress', p: done / tiles.length, label: 'upscale' });
  }
  const d = out.data;
  for (let i = 0; i < outW * outH; i++) {
    const wgt = weight[i] || 1;
    d[i * 4] = Math.round((accum[i * 3] / wgt) * 255);
    d[i * 4 + 1] = Math.round((accum[i * 3 + 1] / wgt) * 255);
    d[i * 4 + 2] = Math.round((accum[i * 3 + 2] / wgt) * 255);
    d[i * 4 + 3] = 255;
  }
  return out;
}

interface Face { x: number; y: number; w: number; h: number; score: number }

/**
 * YuNet — décode YOLO multi-échelles (80/40/20, pas 5/10/20) -> boîtes image + NMS.
 * Convention OpenCV : BGR, (v/255 - 0.5) * 2.
 */
async function detectFaces(src: ImageData, ep: string): Promise<Face[]> {
  const S = 640;
  const sw = src.width;
  const sh = src.height;
  const scale = Math.min(S / sw, S / sh);
  const nw = Math.round(sw * scale);
  const nh = Math.round(sh * scale);
  const dx = Math.round((S - nw) / 2);
  const dy = Math.round((S - nh) / 2);

  const sc = srcCanvasOf(src);
  const letter = newCanvas(S, S);
  const lc = letter.getContext('2d')!;
  lc.fillStyle = 'rgb(127,127,127)';
  lc.fillRect(0, 0, S, S);
  lc.imageSmoothingEnabled = true;
  lc.imageSmoothingQuality = 'high';
  lc.drawImage(sc, dx, dy, nw, nh);
  const box = lc.getImageData(0, 0, S, S);
  const arr = box.data;
  const tensor = new Float32Array(3 * S * S);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const j = (y * S + x) * 4;
        const v = c === 0 ? arr[j + 2] : c === 1 ? arr[j + 1] : arr[j]; // BGR
        tensor[c * S * S + y * S + x] = (v / 255 - 0.5) * 2;
      }
    }
  }
  const lib = await getOrt();
  const session = await getSession('yunet', ep);
  const res = await session.run({ input: new lib.Tensor('float32', tensor, [1, 3, S, S]) });
  const sig = (v: number) => 1 / (1 + Math.exp(-v));
  const layers = [
    { n: 6400, s: 5, cls: res.cls_8.data as Float32Array, obj: res.obj_8.data as Float32Array, bb: res.bbox_8.data as Float32Array },
    { n: 1600, s: 10, cls: res.cls_16.data as Float32Array, obj: res.obj_16.data as Float32Array, bb: res.bbox_16.data as Float32Array },
    { n: 400, s: 20, cls: res.cls_32.data as Float32Array, obj: res.obj_32.data as Float32Array, bb: res.bbox_32.data as Float32Array },
  ];
  const raw: Face[] = [];
  for (const L of layers) {
    for (let i = 0; i < L.n; i++) {
      const score = sig(L.cls[i]) * sig(L.obj[i]);
      if (score < 0.5) continue;
      const cx = L.bb[i * 4 + 0] * L.s;
      const cy = L.bb[i * 4 + 1] * L.s;
      const bw = L.bb[i * 4 + 2] * L.s;
      const bh = L.bb[i * 4 + 3] * L.s;
      const x1 = (cx - bw / 2 - dx) / scale;
      const y1 = (cy - bh / 2 - dy) / scale;
      const x2 = (cx + bw / 2 - dx) / scale;
      const y2 = (cy + bh / 2 - dy) / scale;
      if (x2 <= 0 || y2 <= 0 || x1 >= sw || y1 >= sh) continue;
      raw.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, score });
    }
  }
  raw.sort((a, b) => b.score - a.score);
  const iou = (a: Face, b: Face) => {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return inter / (a.w * a.h + b.w * b.h - inter || 1);
  };
  const kept: Face[] = [];
  for (const f of raw) if (kept.every((k) => iou(k, f) < 0.4)) kept.push(f);
  return kept.slice(0, 12);
}

/**
 * GFPGAN — par visage : crop 512x512 (marge 25 %), inférence, fondage par
 * masque radial. Fallback : si rien n'est détecté, traitement de la zone centrale.
 */
async function runFaceRestore(src: ImageData, ep: string): Promise<{ out: ImageData; faces: number }> {
  const lib = await getOrt();
  // Base éventuellement pré-upscalée (GFPGAN attend un visage d'au moins ~256 px
  // ; l'UI downscale la source à long edge 1200, un visage reste lisible mais
  // petit : on le fait grossir avant détection + inference).
  let base = src;
  if (Math.max(src.width, src.height) < 512) {
    const k = Math.min(2, 512 / Math.max(src.width, src.height));
    const big = newCanvas(Math.max(8, Math.round(src.width * k)), Math.max(8, Math.round(src.height * k)));
    const bc = big.getContext('2d')!;
    bc.imageSmoothingEnabled = true;
    bc.imageSmoothingQuality = 'high';
    bc.drawImage(newCanvasFromImageData(src), 0, 0, src.width, src.height, 0, 0, big.width, big.height);
    base = bc.getImageData(0, 0, big.width, big.height);
  }
  const faces = await detectFaces(base, ep);
  const sc = srcCanvasOf(base);
  const out = newCanvas(base.width, base.height);
  const octx = out.getContext('2d')!;
  octx.drawImage(sc, 0, 0);

  const session = await getSession('GFPGANv1.4', ep);

  const list: Face[] =
    faces.length > 0
      ? faces
      : [
          {
            x: Math.max(0, (base.width - Math.min(512, base.width)) / 2),
            y: Math.max(0, (base.height - Math.min(512, base.height)) / 2),
            w: Math.min(512, base.width),
            h: Math.min(512, base.height),
            score: 0,
          },
        ];

  for (let i = 0; i < list.length; i++) {
    post({ type: 'progress', p: 0.15 + 0.75 * (i / list.length), label: 'faces' });
    const f = list[i];
    // Crop centré sur le visage avec marge 25 %, borné à l'image.
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    const mw = f.w * 1.5;
    const mh = f.h * 1.5;
    let mx = cx - mw / 2;
    let my = cy - mh / 2;
    mx = Math.max(0, Math.min(mx, base.width - 1));
    my = Math.max(0, Math.min(my, base.height - 1));
    const rw = Math.max(8, Math.min(Math.round(mw), base.width - mx));
    const rh = Math.max(8, Math.min(Math.round(mh), base.height - my));

    // Redimensionne le crop en 512x512 (rétinoïde : preserve les proportions).
    const big = newCanvas(512, 512);
    const bc = big.getContext('2d')!;
    bc.fillStyle = 'rgb(0,0,0)';
    bc.fillRect(0, 0, 512, 512);
    const fit = Math.min(512 / rw, 512 / rh);
    const fw = Math.round(rw * fit);
    const fh = Math.round(rh * fit);
    bc.imageSmoothingEnabled = true;
    bc.imageSmoothingQuality = 'high';
    bc.drawImage(sc, mx, my, rw, rh, (512 - fw) / 2, (512 - fh) / 2, fw, fh);
    const pixels = bc.getImageData(0, 0, 512, 512);

    const tensor = rgbaToTensorNchw(pixels.data, 512, 512);
    const res = await session.run({ input: new lib.Tensor('float32', tensor, [1, 3, 512, 512]) });
    const restored = nchwToImageData(res.output.data as Float32Array, 512, 512);

    // Remise à l'échelle 512 -> (rw, rh) puis recadrage sur la zone du visage.
    const back = newCanvas(rw, rh);
    const bctx = back.getContext('2d')!;
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = 'high';
    const srcFitX = (512 - fw) / 2 / (512 / (fw || 1)) / (fw || 1) * 1; // no-op
    bctx.drawImage(
      newCanvasFromImageData(restored),
      (512 - fw) / 2, (512 - fh) / 2, fw, fh,
      0, 0, rw, rh
    );
    const td = bctx.getImageData(0, 0, rw, rh).data;

    // Masque radial adouci (pas de bord dur) recadré sur (rw, rh).
    const mSrc = newCanvas(512, 512);
    const msc = mSrc.getContext('2d')!;
    msc.fillStyle = '#000';
    msc.fillRect(0, 0, 512, 512);
    const grad = msc.createRadialGradient(256, 256, 40, 256, 256, 320);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    msc.fillStyle = grad;
    msc.fillRect(0, 0, 512, 512);
    const mBack = newCanvas(rw, rh);
    const mbc = mBack.getContext('2d')!;
    mbc.imageSmoothingEnabled = true;
    mbc.drawImage(
      mSrc,
      (512 - fw) / 2, (512 - fh) / 2, fw, fh,
      0, 0, rw, rh
    );
    const mbd = mbc.getImageData(0, 0, rw, rh).data;

    // Fondage sur la région de l'image de sortie.
    const region = octx.getImageData(Math.round(mx), Math.round(my), rw, rh);
    const fd = region.data;
    for (let p = 0; p < rw * rh; p++) {
      const a = mbd[p * 4] / 255;
      if (a <= 0) continue;
      fd[p * 4] = fd[p * 4] * (1 - a) + td[p * 4] * a;
      fd[p * 4 + 1] = fd[p * 4 + 1] * (1 - a) + td[p * 4 + 1] * a;
      fd[p * 4 + 2] = fd[p * 4 + 2] * (1 - a) + td[p * 4 + 2] * a;
    }
    octx.putImageData(region, Math.round(mx), Math.round(my));
  }
  return { out: octx.getImageData(0, 0, base.width, base.height), faces: faces.length };
}

function newCanvasFromImageData(img: ImageData): OffscreenCanvas {
  const c = newCanvas(img.width, img.height);
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}

/**
 * De-Mosaic — dé-pixelisation : SR ×4 sur l'original, puis 2e passe SR,
 * enfin redimensionnement aux dims demandées.
 */
async function runDeMosaic(src: ImageData, outW: number, outH: number, ep: string, forceMosaic = false): Promise<ImageData> {
  post({ type: 'progress', p: 0.05, label: 'demosaic' });
  // 1re passe : anti-mosaïque (inversion de grille) + SR ×4.
  let stage = await runSuperResolution(src, Math.round(src.width * 4), Math.round(src.height * 4), ep, forceMosaic);
  post({ type: 'progress', p: 0.5, label: 'demosaic' });
  const mid = downscaleTo(stage, Math.max(64, Math.round(stage.width / 2)), Math.max(64, Math.round(stage.height / 2)));
  // 2e passe : SR seule (plus de grille à inverser sur l'image lissée).
  stage = await runSuperResolution(mid, Math.round(mid.width * 4), Math.round(mid.height * 4), ep, forceMosaic);
  post({ type: 'progress', p: 0.92, label: 'demosaic' });
  return downscaleTo(stage, outW, outH);
}

if (typeof self !== 'undefined') {
  self.onmessage = async (e: MessageEvent<RunMsg>) => {
  const msg = e.data;
  if (msg.type !== 'run') return;
  try {
    LAST_BYTES = msg.modelBytes;
    const ep = await pickProvider();
    const src = new ImageData(new Uint8ClampedArray(msg.data), msg.w, msg.h);
    post({ type: 'progress', p: 0.02, label: 'start', provider: ep });

    let result: ImageData;
    let facesCount: number | undefined;
    if (msg.mode === 'sr') {
      result = await runSuperResolution(src, msg.targetW, msg.targetH, ep, !!msg.forceMosaic);
    } else if (msg.mode === 'face') {
      const r = await runFaceRestore(src, ep);
      result = r.out;
      facesCount = r.faces;
    } else {
      result = await runDeMosaic(src, msg.targetW, msg.targetH, ep, !!msg.forceMosaic);
    }
    post({ type: 'result', data: result.data.buffer, w: result.width, h: result.height, provider: ep, faces: facesCount });
  } catch (err: any) {
    post({ type: 'error', message: String(err?.message ?? err) });
  }
  };
}
