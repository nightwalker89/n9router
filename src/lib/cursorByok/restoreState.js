import fs from "node:fs/promises";
import path from "node:path";
import { CURSOR_BYOK_HOME_DIR } from "./constants";

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function getCursorByokRestoreState({
  byokHomeDir = CURSOR_BYOK_HOME_DIR,
} = {}) {
  const statePath = path.join(byokHomeDir, "workbench-hook-state.json");
  const backupDir = path.join(byokHomeDir, "workbench-backups");
  let backupFileCount = 0;
  try {
    const entries = await fs.readdir(backupDir, { withFileTypes: true });
    backupFileCount = entries.filter((entry) => entry.isFile()).length;
  } catch {
    backupFileCount = 0;
  }

  const stateExists = await exists(statePath);
  let state = null;
  let stateParseError = null;
  if (stateExists) {
    try {
      state = JSON.parse(await fs.readFile(statePath, "utf8"));
    } catch (error) {
      stateParseError = error?.message || "Invalid JSON";
    }
  }

  const mappedEntries = [state?.workbench, state?.extHost]
    .filter((entry) => typeof entry?.backupPath === "string" && entry.backupPath);
  const mappedBackups = [];
  for (const entry of mappedEntries) {
    mappedBackups.push({
      targetPath: entry.targetPath,
      backupPath: entry.backupPath,
      exists: await exists(entry.backupPath),
    });
  }
  const mappedBackupCount = mappedBackups.filter((entry) => entry.exists).length;

  const backupFilesAvailable = backupFileCount > 0;
  const restoreAvailable = !stateParseError && mappedBackupCount > 0;
  let restoreReason = null;
  if (!restoreAvailable) {
    if (!stateExists && backupFilesAvailable) {
      restoreReason = "Backup files exist, but the saved restore mapping state is missing";
    } else if (stateParseError) {
      restoreReason = `Saved restore mapping state is invalid: ${stateParseError}`;
    } else if (stateExists && mappedEntries.length === 0) {
      restoreReason = "Saved restore mapping state does not contain backup entries";
    } else if (stateExists && mappedBackupCount === 0) {
      restoreReason = "Saved restore mapping state points to missing mapped backup files";
    } else {
      restoreReason = "No saved Cursor workbench backup is available";
    }
  }

  return {
    statePath,
    backupDir,
    stateExists,
    backupFileCount,
    backupFilesAvailable,
    mappedBackupCount,
    mappedBackups,
    restoreAvailable,
    restoreStateMissing: backupFilesAvailable && !stateExists,
    restoreReason,
  };
}
