import fs from "node:fs/promises";
import path from "node:path";
import { getCursorByokCachedPassword } from "./passwordCache";
import {
  isCursorRunning,
  isWindowsAdmin,
  resolveCursorInstallation,
} from "./platform";
import { getCursorByokRestoreState } from "./restoreState";
import {
  CURSOR_BYOK_OWNER,
  CURSOR_BYOK_REF,
  CURSOR_BYOK_REPO,
  CURSOR_BYOK_SOURCE_DIR,
  CURSOR_BYOK_TARBALL_URL,
  CURSOR_EXTENSIONS_DIR,
} from "./constants";

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
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

export async function getCursorByokStatus() {
  const installationPromise = resolveCursorInstallation();
  const [
    installation,
    sourceReady,
    extensionInstalled,
    restoreState,
  ] = await Promise.all([
    installationPromise,
    exists(path.join(CURSOR_BYOK_SOURCE_DIR, "package.json")),
    detectCursorByokExtension(),
    getCursorByokRestoreState(),
  ]);
  const hookStateExists = restoreState.stateExists;
  const installed = extensionInstalled || hookStateExists;
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const platformSupported = isWin || isMac;
  const isAdmin = isWin ? isWindowsAdmin() : true;
  const cursorRunning = isWin ? isCursorRunning() : false;
  const needsUac = isWin && !!installation && !installation.targetWritable && !isAdmin;

  return {
    installed,
    has9Router: installed,
    cursorDetected: !!installation,
    cursorPath: installation?.executable || null,
    cursorRoot: installation?.cursorRoot || null,
    installScope: installation?.installScope || null,
    targetWritable: installation?.targetWritable ?? false,
    cursorRunning,
    platformSupported,
    supportReason: platformSupported
      ? null
      : "Cursor BYOK installer currently supports native macOS and Windows only",
    needsUac,
    targets: installation ? {
      workbench: installation.workbench,
      extensionHost: installation.extensionHost,
    } : null,
    extensionInstalled,
    hookStateExists,
    backupAvailable: restoreState.restoreAvailable,
    backupFilesAvailable: restoreState.backupFilesAvailable,
    restoreAvailable: restoreState.restoreAvailable,
    restoreStateMissing: restoreState.restoreStateMissing,
    restoreReason: restoreState.restoreReason,
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
    isAdmin,
    hasCachedPassword: !!getCursorByokCachedPassword(),
    needsSudoPassword: isMac,
  };
}
