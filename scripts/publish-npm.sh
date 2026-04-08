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

info "Cleaning previous build artifacts..."
rm -rf .next

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
# Copy to mitm/ (NOT src/mitm/) — bin/n9router.js sets MITM_SERVER_PATH here.
mkdir -p .next/standalone/mitm
cp -r src/mitm/. .next/standalone/mitm/

info "Cleaning standalone — removing sensitive and packaging-breaking files..."
# .gitignore traced here by Next.js causes npm's recursive ignore-walk to
# exclude .next/standalone/.next/ (it sees /.next/ and strips compiled output).
# .env contains real local credentials — must never ship.
# .npmrc may contain //registry.npmjs.org/:_authToken — Next copies it into standalone; never ship.
rm -f  .next/standalone/.gitignore
rm -f  .next/standalone/.env
rm -f  .next/standalone/.npmrc
# Extra noise: not needed by end users
rm -f  .next/standalone/.env.example
rm -f  .next/standalone/.dockerignore
rm -f  .next/standalone/.gitmodules
rm -f  .next/standalone/.DS_Store
rm -rf .next/standalone/.git
rm -rf .next/standalone/.github
rm -rf .next/standalone/.vscode

# ── Cross-platform hardening (native modules) ─────────────────────────────────
info "Pruning host-native artifacts from standalone..."

# 1) Remove host-built better-sqlite3 binary and let postinstall rebuild it
# on the target machine.
rm -f .next/standalone/node_modules/better-sqlite3/build/Release/better_sqlite3.node

# 2) Remove platform-specific sharp binary packs copied from the build host.
# images.unoptimized=true, so these are not required at runtime.
if [[ -d .next/standalone/node_modules/@img ]]; then
  find .next/standalone/node_modules/@img \
    -mindepth 1 -maxdepth 1 -type d \
    \( -name 'sharp-*' -o -name 'sharp-libvips-*' \) \
    -exec rm -rf {} +
fi

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
