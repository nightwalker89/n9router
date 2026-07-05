export const WINDOWS_WORKER_SOURCE = String.raw`
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const [requestPath, resultPath, logPath] = process.argv.slice(2);

function log(message) {
  fs.appendFileSync(logPath, String(message) + "\n", "utf8");
}

function fail(message, code = "WINDOWS_ACTION_FAILED") {
  fs.writeFileSync(resultPath, JSON.stringify({ ok: false, code, error: String(message) }), "utf8");
  process.exitCode = 1;
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertInside(root, target, label) {
  if (!isInside(root, target)) throw new Error(label + " is outside the validated root");
}

function cursorIsRunning() {
  const result = spawnSync(
    "tasklist.exe",
    ["/FI", "IMAGENAME eq Cursor.exe", "/FO", "CSV", "/NH"],
    { windowsHide: true, encoding: "utf8" },
  );
  return result.status === 0 && /"Cursor\.exe"/i.test(result.stdout || "");
}

function runNpm(invocation, args, cwd) {
  const result = spawnSync(
    invocation.command,
    [...invocation.prefixArgs, ...args],
    { cwd, windowsHide: true, encoding: "utf8" },
  );
  if (result.stdout) log(result.stdout.trim());
  if (result.stderr) log(result.stderr.trim());
  if (result.status !== 0) {
    throw new Error("npm failed with exit code " + result.status);
  }
}

try {
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  if (!["install", "restore"].includes(request.action)) {
    throw new Error("Unsupported Windows Cursor BYOK action");
  }
  for (const [label, target] of [
    ["workbench", request.installation.workbench],
    ["extension host", request.installation.extensionHost],
    ["app extensions", request.installation.appExtensions],
  ]) {
    assertInside(request.installation.cursorRoot, target, label);
  }
  assertInside(request.extensionsDir, request.expectedExtensionRoot, "extension root");
  if (cursorIsRunning()) {
    const error = new Error("Cursor is running. Fully quit Cursor and retry.");
    error.code = "CURSOR_RUNNING";
    throw error;
  }
  log("Starting Cursor BYOK Windows action: " + request.action);

  const packagePath = path.join(request.sourceDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  if (pkg.publisher !== "starduster" || pkg.name !== "cursor-byok") {
    throw new Error("Downloaded package identity does not match starduster.cursor-byok");
  }

  const hook = require(path.join(request.sourceDir, "scripts", "install-workbench-hook.js"));
  let result;
  if (request.action === "install") {
    const installer = require(path.join(request.sourceDir, "scripts", "install-cursor.js"));
    installer.removeLegacyExtensions(request.extensionsDir);
    installer.removeLegacyAppExtensions(request.installation.appExtensions);
    fs.rmSync(request.expectedExtensionRoot, { recursive: true, force: true });
    installer.copyTree(
      request.sourceDir,
      request.expectedExtensionRoot,
      installer.shouldCopy,
    );
    runNpm(
      request.npmInvocation,
      ["install", "--omit=dev", "--ignore-scripts"],
      request.expectedExtensionRoot,
    );
    installer.refreshRegistry(request.expectedExtensionRoot, pkg);
    result = hook.installWorkbenchHook({
      workbench: request.installation.workbench,
      extHost: request.installation.extensionHost,
    });
    log("Cursor BYOK extension and workbench hook installed");
  } else {
    result = hook.restoreWorkbenchHook({
      workbench: request.installation.workbench,
      extHost: request.installation.extensionHost,
    });
    log("Original Cursor files restored from backup");
  }

  fs.writeFileSync(resultPath, JSON.stringify({ ok: true, result }), "utf8");
} catch (error) {
  log(error?.stack || error?.message || error);
  fail(error?.message || error, error?.code || "WINDOWS_ACTION_FAILED");
}
`;
