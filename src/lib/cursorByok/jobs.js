import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  CURSOR_BYOK_ACTIONS,
  CURSOR_BYOK_REF,
  CURSOR_BYOK_ROOT,
  CURSOR_BYOK_SOURCE_DIR,
  CURSOR_BYOK_TARBALL_PATH,
  CURSOR_BYOK_TARBALL_URL,
  CURSOR_EXTENSIONS_DIR,
} from "./constants";
import {
  getCursorByokCachedPassword,
  setCursorByokCachedPassword,
} from "./passwordCache";
import {
  getNpmInvocation,
  getTarInvocation,
  isCursorRunning,
  isWindowsAdmin,
  resolveCursorInstallation,
} from "./platform";
import { runWindowsCursorAction } from "./windowsRunner";
import { getCursorByokRestoreState } from "./restoreState";
import {
  validateMacRestoreBackups,
  verifyMacCursorCodeSignature,
} from "./macSignature";

const STORE_KEY = "__n9routerCursorByokJobs";

function getStore() {
  if (!globalThis[STORE_KEY]) {
    globalThis[STORE_KEY] = {
      jobs: new Map(),
      listeners: new Map(),
    };
  }
  return globalThis[STORE_KEY];
}

function makeSteps(action) {
  const steps = [
    { id: "download", label: "Download pinned cursor-byok tarball", status: "pending" },
    { id: "dependencies", label: "Install package dependencies", status: "pending" },
  ];
  if (action === "prepare" || action === "install") {
    steps.push({ id: "preflight", label: "Run Cursor preflight check", status: "pending" });
  }
  if (action !== "prepare") {
    steps.push({ id: "permission", label: "Confirm system permission", status: "pending" });
  }
  if (action === "install") {
    steps.push({ id: "install", label: "Install Cursor BYOK extension", status: "pending" });
  }
  if (action === "restore") {
    steps.push({ id: "restore", label: "Restore original Cursor files from backup", status: "pending" });
  }
  return steps;
}

function toPublicJob(job) {
  return {
    id: job.id,
    action: job.action,
    status: job.status,
    error: job.error,
    logs: job.logs.slice(-300),
    steps: job.steps,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function updateStep(job, id, status, detail) {
  job.steps = job.steps.map((step) => (
    step.id === id ? { ...step, status, detail: detail || step.detail } : step
  ));
  touch(job);
}

function touch(job) {
  job.updatedAt = new Date().toISOString();
}

function appendLog(job, message, stream = "info") {
  const text = String(message || "")
    .replace(/sudoPassword["']?\s*[:=]\s*["'][^"']+["']/gi, 'sudoPassword:"[redacted]"')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[redacted]");
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    job.logs.push({ ts: new Date().toISOString(), stream, message: line });
  }
  if (job.logs.length > 500) {
    job.logs = job.logs.slice(-500);
  }
  touch(job);
  emitJob(job);
}

function emitJob(job) {
  const store = getStore();
  const listeners = store.listeners.get(job.id);
  if (!listeners) return;
  const payload = `data: ${JSON.stringify(toPublicJob(job))}\n\n`;
  for (const listener of listeners) {
    listener(payload);
  }
}

function completeJob(job, status, error = null) {
  job.status = status;
  job.error = error;
  touch(job);
  emitJob(job);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function downloadFile(url, targetPath) {
  await fs.mkdir(CURSOR_BYOK_ROOT, { recursive: true });
  await new Promise((resolve, reject) => {
    const file = createWriteStream(targetPath);
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlink(targetPath).catch(() => {});
        downloadFile(response.headers.location, targetPath).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(targetPath).catch(() => {});
        reject(new Error(`Download failed with HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (error) => {
      file.close();
      fs.unlink(targetPath).catch(() => {});
      reject(error);
    });
  });
}

function runCommand(job, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const displayedArgs = options.displayArgs || args;
    appendLog(job, `$ ${[command, ...displayedArgs].join(" ")}`);
    const child = spawn(command, args, {
      cwd: options.cwd || CURSOR_BYOK_SOURCE_DIR,
      env: { ...process.env, ...(options.env || {}) },
      shell: false,
    });
    let stderr = "";

    if (options.stdin) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }

    child.stdout.on("data", (data) => appendLog(job, data.toString(), "stdout"));
    child.stderr.on("data", (data) => {
      stderr += data.toString();
      appendLog(job, data.toString(), "stderr");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
      }
    });
  });
}

function runInvocation(job, invocation, args, options = {}) {
  return runCommand(
    job,
    invocation.command,
    [...invocation.prefixArgs, ...args],
    options,
  );
}

async function ensureSource(job) {
  updateStep(job, "download", "running");
  if (await pathExists(path.join(CURSOR_BYOK_SOURCE_DIR, "package.json"))) {
    appendLog(job, `Using cached cursor-byok source at ${CURSOR_BYOK_SOURCE_DIR}`);
    updateStep(job, "download", "success", CURSOR_BYOK_REF.slice(0, 12));
    return;
  }

  appendLog(job, `Downloading ${CURSOR_BYOK_TARBALL_URL}`);
  await fs.rm(CURSOR_BYOK_SOURCE_DIR, { recursive: true, force: true });
  await downloadFile(CURSOR_BYOK_TARBALL_URL, CURSOR_BYOK_TARBALL_PATH);
  await fs.mkdir(CURSOR_BYOK_SOURCE_DIR, { recursive: true });
  await runInvocation(
    job,
    getTarInvocation(),
    ["-xzf", CURSOR_BYOK_TARBALL_PATH, "-C", CURSOR_BYOK_SOURCE_DIR, "--strip-components=1"],
    { cwd: CURSOR_BYOK_ROOT },
  );
  if (!(await pathExists(path.join(CURSOR_BYOK_SOURCE_DIR, "package.json")))) {
    throw new Error("Downloaded cursor-byok archive did not contain package.json");
  }
  updateStep(job, "download", "success", CURSOR_BYOK_REF.slice(0, 12));
}

async function verifySourcePackage() {
  const packagePath = path.join(CURSOR_BYOK_SOURCE_DIR, "package.json");
  const pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));
  if (pkg.publisher !== "starduster" || pkg.name !== "cursor-byok") {
    throw new Error("Downloaded package identity does not match starduster.cursor-byok");
  }
  for (const relativePath of [
    path.join("scripts", "install-cursor.js"),
    path.join("scripts", "install-workbench-hook.js"),
  ]) {
    if (!(await pathExists(path.join(CURSOR_BYOK_SOURCE_DIR, relativePath)))) {
      throw new Error(`Downloaded cursor-byok source is missing ${relativePath}`);
    }
  }
}

async function installDependencies(job) {
  updateStep(job, "dependencies", "running");
  const npm = getNpmInvocation();
  try {
    await runInvocation(job, npm, ["ci", "--ignore-scripts"], { cwd: CURSOR_BYOK_SOURCE_DIR });
  } catch (error) {
    appendLog(job, `npm ci failed, retrying with npm install: ${error.message}`, "stderr");
    await runInvocation(job, npm, ["install", "--ignore-scripts"], { cwd: CURSOR_BYOK_SOURCE_DIR });
  }
  updateStep(job, "dependencies", "success");
}

async function runPreflight(job, installation) {
  updateStep(job, "preflight", "running");
  if (process.platform === "win32") {
    await runCommand(
      job,
      process.execPath,
      [path.join(CURSOR_BYOK_SOURCE_DIR, "scripts", "install-workbench-hook.js"), "--dry-run"],
      {
        cwd: CURSOR_BYOK_SOURCE_DIR,
        env: {
          CURSOR_WORKBENCH: installation.workbench,
          CURSOR_EXT_HOST: installation.extensionHost,
        },
      },
    );
  } else {
    await runInvocation(
      job,
      getNpmInvocation(),
      ["run", "preflight:cursor"],
      { cwd: CURSOR_BYOK_SOURCE_DIR },
    );
  }
  updateStep(job, "preflight", "success");
}

function waitForSudo(job) {
  const cached = getCursorByokCachedPassword();
  if (cached) {
    updateStep(job, "permission", "success", "Using cached password for this session");
    return Promise.resolve(cached);
  }

  updateStep(job, "permission", "waiting", "Waiting for sudo password");
  job.status = "waiting_sudo";
  emitJob(job);
  return new Promise((resolve) => {
    job.sudoResolver = resolve;
  });
}

function runPrivilegedNpm(job, script, password) {
  const command = `sudo -S -p "" env HOME="$HOME" PATH="$PATH" npm run ${script}`;
  return runCommand(job, "sh", ["-c", command], {
    cwd: CURSOR_BYOK_SOURCE_DIR,
    stdin: `${password}\n`,
  });
}

async function runPrivilegedScript(job, stepId, script, password) {
  updateStep(job, stepId, "running");
  job.status = "running";
  emitJob(job);
  await runPrivilegedNpm(job, script, password);
  if (password) setCursorByokCachedPassword(password);
  updateStep(job, stepId, "success");
}

async function runWindowsAction(job, installation) {
  if (isCursorRunning()) {
    const error = new Error("Cursor is running. Fully quit Cursor, including background processes, and retry.");
    error.code = "CURSOR_RUNNING";
    throw error;
  }

  const needsElevation = !installation.targetWritable && !isWindowsAdmin();
  const primaryStep = job.action === "install" ? "install" : "restore";
  updateStep(
    job,
    "permission",
    needsElevation ? "waiting" : "success",
    needsElevation ? "Waiting for Windows UAC confirmation" : "Target is writable without elevation",
  );
  updateStep(job, primaryStep, "running");
  emitJob(job);

  await runWindowsCursorAction({
    jobId: job.id,
    action: job.action,
    sourceDir: CURSOR_BYOK_SOURCE_DIR,
    installation,
    extensionsDir: CURSOR_EXTENSIONS_DIR,
    npmInvocation: getNpmInvocation(),
    needsElevation,
    onLog: (message) => appendLog(job, message, "stdout"),
    onUacRequested: () => {
      job.status = "waiting_uac";
      updateStep(job, "permission", "waiting", "Approve the Windows UAC dialog");
      emitJob(job);
    },
    onElevatedStart: () => {
      job.status = "running_elevated";
      updateStep(job, "permission", "success", "Windows administrator approval granted");
      emitJob(job);
    },
  });

  updateStep(job, "permission", "success");
  updateStep(job, primaryStep, "success");
}

async function runJob(job) {
  try {
    job.status = "running";
    emitJob(job);
    const installation = await resolveCursorInstallation();
    if (!installation) {
      throw new Error("Cursor installation or required workbench files were not found");
    }
    let restoreState = null;
    if (job.action === "restore") {
      restoreState = await getCursorByokRestoreState();
      if (!restoreState.restoreAvailable) {
        const message = `Restore unavailable: ${restoreState.restoreReason}. Backup files alone cannot be safely restored without their target mapping.`;
        updateStep(job, "restore", "error", message);
        const error = new Error(message);
        error.code = "RESTORE_STATE_UNAVAILABLE";
        throw error;
      }
    }
    if (process.platform === "darwin") {
      if (job.action === "restore") {
        await validateMacRestoreBackups(installation, restoreState);
      } else if (job.action === "install") {
        const installRestoreState = await getCursorByokRestoreState();
        try {
          verifyMacCursorCodeSignature(installation);
        } catch (signatureError) {
          if (!installRestoreState.restoreAvailable) throw signatureError;
          await validateMacRestoreBackups(installation, installRestoreState);
        }
      }
    }
    await ensureSource(job);
    await verifySourcePackage();
    await installDependencies(job);
    if (job.action === "prepare" || job.action === "install") {
      await runPreflight(job, installation);
    }

    if (job.action === "prepare") {
      completeJob(job, "success");
      return;
    }

    if (process.platform === "win32") {
      await runWindowsAction(job, installation);
    } else {
      const password = await waitForSudo(job);
      if (job.action === "install") {
        await runPrivilegedScript(job, "install", "install:cursor", password);
      } else {
        await runPrivilegedScript(job, "restore", "restore:cursor", password);
        verifyMacCursorCodeSignature(installation);
      }
    }
    completeJob(job, "success");
  } catch (error) {
    const message = error?.message || "Cursor BYOK job failed";
    appendLog(job, message, "stderr");
    for (const step of job.steps) {
      if (step.status === "running" || step.status === "waiting") {
        updateStep(job, step.id, "error", message);
      }
    }
    completeJob(job, "error", message);
  }
}

export function createCursorByokJob(action) {
  if (!CURSOR_BYOK_ACTIONS.has(action)) {
    throw new Error("Unsupported Cursor BYOK action");
  }

  const store = getStore();
  const activeJob = Array.from(store.jobs.values()).find((candidate) => (
    candidate.status === "queued" ||
    candidate.status === "running" ||
    candidate.status === "waiting_sudo"
  ));
  if (activeJob) {
    const error = new Error(`Cursor BYOK job already running: ${activeJob.id}`);
    error.statusCode = 409;
    throw error;
  }

  const job = {
    id: randomUUID(),
    action,
    status: "queued",
    error: null,
    logs: [],
    steps: makeSteps(action),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sudoResolver: null,
  };
  store.jobs.set(job.id, job);
  queueMicrotask(() => runJob(job));
  return toPublicJob(job);
}

export function getCursorByokJob(jobId) {
  const job = getStore().jobs.get(jobId);
  return job ? toPublicJob(job) : null;
}

export function subscribeCursorByokJob(jobId, send) {
  const store = getStore();
  const job = store.jobs.get(jobId);
  if (!job) return null;
  if (!store.listeners.has(jobId)) store.listeners.set(jobId, new Set());
  const listeners = store.listeners.get(jobId);
  listeners.add(send);
  send(`data: ${JSON.stringify(toPublicJob(job))}\n\n`);
  return () => {
    listeners.delete(send);
    if (listeners.size === 0) store.listeners.delete(jobId);
  };
}

export function provideCursorByokSudo(jobId, password) {
  const job = getStore().jobs.get(jobId);
  if (!job) {
    const error = new Error("Cursor BYOK job not found");
    error.statusCode = 404;
    throw error;
  }
  if (job.status !== "waiting_sudo" || !job.sudoResolver) {
    const error = new Error("Cursor BYOK job is not waiting for sudo password");
    error.statusCode = 409;
    throw error;
  }
  if (!password || !String(password).trim()) {
    const error = new Error("Sudo password is required");
    error.statusCode = 400;
    throw error;
  }
  const resolver = job.sudoResolver;
  job.sudoResolver = null;
  updateStep(job, "permission", "success", "Password received");
  job.status = "running";
  emitJob(job);
  resolver(String(password));
  return toPublicJob(job);
}
