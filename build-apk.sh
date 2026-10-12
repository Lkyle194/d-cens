#!/usr/bin/env bash
# Pipeline de build APK (Déploiement Capacitor Android — Étape 7)
# Usage: ./build-apk.sh [debug|release]
set -euo pipefail
cd "$(dirname "$0")"

FLAVOUR="${1:-debug}"
CAP=$(echo "${FLAVOUR:0:1}" | tr '[:lower:]' '[:upper:]')
TASK="assemble${CAP}${FLAVOUR:1}"
# TASK = assembleDebug / assembleRelease

# Gradle 8.13+ (AGP 8.13) exige JDK 21+ pour compiler capacitor-android.
# On pointe JAVA_HOME sur le JDK 21 embarqué dans ./tools s'il est présent.
JDK21_DIR="$(cd "$(dirname "$0")" && pwd)/tools/$(ls "$(cd "$(dirname "$0")" && pwd)/tools" 2>/dev/null | grep '^jdk-21' | head -1)"
if [ -n "$JDK21_DIR" ] && [ -d "$JDK21_DIR" ]; then
  export JAVA_HOME="$JDK21_DIR/Contents/Home"
fi

echo "==> 1/3 Compilation Angular (production)"
npx ng build --configuration production

echo "==> 2/3 Synchronisation Capacitor -> Android"
npx cap sync android

echo "==> 3/3 Gradle ${TASK}"
( cd android && ./gradlew "$TASK" )

echo "APK généré dans android/app/build/outputs/apk/${FLAVOUR}/"
