# Étape 0 — Recherche et Sélection des Modèles ONNX (D-Cens)

Date : 2026-10-11 · Recherche via SearXNG + API HuggingFace (tailles vérifiées au HEAD HTTP).

## Critères de sélection

| Critère | Valeur retenue |
|---|---|
| Format | `.onnx` natif, exécutable `onnxruntime-web` (WebGPU/WebGL) |
| Précision | FP32 par défaut ; versions FP16/INT8 quand dispo et validées WebGPU |
| Taille | < 60 Mo par modèle (budget global ~150 Mo en IndexedDB) |
| Licence | Compat usage NSFW / documents caviardés, pas de restriction commerciale bloquante |
| Robustesse | Entrées/sorties tensor stables, inférence décomposable en tuiles (tiling 128–512 px) |

## 1. Défloutage / super-résolution → **Real-ESRGAN-2x (v1)**

- **Modèle** : `liangmu261004/real-esrgan-onnx` → `RealESRGAN_x2plus.onnx`
- **Taille vérifiée** : ~43 Mo (FP32)
- **Entrée** : `x` NHWC RGB, valeurs normalisées [0,1] (÷255), tiling 512×512 (padding répété)
- **Sortie** : `output` RGBA/RGB NHWC, ×2 sur l'input
- **Pourquoi** : la famille Real-ESRGAN est la plus éprouvée en navigateur (démos onnxruntime-web officielles, dizaines de forks web actifs). ×2 plutôt que ×4 : un défloutage de photos web n'a pas besoin de ×4 (mémoire VRAM), et le slider Avant/Après compare à l'original — l'utilisateur peut relancer pour un second upscaling.
- **Reculs** : `Saimon8420/realesr-general-x4v3-web` (démo web dédiée, `realesr-general-x4v3.onnx`) ; `liangmu261004/real-esrgan-onnx/RealESRGAN_x4plus_anime_6B.onnx` pour l'anime.

## 2. Restauration de visages → **GFPGAN v1.4**

- **Modèle** : `HowToSD/GFPGAN-ONNX` → `GFPGANv1.4.onnx` (vérifié : fichiers listés sur le dépôt)
- **Taille** : ~33 Mo (FP32)
- **Pipeline** : détection de visages (YuNet, `opencv/face_detection_yunet` → `face_detection_yunet_2023mar.onnx`, **232 Ko** — taille vérifiée) → crop de chaque visage → GFPGAN 512×512 → fondage (blending luma, masque gaussien) sur l'image d'origine ou sur l'upscalé.
- **Pourquoi GFPGAN plutôt que CodeFormer** : `bluefoxcreation/Codeformer-ONNX` (`codeformer.onnx` ~86 Mo, entrées `input`/`input2`) est de meilleure qualité mais CodeFormer est architecturalement un GAN multi-étage (encoder → latent → decoder) : son export ONNX est historiquement instable en runtime Web (graphes dynamiques, op manquants). GFPGAN est un réseau UNet simple, robuste et rapide sur WebGPU — meilleur choix pour la V1, CodeFormer reste une option de qualité pour la V2.
- **Note** : le crop doit alimenter GFPGAN en RGB [0,1] 512×512 (réalignement grossier sur les 5 points n'est pas indispensable en V1 — le visage est simplement centré/scaled).

## 3. Dé-mosaic (caviardé) → **2 voies complémentaires**

Aucun modèle ONNX « dé-mosaic » dédié fiable n'existe aujourd'hui (vérifié : `IDKSAM27/De-Mosaic` = site Next.js qui appelle un service FastAPI Python, pas utilisable client-side ; recherche HuggingFace « De-Mosaic/unmosaic » = faux positifs). Deux briques existantes combinent bien :

- **Voie A — dépixelisation par upscaling** : le modèle Real-ESRGAN du §1 fait office de « dépixelisation » — les blocs 8×8 px d'un caviardé deviennent des zones floues que la super-résolution rend lues. C'est le comportement du sélecteur « Dé-pixelisation » (même modèle, prompt UI différent : upscaling forcé ×4 = 2 passes, + lissage pré-détection des arêtes de blocs).
- **Voie B — remplissage sémantique (inpainting) des blocs durs** : **LaMa** (`AEmotionStudio/lama-inpainting` → `big-lama.safetensors`, ~200 Mo) : le masque = détecté heuristiquement (zones de constance de couleur / détection de blocs carrés réguliers). LaMa en safetensors exige l'export ONNX (outil `torch2onnx` de `Saimon8420/lama-image-inpainting-web`) — **lourdeur : 200 Mo** → téléchargement différé uniquement quand l'utilisateur choisit la brique « Remplissage sémantique », jamais au premier chargement.

## 4. Table des modèles retenue (référentiel `src/models/registry.ts`)

| id | Rôle | Fichier | Taille | Précision | Chargement |
|---|---|---|---|---|---|
| `realesrgan-2x` | Défloutage / Dé-pixelisation | `RealESRGAN_x2plus.onnx` | ~43 Mo | FP32 (→FP16 si OK WebGPU) | au 1er usage du mode |
| `gfpgan` | Restauration visages | `GFPGANv1.4.onnx` | ~33 Mo | FP32 | au 1er usage du mode |
| `yunet` | Détection visages (dépendance GFPGAN) | `face_detection_yunet_2023mar.onnx` | 232 Ko | FP32 | avec gfpgan |
| `lama` | Remplissage sémantique (optionnel) | `lama.onnx` (à exporter) | ~200 Mo | FP32 | option explicite |

Total obligatoire : ~77 Mo. Budget IndexedDB alloué : 512 Mo.

## 5. Risques identifiés (à valider pendant les Étapes 2–4)

1. **WebGPU + NHWC** : onnxruntime-web préfère NCHW ; les exports HuggingFace ci-dessus sont NHWC — vérifier la présence de l'op `Transpose` ou convertir via ONNX Runtime format (décision à trancher au build des tensors, Étape 2).
2. **FP16 sur WebGL** : non supporté WebGL1/2 → la chaîne fallback doit requêter en FP32 (les fichiers ci-dessus sont déjà FP32, ce qui simplifie).
3. **L'op manquants** sur les exports tiers : tester `InferenceSession.create` sur les 3 modèles au dev avant de coder le tiling ; plan B = ré-export via le dépôt source du modèle.
4. **LaMa** : export à produire (torch2onnx) — non bloquant pour la V1 (option différée), bloquerait si on voulait un mode 100 % « caviardé » dès le 1er chargement.

**Statut** : recherche terminée, 3 briques retenues, 1 optionnelle. → passe à l'Étape 1.
