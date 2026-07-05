import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getCursorByokRestoreState } from "../../src/lib/cursorByok/restoreState.js";
import { CURSOR_BYOK_ACTIONS } from "../../src/lib/cursorByok/constants.js";

const tempDirs = [];

async function makeHome() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "n9router-cursor-restore-"));
  tempDirs.push(homeDir);
  return homeDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Cursor BYOK restore state", () => {
  it("does not expose a combined uninstall action", () => {
    expect(CURSOR_BYOK_ACTIONS.has("uninstall")).toBe(false);
  });

  it("does not treat orphaned backup files as restorable", async () => {
    const homeDir = await makeHome();
    const backupDir = path.join(homeDir, "workbench-backups");
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, "workbench.desktop.main.js.hash.orig"), "backup");

    const state = await getCursorByokRestoreState({ byokHomeDir: homeDir });

    expect(state.backupFilesAvailable).toBe(true);
    expect(state.stateExists).toBe(false);
    expect(state.restoreAvailable).toBe(false);
    expect(state.restoreStateMissing).toBe(true);
    expect(state.restoreReason).toContain("mapping state");
  });

  it("requires at least one mapped backup file to exist", async () => {
    const homeDir = await makeHome();
    const statePath = path.join(homeDir, "workbench-hook-state.json");
    await fs.writeFile(statePath, JSON.stringify({
      workbench: {
        targetPath: "/Applications/Cursor.app/workbench.js",
        backupPath: path.join(homeDir, "workbench-backups", "missing.orig"),
      },
    }));

    const state = await getCursorByokRestoreState({ byokHomeDir: homeDir });

    expect(state.stateExists).toBe(true);
    expect(state.restoreAvailable).toBe(false);
    expect(state.restoreReason).toContain("mapped backup files");
  });

  it("allows restore when state maps to an existing backup", async () => {
    const homeDir = await makeHome();
    const backupPath = path.join(homeDir, "workbench-backups", "workbench.orig");
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.writeFile(backupPath, "backup");
    await fs.writeFile(path.join(homeDir, "workbench-hook-state.json"), JSON.stringify({
      workbench: {
        targetPath: "/Applications/Cursor.app/workbench.js",
        backupPath,
      },
    }));

    const state = await getCursorByokRestoreState({ byokHomeDir: homeDir });

    expect(state.restoreAvailable).toBe(true);
    expect(state.mappedBackupCount).toBe(1);
    expect(state.restoreReason).toBeNull();
  });
});
