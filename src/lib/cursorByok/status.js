import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { getCursorByokCachedPassword } from "./passwordCache";
import {
  CURSOR_BYOK_HOME_DIR,
  CURSOR_BYOK_OWNER,
  CURSOR_BYOK_REF,
  CURSOR_BYOK_REPO,
  CURSOR_BYOK_SOURCE_DIR,
  CURSOR_BYOK_TARBALL_URL,
  CURSOR_EXTENSIONS_DIR,
} from "./constants";

const require = createRequire(import.meta.url);

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(paths) {
  for (const candidate of paths) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

function getCursorCandidates() {
  if (process.platform === "darwin") {
    return [
      "/Applications/Cursor.app",
      path.join(os.homedir(), "Applications", "Cursor.app"),
    ];
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return [path.join(localAppData, "Programs", "cursor", "Cursor.exe")];
  }
  return [
    "/usr/bin/cursor",
    "/usr/local/bin/cursor",
    path.join(os.homedir(), ".local", "bin", "cursor"),
  ];
}

async function detectCursorByokExtension() {
  try {
    const entries = await fs.readdir(CURSOR_EXTENSIONS_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .some((entry) => entry.name.toLowerCase().includes("cursor-byok"));
  } catch {
    return false;
  }
}

async function detectBackupAvailable() {
  const backupDir = path.join(CURSOR_BYOK_HOME_DIR, "workbench-backups");
  try {
    const entries = await fs.readdir(backupDir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function detectHookState() {
  return exists(path.join(CURSOR_BYOK_HOME_DIR, "workbench-hook-state.json"));
}

function checkIsAdmin() {
  if (process.platform !== "win32") return true;
  try {
    return require("../../mitm/dns/dnsConfig").isWindowsAdmin();
  } catch {
    return false;
  }
}

export async function getCursorByokStatus() {
  const [
    cursorPath,
    sourceReady,
    extensionInstalled,
    hookStateExists,
    backupAvailable,
  ] = await Promise.all([
    firstExisting(getCursorCandidates()),
    exists(path.join(CURSOR_BYOK_SOURCE_DIR, "package.json")),
    detectCursorByokExtension(),
    detectHookState(),
    detectBackupAvailable(),
  ]);
  const installed = extensionInstalled || hookStateExists;
  const isWin = process.platform === "win32";

  return {
    installed,
    has9Router: installed,
    cursorDetected: !!cursorPath,
    cursorPath,
    extensionInstalled,
    hookStateExists,
    backupAvailable,
    sourceReady,
    sourceDir: CURSOR_BYOK_SOURCE_DIR,
    repo: {
      owner: CURSOR_BYOK_OWNER,
      name: CURSOR_BYOK_REPO,
      ref: CURSOR_BYOK_REF,
      tarballUrl: CURSOR_BYOK_TARBALL_URL,
    },
    platform: process.platform,
    isWin,
    isAdmin: checkIsAdmin(),
    hasCachedPassword: !!getCursorByokCachedPassword(),
    needsSudoPassword: !isWin,
  };
}
