import {
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
  signal,
  inject,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { InferenceService, InferenceResult, RunMode } from '../services/inference.service';
import { MODELS, MODEL_IDS, ModelId, IDB_BUDGET } from '../models/registry';
import { clearCache, isCached } from '../services/model-cache';

/**
 * Étape 5 — Workspace principal.
 *
 * - Drag & Drop / tap -> File -> HTMLImageElement -> canvas (source bornée).
 * - Sélecteur de modèles (Real-ESRGAN / GFPGAN / De-Mosaic).
 * - Slider Avant/Après (clip-path) superposé aux deux canvas.
 * - Export PNG + téléchargement de l'APK (asset statique).
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styles: ['/* styles globaux dans src/styles.css */'],
})
export class AppComponent implements OnInit, OnDestroy {
  private zone = inject(NgZone);
  private inference = inject(InferenceService);
  private cdr = inject(ChangeDetectorRef);

  // ---- État UI (signals) ----
  readonly modelId = signal<ModelId>('super-resolution');
  readonly busy = signal(false);
  readonly progress = signal(0);
  readonly progressLabel = signal('');
  readonly provider = signal<string | null>(null);
  readonly errorMsg = signal<string | null>(null);
  readonly hasImage = signal(false);
  readonly isDragging = signal(false);
  readonly slider = signal(0.5);
  /** Force l'inversion de mosaïque (blocs carrés) même si le détecteur ne la voit pas. */
  readonly forceMosaic = signal(false);
  readonly cached = signal<Record<string, boolean>>({});
  readonly webgpu = this.inference.webgpuAvailable;
  readonly models = MODEL_IDS;
  readonly modeLabel: Record<ModelId, string> = {
    'super-resolution': MODELS['super-resolution'].label,
    'face-restore': MODELS['face-restore'].label,
    'demosaic': MODELS['demosaic'].label,
  };
  readonly modeHint: Record<ModelId, string> = {
    'super-resolution': MODELS['super-resolution'].hint,
    'face-restore': MODELS['face-restore'].hint,
    'demosaic': MODELS['demosaic'].hint,
  };

  // ---- Canvas (refs DOM) ----
  @ViewChild('originalCanvas') originalCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('resultCanvas') resultCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('fileInput') fileInputRef!: ElementRef<HTMLInputElement>;

  get originalCanvas(): HTMLCanvasElement {
    return this.originalCanvasRef?.nativeElement as HTMLCanvasElement;
  }
  get resultCanvas(): HTMLCanvasElement {
    return this.resultCanvasRef?.nativeElement as HTMLCanvasElement;
  }

  private srcW = 0;
  private srcH = 0;
  /** Snapshot de la source (pour le redessin "avant" aux dims du résultat). */
  private srcSnapshot: HTMLCanvasElement | null = null;

  /** Long edge max de la source envoyée au worker. */
  private readonly MAX_SRC_EDGE = 1200;
  /** Facteur d'upscale affiché. */
  private readonly UPSCALE = 4;

  constructor() {
    // Abonnement aux flux du service (hors zone pour ne pas inonder le CD).
    this.zone.runOutsideAngular(() => {
      this.inference.progress$.subscribe((p) => {
        this.progress.set(p.p);
        this.progressLabel.set(this.label(p.label));
      });
      this.inference.provider$.subscribe((p) => this.provider.set(p));
      this.inference.log$.subscribe((m) => console.log('[worker]', m));
      this.inference.error$.subscribe((m) => {
        this.errorMsg.set(m);
        this.busy.set(false);
        this.cdr.markForCheck();
      });
      this.inference.download$.subscribe((p) => {
        // Pendant le téléchargement, la barre affiche le téléchargement (0..0.3).
        if (p.cached) {
          this.progressLabel.set('modèle en cache');
        } else {
          this.progress.set(0.02 + p.p * 0.28);
          this.progressLabel.set(`téléchargement ${Math.round(p.totalMB)} Mo`);
        }
      });
    });
  }

  private label(l: string): string {
    switch (l) {
      case 'init': return 'initialisation';
      case 'start': return 'début';
      case 'upscale': return 'upscale';
      case 'faces': return 'visages';
      case 'demosaic': return 'de-mosaic';
      case 'done': return 'terminé';
      default: return l;
    }
  }

  async ngOnInit() {
    // Pré-calcule l'état "en cache" pour les badges.
    void this.refreshCached();
  }

  async refreshCached() {
    const out: Record<string, boolean> = {};
    for (const id of MODEL_IDS) {
      const spec = MODELS[id];
      out[id] = await Promise.all(
        [spec.main, ...spec.deps].map((m) => isCached(m.key))
      ).then((v) => v.every(Boolean));
    }
    this.cached.set(out);
    this.cdr.markForCheck();
  }

  ngOnDestroy() {
    // InferenceService termine son worker (providedIn root, nettoyé par Angular).
  }

  // ---- Chargement d'image ----
  async onFiles(files: FileList | null | undefined) {
    if (!files || files.length === 0) return;
    await this.loadFile(files[0]);
  }

  private async loadFile(file: File) {
    this.errorMsg.set(null);
    const url = URL.createObjectURL(file);
    try {
      const img = await this.decode(url);
      const ow = img.naturalWidth;
      const oh = img.naturalHeight;
      this.originalCanvas.width = ow;
      this.originalCanvas.height = oh;
      this.originalCanvas.getContext('2d')!.drawImage(img, 0, 0);
      this.srcW = ow;
      this.srcH = oh;
      // Snapshot non-mutable de la source (survit aux redimensionnements).
      const snap = document.createElement('canvas');
      snap.width = this.srcW;
      snap.height = this.srcH;
      snap.getContext('2d')!.drawImage(this.originalCanvas, 0, 0);
      this.srcSnapshot = snap;
      // Réinitialise le canvas résultat (image source, dims identiques).
      this.resultCanvas.width = this.srcW;
      this.resultCanvas.height = this.srcH;
      this.resultCanvas.getContext('2d')!.drawImage(this.srcSnapshot, 0, 0);
      this.slider.set(0.5);
      this.hasImage.set(true);
      this.cdr.markForCheck();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private decode(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Décodage image impossible'));
      img.src = url;
    });
  }

  /** Prépare l'image source (bornée) en ImageData pour le worker. */
  private sourceForWorker(): { data: ArrayBuffer; w: number; h: number } {
    const base = this.srcSnapshot ?? this.originalCanvas;
    // Downscale si la source dépasse MAX_SRC_EDGE (mémoire VRAM).
    let w = base.width;
    let h = base.height;
    const long = Math.max(w, h);
    let srcCanvas = base;
    if (long > this.MAX_SRC_EDGE) {
      const k = this.MAX_SRC_EDGE / long;
      w = Math.max(8, Math.round(w * k));
      h = Math.max(8, Math.round(h * k));
      srcCanvas = this.scaleTo(base, w, h);
    }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(srcCanvas, 0, 0, w, h);
    const id = c.getContext('2d')!.getImageData(0, 0, w, h);
    return { data: id.data.buffer, w, h };
  }

  private scaleTo(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const cx = c.getContext('2d')!;
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(src, 0, 0, src.width, src.height, 0, 0, w, h);
    return c;
  }

  // ---- Lancement du traitement ----
  async process() {
    if (!this.hasImage() || this.busy()) return;
    this.errorMsg.set(null);
    this.busy.set(true);
    this.progress.set(0.02);
    this.progressLabel.set('préparation');
    this.cdr.markForCheck();

    const modelId = this.modelId();
    const mode: RunMode = modelId === 'super-resolution' ? 'sr' : modelId === 'face-restore' ? 'face' : 'demosaic';
    const src = this.sourceForWorker();

    // Dims cibles :
    //  - SR / De-Mosaic : ×4 (borné à ~2048 pour la VRAM).
    //  - Visages : dims source (restauration in situ).
    let targetW = src.w;
    let targetH = src.h;
    if (mode !== 'face') {
      targetW = Math.min(2048, src.w * this.UPSCALE);
      targetH = Math.min(2048, src.h * this.UPSCALE);
      // Garde les proportions entières.
      const k = Math.min(targetW / src.w, targetH / src.h);
      targetW = Math.round(src.w * k);
      targetH = Math.round(src.h * k);
    }

    try {
      const res = await this.inference.run(mode, src.data, src.w, src.h, targetW, targetH, this.forceMosaic());
      await this.onResult(res, mode);
    } catch (e: any) {
      this.errorMsg.set(String(e?.message ?? e));
    } finally {
      this.busy.set(false);
      this.progress.set(1);
      this.cdr.markForCheck();
    }
  }

  private async onResult(res: InferenceResult, mode: RunMode) {
    const id = new ImageData(new Uint8ClampedArray(res.data), res.width, res.height);
    const rc = this.resultCanvas;
    if (rc.width !== res.width || rc.height !== res.height) {
      rc.width = res.width;
      rc.height = res.height;
    }
    // OFFSCREENCANVAS -> drawImage : la re-découpe des layers (résultat
    // upscalé, original redessiné aux dims du résultat) redessine
    // systématiquement le canvas — putImageData seul peut rester caché
    // derrière l'ancienne frame sur les GPU mobiles (bug preview constaté
    // sur Android : avant/après identiques jusqu'au téléchargement).
    const tmp = document.createElement('canvas');
    tmp.width = res.width;
    tmp.height = res.height;
    tmp.getContext('2d')!.putImageData(id, 0, 0);
    const rctx = rc.getContext('2d')!;
    rctx.imageSmoothingEnabled = true;
    rctx.imageSmoothingQuality = 'high';
    rctx.drawImage(tmp, 0, 0);
    // Redessine la SOURCE aux dims du résultat (comparaison Avant/Après juste
    // : pour les modes upscale, l'original interpolé s'aligne pixel à pixel).
    if (this.srcSnapshot) {
      if (this.originalCanvas.width !== res.width || this.originalCanvas.height !== res.height) {
        this.originalCanvas.width = res.width;
        this.originalCanvas.height = res.height;
      }
      const octx = this.originalCanvas.getContext('2d')!;
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = mode === 'face' ? 'high' : 'medium';
      octx.drawImage(this.srcSnapshot, 0, 0, this.srcSnapshot.width, this.srcSnapshot.height, 0, 0, res.width, res.height);
    }
    this.srcW = res.width;
    this.srcH = res.height;
    this.cdr.markForCheck();
  }

  // ---- Slider Avant/Après ----
  @ViewChild('viewport') viewportEl?: ElementRef<HTMLElement>;
  private draggingSlider = false;
  private get viewport(): HTMLElement | null {
    return this.viewportEl?.nativeElement ?? null;
  }
  private posFromPointer(e: PointerEvent): number {
    const v = this.viewport;
    if (!v) return this.slider();
    const r = v.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  }
  onKnobDown(e: PointerEvent) {
    this.draggingSlider = true;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    this.slider.set(this.posFromPointer(e));
    e.preventDefault();
  }
  onKnobMove(e: PointerEvent) {
    if (!this.draggingSlider) return;
    this.slider.set(this.posFromPointer(e));
    e.preventDefault();
  }
  onKnobUp(e: PointerEvent) {
    this.draggingSlider = false;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
  }

  // ---- Export ----
  savePng() {
    const c = this.resultCanvas;
    c.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dcens-${this.modelId()}-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, 'image/png');
  }

  downloadApk() {
    const a = document.createElement('a');
    a.href = 'assets/app-release.apk';
    a.download = 'app-release.apk';
    a.click();
  }

  async resetCache() {
    await clearCache();
    await this.refreshCached();
  }

  get sliderPct(): string {
    return `${(this.slider() * 100).toFixed(1)}%`;
  }

  get progressPct(): string {
    return `${Math.round(this.progress() * 100)}%`;
  }
}
