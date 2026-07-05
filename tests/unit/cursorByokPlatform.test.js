import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {
  buildCursorInstallation,
  getCursorInstallCandidates,
  getNpmInvocation,
  getTarInvocation,
  isCursorRunning,
  isWindowsAdmin,
  resolveCursorInstallation,
} from "../../src/lib/cursorByok/platform.js";
import { WINDOWS_WORKER_SOURCE } from "../../src/lib/cursorByok/windowsWorkerSource.js";

const tempDirs = [];

async function makeCursorFixture(scope = "user") {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "n9router-cursor-byok-"));
  tempDirs.push(base);
  const localAppData = path.join(base, "LocalAppData");
  const programFiles = path.join(base, "ProgramFiles");
  const root = scope === "user"
    ? path.join(localAppData, "Programs", "cursor")
    : path.join(programFiles, "Cursor");
  const installation = buildCursorInstallation(root, {
    platform: "win32",
    env: { LOCALAPPDATA: localAppData, ProgramFiles: programFiles },
  });
  await fs.mkdir(path.dirname(installation.workbench), { recursive: true });
  await fs.mkdir(path.dirname(installation.extensionHost), { recursive: true });
  await Promise.all([
    fs.writeFile(installation.executable, ""),
    fs.writeFile(installation.workbench, "workbench"),
    fs.writeFile(installation.extensionHost, "extension-host"),
  ]);
  return { base, localAppData, programFiles, root, installation };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Cursor BYOK Windows platform adapter", () => {
  it("orders explicit, user, and system install candidates", () => {
    const candidates = getCursorInstallCandidates({
      platform: "win32",
      homeDir: "C:\\Users\\test",
      env: {
        N9ROUTER_CURSOR_ROOT: "D:\\Apps\\Cursor",
        LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
        ProgramFiles: "C:\\Program Files",
      },
    });

    expect(candidates[0]).toContain("D:\\Apps\\Cursor");
    expect(candidates.some((candidate) => candidate.includes("Programs"))).toBe(true);
    expect(candidates.some((candidate) => candidate.includes("Program Files"))).toBe(true);
  });

  it("extracts candidates from PATH and handles alternative drives on Windows", () => {
    const candidates = getCursorInstallCandidates({
      platform: "win32",
      homeDir: "C:\\Users\\test",
      env: {
        LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
        PATH: [
          "C:\\Windows\\system32",
          "E:\\Users\\test\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin",
          "D:\\Tools\\Cursor\\Resources\\app\\bin",
        ].join(path.delimiter),
      },
    });

    // Should include LOCALAPPDATA path on C:
    expect(candidates).toContain("C:\\Users\\test\\AppData\\Local\\Programs\\cursor");

    // Since we are running the test on whatever current drive path.resolve(".") returns,
    // let's verify drive-fallback exists if path.resolve(".") is not on C:
    const currentDrive = path.resolve(".").slice(0, 2);
    if (currentDrive.toLowerCase() !== "c:") {
      expect(candidates).toContain(`${currentDrive}\\Users\\test\\AppData\\Local\\Programs\\cursor`);
    }

    // Should extract from PATH
    expect(candidates).toContain("E:\\Users\\test\\AppData\\Local\\Programs\\cursor");
    expect(candidates).toContain("D:\\Tools\\Cursor");
  });

  it("resolves a writable Windows user installation", async () => {
    const fixture = await makeCursorFixture("user");
    const resolved = await resolveCursorInstallation({
      platform: "win32",
      env: { LOCALAPPDATA: fixture.localAppData, ProgramFiles: fixture.programFiles },
      candidates: [fixture.root],
    });

    expect(resolved.installScope).toBe("user");
    expect(resolved.targetWritable).toBe(true);
    expect(resolved.workbench).toBe(fixture.installation.workbench);
    expect(resolved.extensionHostExists).toBe(true);
  });

  it("resolves a Windows system installation", async () => {
    const fixture = await makeCursorFixture("system");
    const resolved = await resolveCursorInstallation({
      platform: "win32",
      env: { LOCALAPPDATA: fixture.localAppData, ProgramFiles: fixture.programFiles },
      candidates: [fixture.root],
    });

    expect(resolved.installScope).toBe("system");
    expect(resolved.cursorRoot).toBe(path.resolve(fixture.root));
  });

  it("returns null when required workbench files are absent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "n9router-cursor-missing-"));
    tempDirs.push(root);
    const resolved = await resolveCursorInstallation({
      platform: "win32",
      candidates: [root],
    });
    expect(resolved).toBeNull();
  });

  it("detects Windows admin and running Cursor from command results", () => {
    expect(isWindowsAdmin({
      platform: "win32",
      spawn: () => ({ status: 0 }),
    })).toBe(true);
    expect(isWindowsAdmin({
      platform: "win32",
      spawn: () => ({ status: 2 }),
    })).toBe(false);
    expect(isCursorRunning({
      platform: "win32",
      spawn: () => ({ status: 0, stdout: '"Cursor.exe","1234"' }),
    })).toBe(true);
    expect(isCursorRunning({
      platform: "win32",
      spawn: () => ({ status: 0, stdout: "INFO: No tasks are running" }),
    })).toBe(false);
  });

  it("uses Windows command names without enabling a shell", () => {
    expect(getNpmInvocation({
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    })).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      prefixArgs: ["/d", "/s", "/c", "npm.cmd"],
    });
    expect(getTarInvocation({ platform: "win32" }).command).toBe("tar.exe");
  });

  it("runs a Windows npm cmd wrapper through cmd.exe", () => {
    expect(getNpmInvocation({
      platform: "win32",
      env: {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        npm_execpath: "C:\\Program Files\\nodejs\\npm.cmd",
      },
    })).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      prefixArgs: ["/d", "/s", "/c", "C:\\Program Files\\nodejs\\npm.cmd"],
    });
  });

  it("produces a syntactically valid Windows worker", () => {
    expect(() => new vm.Script(WINDOWS_WORKER_SOURCE)).not.toThrow();
  });
});
