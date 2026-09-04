#!/usr/bin/env node

/**
 * Postinstall hook for n9router.
 *
 * Purpose:
 * - Verify node:sqlite runtime availability
 * - Copy open-sse assets for standalone installations
 */

const fs = require("fs");
const path = require("path");

const pkgRoot = path.join(__dirname, "..");

function info(msg) {
  console.log(`[n9router:postinstall] ${msg}`);
}

function warn(msg) {
  console.warn(`[n9router:postinstall] ${msg}`);
}

function pathExists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

function resolveStandaloneRoot() {
  const candidates = [
    path.join(pkgRoot, "app"),
    path.join(pkgRoot, ".next", "standalone"),
  ];

  return candidates.find((candidate) =>
    pathExists(path.join(candidate, "server.js"))
  );
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * When installed from npm (standalone mode), the open-sse directory lives
 * inside .next/standalone/open-sse but the runtime server.js expects it
 * at the parent level (__dirname/../open-sse = project root/open-sse).
 * This copies it there so the source path aliases resolve correctly.
 */
function copyOpenSse() {
  const standaloneRoot = resolveStandaloneRoot();
  if (!standaloneRoot) {
    info("Skipping open-sse copy: standalone app not present (dev install)");
    return;
  }

  const standaloneOpenSse = path.join(standaloneRoot, "open-sse");
  const parentOpenSse = path.join(standaloneRoot, "..", "open-sse");

  if (!pathExists(standaloneOpenSse)) {
    info("Skipping open-sse copy: open-sse not found in standalone dir");
    return;
  }

  info(`Copying open-sse → ${path.resolve(parentOpenSse)}`);
  try {
    copyDirSync(standaloneOpenSse, parentOpenSse);
    info("open-sse copy complete");
  } catch (error) {
    warn(`open-sse copy failed: ${error.message}`);
  }
}

function main() {
  // Check node:sqlite availability
  try {
    require("node:sqlite");
    info("node:sqlite is ready. API key usage limiting enabled.");
  } catch {
    warn("node:sqlite is not available on this Node.js version.");
    warn("Node.js >= 22.13.0 is recommended for API key usage limits.");
  }

  copyOpenSse();
}

main();
