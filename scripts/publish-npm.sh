#!/usr/bin/env bash
# publish-npm.sh — Build the Next.js standalone output and publish to npm
# Usage: ./scripts/publish-npm.sh [--dry-run]

set -euo pipefail

DRY_RUN=false
for arg in "$@"; do
  [[ "$arg" == "--dry-run" ]] && DRY_RUN=true
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── Helpers ──────────────────────────────────────────────────────────────────
info()  { echo -e "\033[1;34m[publish]\033[0m $*"; }
ok()    { echo -e "\033[1;32m[publish]\033[0m $*"; }
die()   { echo -e "\033[1;31m[publish]\033[0m ERROR: $*" >&2; exit 1; }

# ── Pre-flight checks ─────────────────────────────────────────────────────────
command -v node >/dev/null || die "node is not installed"
command -v npm  >/dev/null || die "npm is not installed"

# Must be logged in to npm
if ! npm whoami &>/dev/null; then
  die "Not logged in to npm. Run: npm login"
fi

NPM_USER=$(npm whoami)
ok "Logged in to npm as: $NPM_USER"

PKG_NAME=$(node -p "require('./package.json').name")
PKG_VERSION=$(node -p "require('./package.json').version")

info "Package : $PKG_NAME@$PKG_VERSION"

# Check if this version is already published
if npm info "$PKG_NAME@$PKG_VERSION" version &>/dev/null; then
  die "Version $PKG_VERSION is already published on npm. Bump the version first."
fi

# ── Build ─────────────────────────────────────────────────────────────────────
info "Installing dependencies..."
npm install

info "Building Next.js standalone..."
# Override NEXT_PUBLIC_* vars so local .env values are NOT baked into the bundle.
# These are runtime-configurable by the end user anyway.
NEXT_PUBLIC_BASE_URL=http://localhost:20128 \
NEXT_PUBLIC_CLOUD_URL=https://9router.com \
NODE_ENV=production \
npm run build

info "Copying static assets into standalone..."
cp -r .next/static   .next/standalone/.next/static
cp -r public         .next/standalone/public

info "Copying MITM server (child-process — not traced by Next.js)..."
mkdir -p .next/standalone/src/mitm
cp -r src/mitm/. .next/standalone/src/mitm/

ok "Build complete"

# ── Dry-run preview ───────────────────────────────────────────────────────────
info "Files that will be included in the package:"
npm pack --dry-run

# ── Publish ───────────────────────────────────────────────────────────────────
if $DRY_RUN; then
  ok "Dry-run mode — skipping actual publish."
  info "Run without --dry-run to publish for real."
else
  info "Publishing $PKG_NAME@$PKG_VERSION to npm..."
  npm publish --access public
  ok "Published! Install with: npm install -g $PKG_NAME"
fi
