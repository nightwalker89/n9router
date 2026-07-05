import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { WINDOWS_WORKER_SOURCE } from "../../src/lib/cursorByok/windowsWorkerSource.js";

const tempDirs = [];

async function writeFile(targetPath, content) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf8");
}

async function runWorker(root, request, suffix) {
  const workerPath = path.join(root, "windows-worker.cjs");
  const requestPath = path.join(root, `request-${suffix}.json`);
  const resultPath = path.join(root, `result-${suffix}.json`);
  const logPath = path.join(root, `log-${suffix}.txt`);
  await Promise.all([
    writeFile(workerPath, WINDOWS_WORKER_SOURCE),
    writeFile(requestPath, JSON.stringify(request)),
    writeFile(logPath, ""),
  ]);
  const processResult = spawnSync(
    process.execPath,
    [workerPath, requestPath, resultPath, logPath],
    { encoding: "utf8" },
  );
  const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  return { processResult, result };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Cursor BYOK Windows worker", () => {
  it("installs with explicit targets and restores before uninstalling", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "n9router-windows-worker-"));
    tempDirs.push(root);
    const sourceDir = path.join(root, "source");
    const cursorRoot = path.join(root, "Cursor");
    const resourcesRoot = path.join(cursorRoot, "resources", "app");
    const workbench = path.join(resourcesRoot, "out", "vs", "workbench", "workbench.desktop.main.js");
    const extensionHost = path.join(resourcesRoot, "out", "vs", "workbench", "api", "node", "extensionHostProcess.js");
    const appExtensions = path.join(resourcesRoot, "extensions");
    const extensionsDir = path.join(root, ".cursor", "extensions");
    const byokHomeDir = path.join(root, ".cursor-byok");
    const expectedExtensionRoot = path.join(extensionsDir, "starduster.cursor-byok-1.0.0");
    const fakeNpmPath = path.join(root, "fake-npm.cjs");

    await Promise.all([
      writeFile(path.join(sourceDir, "package.json"), JSON.stringify({
        publisher: "starduster",
        name: "cursor-byok",
        version: "1.0.0",
      })),
      writeFile(path.join(sourceDir, "src", "extension.js"), "module.exports = {};"),
      writeFile(workbench, "pristine"),
      writeFile(extensionHost, "pristine-extension-host"),
      writeFile(fakeNpmPath, "process.exit(0);"),
      writeFile(path.join(sourceDir, "scripts", "install-cursor.js"), `
        const fs = require("node:fs");
        const path = require("node:path");
        function copyTree(src, dst) { fs.cpSync(src, dst, { recursive: true }); }
        function refreshRegistry(extensionRoot, pkg) {
          const registry = path.join(path.dirname(extensionRoot), "extensions.json");
          fs.writeFileSync(registry, JSON.stringify([{ identifier: { id: pkg.publisher + "." + pkg.name } }]));
        }
        module.exports = {
          copyTree,
          refreshRegistry,
          removeLegacyExtensions() {},
          removeLegacyAppExtensions() {},
          shouldCopy() { return true; },
        };
      `),
      writeFile(path.join(sourceDir, "scripts", "install-workbench-hook.js"), `
        const fs = require("node:fs");
        module.exports = {
          installWorkbenchHook({ workbench }) {
            fs.writeFileSync(workbench, "patched");
            return { workbench };
          },
          restoreWorkbenchHook({ workbench }) {
            fs.writeFileSync(workbench, "restored");
            return { restoredFiles: [workbench] };
          },
        };
      `),
    ]);

    const baseRequest = {
      sourceDir,
      extensionsDir,
      expectedExtensionRoot,
      byokHomeDir,
      npmInvocation: { command: process.execPath, prefixArgs: [fakeNpmPath] },
      installation: {
        cursorRoot,
        workbench,
        extensionHost,
        appExtensions,
      },
    };

    const installed = await runWorker(root, { ...baseRequest, action: "install" }, "install");
    expect(installed.processResult.status).toBe(0);
    expect(installed.result.ok).toBe(true);
    expect(await fs.readFile(workbench, "utf8")).toBe("patched");
    expect(await fs.readFile(path.join(expectedExtensionRoot, "package.json"), "utf8")).toContain("cursor-byok");

    await writeFile(path.join(byokHomeDir, "workbench-hook-state.json"), "{}");
    const uninstalled = await runWorker(root, { ...baseRequest, action: "uninstall" }, "uninstall");
    expect(uninstalled.processResult.status).toBe(0);
    expect(uninstalled.result.ok).toBe(true);
    expect(await fs.readFile(workbench, "utf8")).toBe("restored");
    await expect(fs.access(expectedExtensionRoot)).rejects.toThrow();
    await expect(fs.access(path.join(byokHomeDir, "workbench-hook-state.json"))).rejects.toThrow();
  });
});
