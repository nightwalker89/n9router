import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function uniquePaths(paths) {
  const seen = new Set();
  return paths.filter((candidate) => {
    if (!candidate) return false;
    const key = path.resolve(candidate).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function getCursorInstallCandidates({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const explicitRoot = env.N9ROUTER_CURSOR_ROOT;
  if (platform === "darwin") {
    return uniquePaths([
      explicitRoot,
      "/Applications/Cursor.app",
      path.join(homeDir, "Applications", "Cursor.app"),
    ]);
  }
  if (platform === "win32") {
    return uniquePaths([
      explicitRoot,
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "cursor"),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Cursor"),
      env.ProgramW6432 && path.join(env.ProgramW6432, "Cursor"),
      env.ProgramFiles && path.join(env.ProgramFiles, "Cursor"),
      env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Cursor"),
    ]);
  }
  return [];
}

export function buildCursorInstallation(root, {
  platform = process.platform,
  env = process.env,
} = {}) {
  if (!root) return null;
  const cursorRoot = path.resolve(root);
  const isMac = platform === "darwin";
  const resourcesRoot = isMac
    ? path.join(cursorRoot, "Contents", "Resources", "app")
    : path.join(cursorRoot, "resources", "app");
  const executable = isMac
    ? path.join(cursorRoot, "Contents", "MacOS", "Cursor")
    : path.join(cursorRoot, "Cursor.exe");
  const localAppData = env.LOCALAPPDATA ? path.resolve(env.LOCALAPPDATA) : null;
  const isUserInstall = platform === "win32" && localAppData
    ? cursorRoot.toLowerCase().startsWith(`${localAppData.toLowerCase()}${path.sep}`)
    : isMac && cursorRoot.startsWith(path.join(os.homedir(), "Applications"));

  return {
    cursorRoot,
    executable,
    resourcesRoot,
    workbench: path.join(resourcesRoot, "out", "vs", "workbench", "workbench.desktop.main.js"),
    extensionHost: path.join(
      resourcesRoot,
      "out",
      "vs",
      "workbench",
      "api",
      "node",
      "extensionHostProcess.js",
    ),
    appExtensions: path.join(resourcesRoot, "extensions"),
    installScope: isUserInstall ? "user" : "system",
  };
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isWritable(targetPath) {
  try {
    await fs.access(targetPath, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCursorInstallation(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const candidates = options.candidates || getCursorInstallCandidates({ ...options, platform, env });
  for (const root of candidates) {
    const installation = buildCursorInstallation(root, { platform, env });
    if (
      await exists(installation.executable) &&
      await exists(installation.workbench)
    ) {
      const extensionHostExists = await exists(installation.extensionHost);
      const appExtensionsWritable = await isWritable(
        await exists(installation.appExtensions)
          ? installation.appExtensions
          : installation.resourcesRoot,
      );
      return {
        ...installation,
        extensionHostExists,
        targetWritable:
          await isWritable(installation.workbench) &&
          (!extensionHostExists || await isWritable(installation.extensionHost)) &&
          appExtensionsWritable,
      };
    }
  }
  return null;
}

export function isWindowsAdmin({
  platform = process.platform,
  spawn = spawnSync,
} = {}) {
  if (platform !== "win32") return false;
  const result = spawn("net.exe", ["session"], {
    windowsHide: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

export function isCursorRunning({
  platform = process.platform,
  spawn = spawnSync,
} = {}) {
  if (platform !== "win32") return false;
  const result = spawn(
    "tasklist.exe",
    ["/FI", "IMAGENAME eq Cursor.exe", "/FO", "CSV", "/NH"],
    { windowsHide: true, encoding: "utf8" },
  );
  return result.status === 0 && /"Cursor\.exe"/i.test(result.stdout || "");
}

export function getNpmInvocation({
  platform = process.platform,
  env = process.env,
} = {}) {
  if (env.npm_execpath && /\.(?:c?js|mjs)$/i.test(env.npm_execpath)) {
    return { command: process.execPath, prefixArgs: [env.npm_execpath] };
  }
  if (platform === "win32") {
    const npmCommand = env.npm_execpath || "npm.cmd";
    return {
      command: env.ComSpec || "cmd.exe",
      prefixArgs: ["/d", "/s", "/c", npmCommand],
    };
  }
  return { command: "npm", prefixArgs: [] };
}

export function getTarInvocation({ platform = process.platform } = {}) {
  return {
    command: platform === "win32" ? "tar.exe" : "tar",
    prefixArgs: [],
  };
}
