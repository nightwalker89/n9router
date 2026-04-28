#!/usr/bin/env bash
# publish-npm.sh — Build the Next.js standalone output and publish/install npm packages
# Usage: ./scripts/publish-npm.sh [--dry-run] [--local] [--tag <tag>]
#   --local      Build, pack, and install the tarball globally for local testing
#   --tag next   Publish as a release candidate (won't affect 'latest')
#   --tag beta   Same idea with a different label

set -euo pipefail

DRY_RUN=false
LOCAL_INSTALL=false
NPM_TAG="latest"
ARGS=("$@")
for i in "${!ARGS[@]}"; do
  [[ "${ARGS[$i]}" == "--dry-run" ]] && DRY_RUN=true
  [[ "${ARGS[$i]}" == "--local" ]] && LOCAL_INSTALL=true
  if [[ "${ARGS[$i]}" == "--tag" ]]; then
    NPM_TAG="${ARGS[$((i+1))]:-next}"
  fi
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NPM_CONFIG_ARGS=()
if [[ -f "$ROOT/.npmrc" ]]; then
  NPM_CONFIG_ARGS=(--userconfig "$ROOT/.npmrc")
fi

# ── Helpers ──────────────────────────────────────────────────────────────────
info()  { echo -e "\033[1;34m[publish]\033[0m $*"; }
ok()    { echo -e "\033[1;32m[publish]\033[0m $*"; }
die()   { echo -e "\033[1;31m[publish]\033[0m ERROR: $*" >&2; exit 1; }
npm_registry() { npm "${NPM_CONFIG_ARGS[@]}" "$@"; }

create_package_root() {
  local pack_root="$1"

  mkdir -p "$pack_root"
  cp -R bin hooks "$pack_root/"
  cp -R .next/standalone "$pack_root/app"
  [[ -f README.md ]] && cp README.md "$pack_root/"
  [[ -f LICENSE ]] && cp LICENSE "$pack_root/"
  cp scripts/publish/package.json "$pack_root/package.json"

  node - "$pack_root/package.json" "$PUBLISH_VERSION" <<'NODE'
const fs = require("fs");
const dest = process.argv[2];
const version = process.argv[3];
const pkg = JSON.parse(fs.readFileSync(dest, "utf8"));

pkg.version = version;
fs.writeFileSync(dest, `${JSON.stringify(pkg, null, 2)}\n`);
NODE
}

assert_no_sensitive_files() {
  local pack_root="$1"
  local found_files=""
  local found_content=""

  found_files=$(
    find "$pack_root" \
      \( \
        -name ".npmrc" -o \
        -name ".env" -o \
        -name ".env.*" -o \
        -name ".netrc" -o \
        -name ".pypirc" -o \
        -name "*.pem" -o \
        -name "*.key" \
      \) \
      -print
  )

  if [[ -n "$found_files" ]]; then
    echo "$found_files" | sed "s#^$pack_root/#  #" >&2
    die "Sensitive config file found in npm package root."
  fi

  if command -v rg >/dev/null; then
    found_content=$(
      rg --hidden --no-messages -I -l \
        '(_authToken|npm_[A-Za-z0-9]{20,})' \
        "$pack_root" || true
    )
  else
    found_content=$(
      grep -RIlE \
        '(_authToken|npm_[A-Za-z0-9]{20,})' \
        "$pack_root" || true
    )
  fi

  if [[ -n "$found_content" ]]; then
    echo "$found_content" | sed "s#^$pack_root/#  #" >&2
    die "Sensitive npm token content found in npm package root."
  fi
}

# ── Pre-flight checks ─────────────────────────────────────────────────────────
command -v node >/dev/null || die "node is not installed"
command -v npm  >/dev/null || die "npm is not installed"

if $LOCAL_INSTALL; then
  ok "Local install mode — skipping npm login check."
else
  # Must be logged in to npm
  if ! npm_registry whoami &>/dev/null; then
    die "Not logged in to npm. Run: npm login"
  fi

  NPM_USER=$(npm_registry whoami)
  ok "Logged in to npm as: $NPM_USER"
fi

PKG_NAME=$(node -p "require('./package.json').name")
PKG_VERSION=$(node -p "require('./package.json').version")

# For non-latest tags, auto-append -<tag>.<YYYYMMDDHHMMSS> to form the publish version.
# The generated package root gets this version; the repo package.json stays unchanged.
PUBLISH_VERSION="$PKG_VERSION"
if [[ "$NPM_TAG" != "latest" ]]; then
  RC_TIMESTAMP=$(date +%Y%m%d%H%M%S)
  PUBLISH_VERSION="${PKG_VERSION%-*}-${NPM_TAG}.${RC_TIMESTAMP}"
  info "RC version : $PUBLISH_VERSION (package.json stays at $PKG_VERSION)"
fi

if $LOCAL_INSTALL; then
  info "Package : $PKG_NAME@$PUBLISH_VERSION (local install)"
else
  info "Package : $PKG_NAME@$PUBLISH_VERSION (tag: $NPM_TAG)"
fi

# Check if this version is already published (only for latest — RC versions are auto-unique by date)
if ! $LOCAL_INSTALL && [[ "$NPM_TAG" == "latest" ]] && npm_registry info "$PKG_NAME@$PUBLISH_VERSION" version &>/dev/null; then
  die "Version $PUBLISH_VERSION is already published on npm. Bump the version first."
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


info "Copying MITM server (child-process — not traced by Next.js)..."
mkdir -p .next/standalone/src/mitm
cp -r src/mitm/. .next/standalone/src/mitm/
mkdir -p .next/standalone/lib
cp src/lib/dbFileSafety.js .next/standalone/lib/dbFileSafety.js

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

info "Copying MITM-only runtime dependencies..."
node <<'NODE'
const fs = require("fs");
const path = require("path");

const targetNodeModules = path.resolve(".next/standalone/node_modules");
const copied = new Set();
const entryDependencies = ["node-forge", "node-machine-id", "proper-lockfile"];

function copyDependency(packageName, fromPaths = [process.cwd()]) {
  if (copied.has(packageName)) return;

  const packageJsonPath = require.resolve(`${packageName}/package.json`, {
    paths: fromPaths,
  });
  const packageRoot = path.dirname(packageJsonPath);
  const packageJson = require(packageJsonPath);
  const targetRoot = path.join(targetNodeModules, ...packageName.split("/"));

  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
  fs.cpSync(packageRoot, targetRoot, { recursive: true });
  copied.add(packageName);

  for (const dependencyName of Object.keys(packageJson.dependencies || {})) {
    copyDependency(dependencyName, [packageRoot, process.cwd()]);
  }
}

for (const packageName of entryDependencies) {
  copyDependency(packageName);
}
NODE

ok "Build complete"

# ── Publish ───────────────────────────────────────────────────────────────────
PACK_DIR=$(mktemp -d)
PACK_ROOT="$PACK_DIR/package"
create_package_root "$PACK_ROOT"
assert_no_sensitive_files "$PACK_ROOT"

info "Files that will be included in the package:"
(cd "$PACK_ROOT" && npm pack --dry-run)

if $DRY_RUN; then
  rm -rf "$PACK_DIR"
  ok "Dry-run mode — skipping actual publish."
  info "Run without --dry-run to publish for real."
elif $LOCAL_INSTALL; then
  info "Creating local tarball..."
  TARBALL_NAME=$(cd "$PACK_ROOT" && npm pack --pack-destination "$PACK_DIR" --silent)
  TARBALL_PATH="$PACK_DIR/$TARBALL_NAME"

  info "Installing globally from tarball: $TARBALL_NAME"
  npm install -g "$TARBALL_PATH"
  rm -rf "$PACK_DIR"

  ok "Installed local package. Test with: n9router --version"
else
  info "Publishing $PKG_NAME@$PUBLISH_VERSION to npm (tag: $NPM_TAG)..."
  (cd "$PACK_ROOT" && npm_registry publish --access public --tag "$NPM_TAG")
  rm -rf "$PACK_DIR"
  if [[ "$NPM_TAG" == "latest" ]]; then
    ok "Published! Install with: npm install -g $PKG_NAME"
  else
    ok "Published as '$NPM_TAG'! Install with: npm install -g $PKG_NAME@$NPM_TAG"
  fi
fi
