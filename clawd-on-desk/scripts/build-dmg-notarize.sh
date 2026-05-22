#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# Local macOS DMG build with code-signing + Apple notarization.
#
# Prerequisites:
#   1. Apple Developer ID Application certificate installed in keychain
#   2. Create  clawd-on-desk/.env.apple-notarize.local  with:
#        APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAM_ID)"
#        APPLE_ID="your@apple-id.email"
#        APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
#        APPLE_TEAM_ID="XXXXXXXXXX"
#   3. Sidecar already built under minicpm-sidecar/bin/
#
# Usage:
#   cd clawd-on-desk && bash scripts/build-dmg-notarize.sh
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${PROJECT_DIR}/.env.apple-notarize.local"

# ── Load credentials ─────────────────────────────────────────────
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "❌ Missing: ${ENV_FILE}" >&2
  echo "   Create it with APPLE_SIGNING_IDENTITY, APPLE_ID," >&2
  echo "   APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

required_vars=(
  APPLE_SIGNING_IDENTITY
  APPLE_ID
  APPLE_APP_SPECIFIC_PASSWORD
  APPLE_TEAM_ID
)
missing_vars=()
for name in "${required_vars[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    missing_vars+=("${name}")
  fi
done
if (( ${#missing_vars[@]} > 0 )); then
  echo "❌ Missing env vars in ${ENV_FILE}:" >&2
  printf '   - %s\n' "${missing_vars[@]}" >&2
  exit 1
fi

# ── Build the DMG with electron-builder ──────────────────────────
cd "${PROJECT_DIR}"
npm install --no-audit --no-fund

echo "🔨 Building DMG with electron-builder (arm64) ..."
# electron-builder 26+ rejects the full "Developer ID Application:" prefix
# in CSC_NAME — it wants only the friendly name (the part after the colon)
# and resolves the certificate kind itself. Strip the prefix here so users
# can keep the full identity string in .env (which is what `codesign` and
# notarytool both prefer to read).
CSC_NAME_FRIENDLY="${APPLE_SIGNING_IDENTITY#Developer ID Application: }"
CSC_NAME="${CSC_NAME_FRIENDLY}" \
APPLE_ID="${APPLE_ID}" \
APPLE_APP_SPECIFIC_PASSWORD="${APPLE_APP_SPECIFIC_PASSWORD}" \
APPLE_TEAM_ID="${APPLE_TEAM_ID}" \
  npx electron-builder --mac --arm64 -c.mac.target=dmg

# ── Locate built DMG ────────────────────────────────────────────
DMG_FILE=$(find "${PROJECT_DIR}/dist" -name '*.dmg' -maxdepth 1 | head -1)
if [[ -z "${DMG_FILE}" ]]; then
  echo "❌ No DMG found in ${PROJECT_DIR}/dist" >&2
  exit 1
fi

echo "📦 Built: ${DMG_FILE}"

# ── Submit the DMG itself for notarization ─────────────────────
# The afterSign hook only notarizes the .app bundle; the DMG wrapper
# needs its own ticket so Gatekeeper accepts the downloaded .dmg on
# first mount without requiring an internet roundtrip.
echo "🔏 Notarizing DMG ..."
xcrun notarytool submit "${DMG_FILE}" \
  --apple-id "${APPLE_ID}" \
  --password "${APPLE_APP_SPECIFIC_PASSWORD}" \
  --team-id "${APPLE_TEAM_ID}" \
  --wait

# ── Staple the ticket to the DMG ────────────────────────────────
echo "📎 Stapling notarization ticket to DMG ..."
xcrun stapler staple "${DMG_FILE}"

# ── Final verify ────────────────────────────────────────────────
echo "✅ Final verification:"
xcrun stapler validate "${DMG_FILE}"
spctl --assess --type open --context context:primary-signature --verbose "${DMG_FILE}" 2>&1 || true

echo ""
echo "🎉 Done! Notarized DMG: ${DMG_FILE}"
