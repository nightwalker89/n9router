#!/usr/bin/env node

/**
 * Postinstall hook for n9router.
 *
 * Purpose:
 * - Repair native modules that may be bundled from a different OS/arch
 * - Keep install non-fatal if rebuild fails (CLI should still start)
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const pkgRoot = path.join(__dirname, "..");
const standaloneRoot = path.join(pkgRoot, ".next", "standalone");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

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

function readMagic(binaryPath) {
  const fd = fs.openSync(binaryPath, "r");
  const buffer = Buffer.alloc(4);
  fs.readSync(fd, buffer, 0, 4, 0);
  fs.closeSync(fd);
  return buffer.toString("hex");
}

function isBinaryValidForPlatform(binaryPath) {
  if (!pathExists(binaryPath)) return false;

  let magic = "";
  try {
    magic = readMagic(binaryPath);
  } catch {
    return false;
  }

  const isLinux = magic.startsWith("7f454c46"); // ELF
  const isMacOS = magic.startsWith("cffaedfe") || magic.startsWith("cefaedfe"); // Mach-O
  const isWindows = magic.startsWith("4d5a"); // PE (MZ)

  if (process.platform === "linux") return isLinux;
  if (process.platform === "darwin") return isMacOS;
  if (process.platform === "win32") return isWindows;

  return false;
}

function rebuildModule(moduleName, cwd) {
  execSync(`${npmCmd} rebuild ${moduleName} --build-from-source`, {
    cwd,
    stdio: "inherit",
    timeout: 180000,
  });
}

function ensureBetterSqlite3(locationName, moduleRoot) {
  if (!pathExists(moduleRoot)) {
    info(`Skipping ${locationName}: better-sqlite3 not present`);
    return;
  }

  const binaryPath = path.join(moduleRoot, "build", "Release", "better_sqlite3.node");
  if (isBinaryValidForPlatform(binaryPath)) {
    info(`better-sqlite3 already valid in ${locationName}`);
    return;
  }

  info(`Rebuilding better-sqlite3 in ${locationName} for ${process.platform}/${process.arch}`);
  try {
    rebuildModule("better-sqlite3", path.dirname(path.dirname(moduleRoot)));
  } catch (error) {
    warn(`Rebuild failed in ${locationName}: ${error.message}`);
    warn("Install will continue. Cursor token auto-import may use fallback mode.");
    return;
  }

  if (isBinaryValidForPlatform(binaryPath)) {
    info(`better-sqlite3 rebuild succeeded in ${locationName}`);
  } else {
    warn(`better-sqlite3 still not valid in ${locationName} after rebuild`);
  }
}

function main() {
  const targets = [
    {
      name: ".next/standalone/node_modules",
      moduleRoot: path.join(standaloneRoot, "node_modules", "better-sqlite3"),
    },
    {
      name: "root node_modules",
      moduleRoot: path.join(pkgRoot, "node_modules", "better-sqlite3"),
    },
  ];

  for (const target of targets) {
    ensureBetterSqlite3(target.name, target.moduleRoot);
  }
}

main();
