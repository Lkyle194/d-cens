/**
 * Étape 4 — Téléchargement par chunks + cache IndexedDB.
 *
 * Les poids .onnx (4 Mo -> 324 Mo) sont récupérés par morceaux `fetch` (Range)
 * avec calcul de progression, puis stockés en IndexedDB pour un chargement
 * instantané aux sessions suivantes. HuggingFace sert `resolve/main` avec
 * `Access-Control-Allow-Origin: *` → lisible en `fetch` même sous COEP.
 */

const DB_NAME = 'dcens-models';
const DB_VERSION = 1;
const STORE = 'models';

export interface DownloadProgress {
  key: string;
  /** 0..1 */
  p: number;
  /** Mo téléchargés / Mo totaux (pour l'affichage). */
  loadedMB: number;
  totalMB: number;
  /** Vrai si le fichier est déjà en cache (progression = 1). */
  cached: boolean;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB indisponible'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('size', 'size');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('open failed'));
  });
  return dbPromise;
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBTransaction {
  return db.transaction(STORE, mode);
}

function store(t: IDBTransaction): IDBObjectStore {
  return t.objectStore(STORE);
}

export async function isCached(key: string): Promise<boolean> {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const rq = store(tx(db, 'readonly')).get(key);
      rq.onsuccess = () => resolve(!!rq.result);
      rq.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

/** Retourne les octets du modèle (cache d'abord, sinon téléchargement). */
export async function getWeights(
  key: string,
  url: string,
  sizeHint: number,
  onProgress: (p: DownloadProgress) => void
): Promise<ArrayBuffer> {
  try {
    const db = await openDB();
    const hit = await new Promise<ArrayBuffer | undefined>((resolve) => {
      const rq = store(tx(db, 'readonly')).get(key);
      rq.onsuccess = () => resolve(rq.result?.bytes as ArrayBuffer | undefined);
      rq.onerror = () => resolve(undefined);
    });
    if (hit) {
      onProgress({ key, p: 1, loadedMB: sizeHint / 1048576, totalMB: sizeHint / 1048576, cached: true });
      return hit;
    }
  } catch {
    /* pas de cache -> téléchargement */
  }
  const buf = await download(key, url, sizeHint, onProgress);
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const t = tx(db, 'readwrite');
      store(t).put({ key, bytes: buf, size: buf.byteLength, url, at: Date.now() });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch {
    /* cache non critique */
  }
  return buf;
}

/** Téléchargement par chunks (Range) avec progression. */
async function download(
  key: string,
  url: string,
  sizeHint: number,
  onProgress: (p: DownloadProgress) => void
): Promise<ArrayBuffer> {
  const CHUNK = 8 * 1024 * 1024; // 8 Mo
  // Découvre la taille réelle (Content-Length) si l'indice manque.
  let total = sizeHint || 0;
  try {
    const head = await fetch(url, { method: 'HEAD' });
    const len = Number(head.headers.get('content-length'));
    if (Number.isFinite(len) && len > 0) total = len;
  } catch {
    /* HEAD bloqué -> on s'appuie sur l'indice */
  }

  const chunks: Uint8Array[] = [];
  let offset = 0;
  const totalMB = total / 1048576;

  while (true) {
    const res = await fetch(url, {
      headers: total > 0 ? { Range: `bytes=${offset}-${offset + CHUNK - 1}` } : undefined,
    });
    if (!res.ok && res.status !== 206) {
      // Fallback : si le Range n'est pas supporté, on stream tout d'un coup.
      if (res.status === 200) {
        const blob = await res.blob();
        const ab = await blob.arrayBuffer();
        onProgress({ key, p: 1, loadedMB: ab.byteLength / 1048576, totalMB: totalMB, cached: false });
        return ab;
      }
      throw new Error(`Téléchargement ${key} : HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const ab = new Uint8Array(await blob.arrayBuffer());
    chunks.push(ab);
    offset += ab.byteLength;
    const loaded = Math.min(offset, total || offset);
    onProgress({
      key,
      p: total > 0 ? Math.min(1, loaded / total) : 1,
      loadedMB: loaded / 1048576,
      totalMB: totalMB,
      cached: false,
    });
    if (ab.byteLength < CHUNK && total > 0) break; // dernier morceau
    if (ab.byteLength === 0) break;
  }

  // Assemblage
  const finalSize = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(finalSize);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  onProgress({ key, p: 1, loadedMB: finalSize / 1048576, totalMB: totalMB, cached: false });
  return out.buffer;
}

/** Utilitaires. */
export async function clearCache(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const t = tx(db, 'readwrite');
      store(t).clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch {
    /* ignore */
  }
}
