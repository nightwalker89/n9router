import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { CURSOR_BYOK_ROOT } from "./constants";
import { WINDOWS_WORKER_SOURCE } from "./windowsWorkerSource";

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function startLogMonitor(logPath, onLog, onFirstLog) {
  let offset = 0;
  let firstLogSent = false;
  let reading = false;
  const readNewContent = async () => {
    if (reading) return;
    reading = true;
    try {
      const content = await fs.readFile(logPath, "utf8");
      if (content.length > offset) {
        const next = content.slice(offset);
        offset = content.length;
        if (!firstLogSent) {
          firstLogSent = true;
          onFirstLog?.();
        }
        onLog?.(next);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    } finally {
      reading = false;
    }
  };
  const timer = setInterval(() => {
    readNewContent().catch(() => {});
  }, 250);
  return async () => {
    clearInterval(timer);
    await readNewContent();
  };
}

async function launchElevatedWorker(workerPath, requestPath, resultPath, logPath) {
  const elevatedScript = [
    `& ${quotePowerShell(process.execPath)}`,
    quotePowerShell(workerPath),
    quotePowerShell(requestPath),
    quotePowerShell(resultPath),
    quotePowerShell(logPath),
  ].join(" ") + "; exit $LASTEXITCODE";
  const encodedElevated = encodePowerShell(elevatedScript);
  const wrapper = `
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
      '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
      '-EncodedCommand','${encodedElevated}'
    ) -Verb RunAs -Wait -PassThru -WindowStyle Hidden
    exit $process.ExitCode
  `;
  return runProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(wrapper)],
  );
}

export async function runWindowsCursorAction({
  jobId,
  action,
  sourceDir,
  installation,
  extensionsDir,
  npmInvocation,
  needsElevation,
  onLog,
  onUacRequested,
  onElevatedStart,
}) {
  if (process.platform !== "win32") {
    throw new Error("Windows Cursor runner can only run on Windows");
  }
  const jobDir = path.join(CURSOR_BYOK_ROOT, "jobs", jobId);
  const workerPath = path.join(jobDir, "windows-worker.cjs");
  const requestPath = path.join(jobDir, "request.json");
  const resultPath = path.join(jobDir, "result.json");
  const logPath = path.join(jobDir, "windows.log");
  const pkg = JSON.parse(await fs.readFile(path.join(sourceDir, "package.json"), "utf8"));
  const expectedExtensionRoot = path.join(
    extensionsDir,
    `${pkg.publisher}.${pkg.name}-${pkg.version}`,
  );
  const request = {
    action,
    sourceDir,
    installation,
    extensionsDir,
    expectedExtensionRoot,
    npmInvocation,
  };

  await fs.mkdir(jobDir, { recursive: true });
  await Promise.all([
    fs.writeFile(workerPath, WINDOWS_WORKER_SOURCE, { mode: 0o700 }),
    fs.writeFile(requestPath, JSON.stringify(request), { mode: 0o600 }),
    fs.writeFile(logPath, "", { mode: 0o600 }),
  ]);

  const stopMonitor = await startLogMonitor(
    logPath,
    onLog,
    needsElevation ? onElevatedStart : null,
  );
  let processResult;
  try {
    if (needsElevation) {
      onUacRequested?.();
      processResult = await launchElevatedWorker(workerPath, requestPath, resultPath, logPath);
    } else {
      processResult = await runProcess(
        process.execPath,
        [workerPath, requestPath, resultPath, logPath],
        { cwd: jobDir },
      );
    }
  } finally {
    await stopMonitor();
    await Promise.allSettled([
      fs.rm(workerPath, { force: true }),
      fs.rm(requestPath, { force: true }),
    ]);
  }

  let result;
  try {
    result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  } catch {
    const detail = processResult?.stderr?.trim() || processResult?.stdout?.trim();
    const canceled = /canceled|cancelled|1223/i.test(detail || "");
    const error = new Error(canceled ? "User canceled Windows UAC confirmation" : (detail || "Elevated Cursor BYOK action failed"));
    error.code = canceled ? "UAC_CANCELED" : "WINDOWS_ACTION_FAILED";
    throw error;
  }
  if (!result.ok) {
    const error = new Error(result.error || "Windows Cursor BYOK action failed");
    error.code = result.code || "WINDOWS_ACTION_FAILED";
    throw error;
  }
  return result.result;
}
