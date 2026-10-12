/**
 * Référentiel des modèles ONNX (Étape 0 — analyse-decensor.md).
 *
 * Tailles/URLs vérifiées via HEAD HTTP sur huggingface.co (2026-10-11) :
 *  - HuggingFace sert les `resolve/main` avec `access-control-allow-origin: *`
 *    → les poids sont lisibles par `fetch()` même sous COEP `require-corp`.
 *  - WebGPU fonctionne UNIQUEMENT sur les graphes à forme statique :
 *    `realesr-general-x4v3-static384` ([1,3,384,384]->[1,3,1536,1536]).
 *    Les versions à forme dynamique (65 Mo) échouent sur WebGPU (buffer re-use).
 */
export type ModelId = 'super-resolution' | 'face-restore' | 'demosaic';

export interface ModelSpec {
  /** Identifiant stable utilisé dans IndexedDB. */
  key: string;
  /** Nom affiché dans l'UI. */
  label: string;
  /** Description courte affichée sous le nom. */
  hint: string;
  /** URL du poids .onnx (resolve main -> CORS * -> OK sous COEP). */
  url: string;
  /** Taille indicative en octets (pour la jauge + le budget). */
  size: number;
  /**
   * Poids "secondaires" téléchargés avec le modèle (ex: détecteur de visages).
   */
  deps: { key: string; label: string; url: string; size: number }[];
  /** Modèle principal à charger pour ce mode. */
  main: { key: string; url: string; size: number };
}

const MB = 1024 * 1024;

const HF = 'https://huggingface.co';

export const MODELS: Record<ModelId, ModelSpec> = {
  'super-resolution': {
    key: 'mode-sr',
    label: 'Real-ESRGAN',
    hint: 'Démosaïque + défloutage & upscaling ×4 (WebGPU)',
    url: '',
    size: 0,
    main: {
      key: 'realesr-general-x4v3-static384',
      url: `${HF}/Saimon8420/realesr-general-x4v3-web/resolve/main/realesr-general-x4v3-static384.onnx`,
      size: 4 * MB,
    },
    deps: [],
  },
  'face-restore': {
    key: 'mode-face',
    label: 'GFPGAN',
    hint: 'Restauration de visages (WebGPU) — pour les visages',
    url: '',
    size: 0,
    main: {
      key: 'GFPGANv1.4',
      url: `${HF}/HowToSD/GFPGAN-ONNX/resolve/main/GFPGANv1.4.onnx`,
      size: 324 * MB,
    },
    deps: [
      {
        key: 'yunet',
        label: 'Détecteur YuNet',
        url: `${HF}/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx`,
        size: 227 * 1024,
      },
    ],
  },
  'demosaic': {
    key: 'mode-demosaic',
    label: 'De-Mosaic',
    hint: 'Dé-pixelisation (2 passes Real-ESRGAN)',
    url: '',
    size: 0,
    // Réutilise le même poids SR que super-resolution (pas de 2e téléchargement).
    main: {
      key: 'realesr-general-x4v3-static384',
      url: `${HF}/Saimon8420/realesr-general-x4v3-web/resolve/main/realesr-general-x4v3-static384.onnx`,
      size: 4 * MB,
    },
    deps: [],
  },
};

// GFPGAN en tête : c'est le mode recommandé (visages crédibles sur photo
// critee) ; il est aussi la valeur par défaut du sélecteur (composant).
export const MODEL_IDS: ModelId[] = ['face-restore', 'super-resolution', 'demosaic'];

/** Budget de cache IndexedDB (octets). ~500 Mo. */
export const IDB_BUDGET = 500 * MB;
