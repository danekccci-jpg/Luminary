#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════
#  Luminary macOS .dmg Build Script
#  Produces: release/Luminary-*-arm64.dmg + x64.dmg
#  Requires: Node.js 18+, npm 9+, macOS 11+
# ═══════════════════════════════════════════════════════════

ARCH=$(uname -m)
echo "🖥️  macOS architecture: $ARCH"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Step 1/5 — Installing dependencies"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
npm install

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Step 2/5 — TypeScript check (frontend + electron)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
npx tsc --noEmit
npx tsc -p tsconfig.electron.json --noEmit
echo "  ✅ All type checks passed"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Step 3/5 — Building Vite frontend"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
npx vite build
echo "  ✅ Frontend bundle ready (dist/)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Step 4/5 — Compiling Electron Main Process"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
npx tsc -p tsconfig.electron.json

# Verify all required modules compiled
for mod in main preload scraper torrserver catalog-proxy; do
  if [ ! -f "dist-electron/${mod}.js" ]; then
    echo "  ❌ Missing: dist-electron/${mod}.js"
    exit 1
  fi
done
echo "  ✅ Electron modules ready (dist-electron/)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Step 5/5 — Packaging macOS .dmg (x64 + arm64)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Build DMG for both architectures
npx electron-builder --mac --x64 --arm64

echo ""
echo "══════════════════════════════════════════════════════"
echo "  ✅ BUILD COMPLETE"
echo ""
echo "  📦 Output:"
echo "     release/Luminary-1.0.0-arm64.dmg  (Apple Silicon)"
echo "     release/Luminary-1.0.0-x64.dmg    (Intel Mac)"
echo "     release/Luminary-1.0.0-arm64.zip  (portable)"
echo "     release/Luminary-1.0.0-x64.zip    (portable)"
echo ""
echo "  🖥️  To install: double-click the .dmg"
echo "     → drag Luminary → Applications"
echo ""
echo "  ⚠️  First launch: right-click Luminary.app → Open"
echo "     (Gatekeeper for unsigned apps)"
echo "══════════════════════════════════════════════════════"
