import { Injectable, NgZone, OnDestroy, EventEmitter } from '@angular/core';
import { MODELS, ModelId } from '../models/registry';
import { getWeights, DownloadProgress } from './model-cache';

export interface InferenceResult {
  data: ArrayBuffer;
  width: number;
  height: number;
  provider: string;
  faces?: number;
}

export type RunMode = 'sr' | 'face' | 'demosaic';

/**
 * Étape 3 — Hôte du Web Worker d'inférence.
 *
 * Orchestre : chargement/caching des poids (Étape 4) -> envoi à `app.worker.ts`
 * -> relais des progressions -> ImageData final. L'UI ne gèle jamais.
 */
@Injectable({ providedIn: 'root' })
export class InferenceService implements OnDestroy {
  private worker: Worker | null = null;

  /** Provider actif détecté (webgpu | webgl). */
  readonly provider$ = new EventEmitter<string>();
  /** Progression d'un run (0..1) + label. */
  readonly progress$ = new EventEmitter<{ p: number; label: string }>();
  /** Progression du téléchargement des poids. */
  readonly download$ = new EventEmitter<DownloadProgress>();
  /** Log worker. */
  readonly log$ = new EventEmitter<string>();
  /** Message d'erreur du dernier run. */
  readonly error$ = new EventEmitter<string>();
  /** Résultat final. */
  readonly result$ = new EventEmitter<InferenceResult>();

  private pendingResolve: ((r: InferenceResult) => void) | null = null;
  private pendingReject: ((e: string) => void) | null = null;

  /** WebGPU disponible ? (navigator.gpu). */
  get webgpuAvailable(): boolean {
    return typeof navigator !== 'undefined' && !!(navigator as any).gpu;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    // Le worker est déclaré dans tsconfig.app.json et bundle par Angular.
    const w = new Worker(new URL('../app/app.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent) => this.onWorkerMsg(e.data);
    w.onerror = (e) => {
      this.error$.next('Worker : ' + (e.message || 'erreur inconnue'));
      this.pendingReject?.('Worker : ' + (e.message || 'erreur inconnue'));
    };
    this.worker = w;
    return w;
  }

  private onWorkerMsg(m: any) {
    switch (m.type) {
      case 'ready':
        break;
      case 'log':
        this.log$.next(m.message);
        break;
      case 'progress':
        if (m.provider) this.provider$.next(m.provider);
        this.progress$.next({ p: m.p, label: m.label });
        break;
      case 'result':
        this.provider$.next(m.provider);
        this.progress$.next({ p: 1, label: 'done' });
        this.pendingResolve?.({ data: m.data, width: m.w, height: m.h, provider: m.provider, faces: m.faces });
        this.result$.next({ data: m.data, width: m.w, height: m.h, provider: m.provider, faces: m.faces });
        this.pendingResolve = this.pendingReject = null;
        break;
      case 'error':
        this.error$.next(m.message);
        this.pendingReject?.(m.message);
        this.pendingResolve = this.pendingReject = null;
        break;
    }
  }

  /**
   * Exécute une inférence. Charge (et met en cache) les poids du mode,
   * puis délègue au worker. Résout avec le ImageData-ready ArrayBuffer.
   */
  async run(
    mode: RunMode,
    sourceData: ArrayBuffer,
    w: number,
    h: number,
    targetW: number,
    targetH: number
  ): Promise<InferenceResult> {
    // 1) Poids requis (main + deps) — fetch par chunks + cache IndexedDB.
    const modelId: ModelId = mode === 'sr' ? 'super-resolution' : mode === 'face' ? 'face-restore' : 'demosaic';
    const spec = MODELS[modelId];
    const toLoad: { key: string; url: string; size: number }[] = [
      spec.main,
      ...spec.deps,
    ];
    const bytes: { key: string; bytes: ArrayBuffer }[] = [];
    for (const item of toLoad) {
      // Démultiplie la taille pour la jauge : on avance proportionnellement.
      const buf = await getWeights(item.key, item.url, item.size, (p) =>
        this.download$.next({ ...p, key: item.key })
      );
      bytes.push({ key: item.key, bytes: buf });
    }

    // 2) Envoi au worker.
    const worker = this.ensureWorker();
    const msg = {
      type: 'run' as const,
      model: modelId,
      mode,
      data: sourceData,
      w,
      h,
      targetW,
      targetH,
      modelBytes: bytes,
    };

    return new Promise<InferenceResult>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.progress$.next({ p: 0, label: 'init' });
      worker.postMessage(msg);
    });
  }

  ngOnDestroy(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
