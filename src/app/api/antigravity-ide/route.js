import { execSync, spawn } from "child_process";
import os from "os";
import fs from "fs";
import path from "path";

const PLATFORM = os.platform();

// Antigravity IDE — CLI commands tried via `which`, in priority order
const CLI_COMMANDS = {
  darwin: ["antigravity", "agy"],
  win32: ["antigravity.cmd", "agy.cmd", "antigravity", "agy"],
  linux: ["antigravity", "agy"],
};

// Antigravity IDE — known install paths (checked BEFORE `which` for correct binary)
const INSTALL_PATHS = {
  darwin: [
    "/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity",
  ],
  win32: [
    "%LOCALAPPDATA%\\Programs\\Antigravity\\resources\\app\\bin\\antigravity.cmd",
    "%LOCALAPPDATA%\\Programs\\Antigravity\\Antigravity.exe",
    "%ProgramFiles%\\Antigravity\\Antigravity.exe",
  ],
  linux: [],
};

// Process detection terms
const PROCESS_SEARCH = {
  darwin: ["Antigravity.app", "AGY.app"],
  win32: ["Antigravity.exe", "AGY.exe"],
  linux: ["antigravity", "agy"],
};

// Debug port range for --remote-debugging-port
const DEBUG_PORT_START = 9400;
const DEBUG_PORT_END = 9499;

/**
 * Check if a port is in use by querying for PIDs listening on it.
 */
function isPortInUse(port) {
  try {
    if (PLATFORM === "win32") {
      const output = execSync(`netstat -ano -p tcp | findstr :${port}`, { encoding: "utf8", stdio: "pipe", timeout: 5000 });
      for (const line of output.split("\n").map(l => l.trim()).filter(Boolean)) {
        const parts = line.split(/\s+/);
        if (parts.length < 5) continue;
        const localAddress = parts[1] || "";
        const pid = parts[parts.length - 1] || "";
        if (localAddress.endsWith(`:${port}`) && /^\d+$/.test(pid) && pid !== "0") return true;
      }
      return false;
    }
    const output = execSync(`lsof -ti :${port}`, { encoding: "utf8", stdio: "pipe", timeout: 5000 }).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

/**
 * Find a free port in the given range. Tries random ports first, then sweeps sequentially.
 */
function findFreePort(start = DEBUG_PORT_START, end = DEBUG_PORT_END) {
  const range = end - start + 1;
  const maxRandom = Math.min(10, range);
  for (let i = 0; i < maxRandom; i++) {
    const port = start + Math.floor(Math.random() * range);
    if (!isPortInUse(port)) return port;
  }
  for (let port = start; port <= end; port++) {
    if (!isPortInUse(port)) return port;
  }
  return null;
}

/**
 * Resolve %ENV_VAR% placeholders in a path string (Windows).
 */
function resolveEnvPath(p) {
  return p.replace(/%([^%]+)%/g, (_, v) => process.env[v] || "");
}

/**
 * Detect the Antigravity CLI binary.
 * 1. Check known install paths first (preferred, e.g. /Applications bundle).
 * 2. Fall back to `which` / `where` for PATH-based commands.
 */
function detectCli() {
  // Prefer known install paths — these point to the correct app bundle binary
  const installPaths = INSTALL_PATHS[PLATFORM] || [];
  for (const tpl of installPaths) {
    const resolved = resolveEnvPath(tpl);
    if (resolved && fs.existsSync(resolved)) {
      console.log(`[antigravity-ide] Found CLI at install path: ${resolved}`);
      return { found: true, command: resolved };
    }
  }

  // Fall back to PATH lookup
  const whichCmd = PLATFORM === "win32" ? "where" : "which";
  const commands = CLI_COMMANDS[PLATFORM] || CLI_COMMANDS.linux;
  for (const cmd of commands) {
    try {
      const result = execSync(`${whichCmd} ${cmd}`, { encoding: "utf8", stdio: "pipe", timeout: 5000 }).trim();
      if (result) return { found: true, command: result };
    } catch { /* not in PATH */ }
  }

  return { found: false, command: null };
}

/**
 * Detect running Antigravity processes.
 * macOS: pgrep -f for each app bundle name.
 * Windows: tasklist for each process name.
 * Linux: pgrep -x for each process name.
 */
function detectProcesses() {
  const pids = [];
  try {
    if (PLATFORM === "win32") {
      for (const name of (PROCESS_SEARCH.win32 || [])) {
        try {
          const output = execSync(`tasklist /FI "IMAGENAME eq ${name}" /NH`, {
            encoding: "utf8", stdio: "pipe", timeout: 5000,
          });
          if (!output.includes("No tasks") && output.includes(name.replace(".exe", ""))) {
            for (const line of output.split("\n").filter(l => l.includes(name.replace(".exe", "")))) {
              const match = line.match(/\s+(\d+)\s/);
              if (match) pids.push(parseInt(match[1], 10));
            }
          }
        } catch { /* not found */ }
      }
    } else {
      const isDarwin = PLATFORM === "darwin";
      const terms = isDarwin ? (PROCESS_SEARCH.darwin || []) : (PROCESS_SEARCH.linux || []);
      const flag = isDarwin ? "-f" : "-x";
      for (const term of terms) {
        try {
          const output = execSync(`pgrep ${flag} "${term}"`, {
            encoding: "utf8", stdio: "pipe", timeout: 5000,
          });
          output.trim().split("\n").filter(Boolean).forEach(p => {
            const n = parseInt(p, 10);
            if (!isNaN(n)) pids.push(n);
          });
        } catch { /* pgrep exit 1 = no match */ }
      }
    }
  } catch { /* ignore */ }
  return { running: pids.length > 0, pids: [...new Set(pids)] };
}

/**
 * Returns true if the ps entry is the main Electron process (macOS).
 * Main process: ppid=1, path contains /Contents/MacOS/, not a Helper or crash handler.
 */
function isMainProcess(ppid, comm) {
  return (
    ppid === 1 &&
    comm.includes("/Contents/MacOS/") &&
    !comm.includes("Helper") &&
    !comm.includes("chrome_crashpad_handler")
  );
}

/**
 * Find the main Electron process PID from a list of IDE PIDs (macOS only).
 * Two-pass: first checks the known PIDs, then checks any parent PIDs that
 * weren't in the pgrep results (handles macOS args truncation).
 */
function findMainPid(pids) {
  if (PLATFORM !== "darwin" || pids.length === 0) return null;
  try {
    const output = execSync(`ps -o pid=,ppid=,comm= -p ${pids.join(",")}`, {
      encoding: "utf8", stdio: "pipe", timeout: 5000,
    });

    const parentPids = new Set();
    for (const line of output.trim().split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const pid = parseInt(parts[0], 10);
      const ppid = parseInt(parts[1], 10);
      const comm = parts.slice(2).join(" ");
      if (isMainProcess(ppid, comm)) return pid;
      // Collect parent PIDs not already in our known set (for fallback pass)
      if (ppid !== 1 && !pids.includes(ppid)) parentPids.add(ppid);
    }

    // Fallback: main process may not appear in pgrep due to macOS args truncation
    if (parentPids.size > 0) {
      const parentOutput = execSync(`ps -o pid=,ppid=,comm= -p ${[...parentPids].join(",")}`, {
        encoding: "utf8", stdio: "pipe", timeout: 5000,
      });
      for (const line of parentOutput.trim().split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const pid = parseInt(parts[0], 10);
        const ppid = parseInt(parts[1], 10);
        const comm = parts.slice(2).join(" ");
        if (isMainProcess(ppid, comm)) return pid;
      }
    }
  } catch { /* ps command failed */ }
  return null;
}

/**
 * Kill running Antigravity processes
 */
function killProcesses(pids) {
  let killed = 0;
  if (PLATFORM === "darwin") {
    const mainPid = findMainPid(pids);
    if (mainPid) {
      console.log(`[antigravity-ide] Killing main process PID ${mainPid} (children will auto-terminate)`);
      try {
        execSync(`kill ${mainPid}`, { stdio: "pipe", timeout: 5000 });
        killed++;
      } catch { /* already exited */ }
    } else {
      // Fallback: could not identify main process, kill all found PIDs
      console.warn(`[antigravity-ide] Could not identify main process, killing all ${pids.length} PIDs`);
      for (const pid of pids) {
        try {
          execSync(`kill ${pid}`, { stdio: "pipe", timeout: 5000 });
          killed++;
        } catch { /* already exited */ }
      }
    }
  } else if (PLATFORM === "win32") {
    for (const name of (PROCESS_SEARCH.win32 || [])) {
      try {
        execSync(`taskkill /F /IM ${name}`, { stdio: "pipe", timeout: 5000 });
        killed++;
      } catch { /* ignore */ }
    }
  } else {
    for (const pid of pids) {
      try {
        execSync(`kill ${pid}`, { stdio: "pipe", timeout: 5000 });
        killed++;
      } catch { /* ignore */ }
    }
  }
  return killed;
}

/**
 * Resolve the .app bundle path from a CLI binary path (macOS only).
 * e.g. "/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity"
 *    → "/Applications/Antigravity.app"
 */
function resolveAppBundle(command) {
  const match = command.match(/^(\/.*?\.app)\b/);
  if (match && fs.existsSync(match[1])) return match[1];
  // Fallback: check known bundle locations
  for (const name of ["Antigravity.app", "AGY.app"]) {
    const p = `/Applications/${name}`;
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Launch Antigravity IDE fully detached from the Node.js process tree.
 *
 * macOS: Uses `open -a` which goes through Launch Services — the app gets
 *        its own session, process group, and clean environment (same as
 *        double-clicking in Finder). This avoids 127.0.0.1 reachability
 *        issues caused by inheriting the Next.js server's process context.
 * Windows: Uses `start` via cmd.exe for similar detachment.
 * Linux: Uses `setsid` + `nohup` for a new session.
 */
function launchIde(command, args = []) {
  if (PLATFORM === "darwin") {
    const appBundle = resolveAppBundle(command);
    if (appBundle) {
      const openArgs = ["-a", appBundle];
      if (args.length > 0) openArgs.push("--args", ...args);
      console.log(`[antigravity-ide] open ${openArgs.join(" ")}`);
      execSync(`open ${openArgs.map(a => `"${a}"`).join(" ")}`, {
        stdio: "ignore", timeout: 10000,
      });
      return null; // PID not available via `open`, process is fully detached
    }
    // Fallback: direct spawn if .app bundle not found
    console.warn(`[antigravity-ide] .app bundle not found, falling back to direct spawn`);
  }

  if (PLATFORM === "win32") {
    const cmdLine = [command, ...args].map(a => `"${a}"`).join(" ");
    console.log(`[antigravity-ide] start "" ${cmdLine}`);
    execSync(`start "" ${cmdLine}`, { stdio: "ignore", shell: true, timeout: 10000 });
    return null;
  }

  // Linux fallback or macOS fallback
  console.log(`[antigravity-ide] Spawning: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", (err) => console.error(`[antigravity-ide] Spawn error: ${err.message}`));
  child.unref();
  return child.pid;
}

/**
 * GET /api/antigravity-ide — Detect IDE status
 */
export async function GET() {
  const cli = detectCli();
  const proc = detectProcesses();

  return Response.json({
    installed: cli.found,
    cli: cli.command,
    running: proc.running,
    pids: proc.pids,
  });
}

/**
 * POST /api/antigravity-ide — Close or Relaunch IDE
 * Actions: "close" (kill all), "relaunch" (kill + launch)
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = body.action || "relaunch";

    if (action !== "relaunch" && action !== "close") {
      return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }

    // Close action: kill all Antigravity processes
    if (action === "close") {
      const proc = detectProcesses();
      if (!proc.running) {
        return Response.json({ success: true, message: "Antigravity IDE is not running" });
      }
      const killed = killProcesses(proc.pids);
      if (killed > 0) {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 500));
          if (!detectProcesses().running) break;
        }
      }
      console.log(`[antigravity-ide] Closed ${killed} process(es)`);
      return Response.json({
        success: true,
        killed,
        message: `Closed Antigravity IDE (${killed} process(es) killed)`,
      });
    }

    const cli = detectCli();
    if (!cli.found) {
      return Response.json({
        success: false,
        error: "Antigravity IDE not found. Check CLI at ~/.antigravity/antigravity/bin/antigravity",
      }, { status: 404 });
    }

    // Kill existing processes and wait until fully terminated
    const proc = detectProcesses();
    if (proc.running) {
      const killed = killProcesses(proc.pids);
      if (killed > 0) {
        console.log(`[antigravity-ide] Killed ${killed} process(es), waiting for full shutdown...`);

        // Poll until all processes are confirmed dead (up to 10s)
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 500));
          const check = detectProcesses();
          if (!check.running) break;
          console.log(`[antigravity-ide] Still ${check.pids.length} process(es) alive, waiting...`);
        }

        // Extra settle time for OS-level port/socket cleanup after processes exit
        console.log(`[antigravity-ide] Processes gone, settling 2s for resource cleanup...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Find a free debug port
    const port = findFreePort(DEBUG_PORT_START, DEBUG_PORT_END);
    if (!port) {
      return Response.json({
        success: false,
        error: `No free debug port in range ${DEBUG_PORT_START}-${DEBUG_PORT_END}`,
      }, { status: 500 });
    }

    // Launch with remote debugging port
    const launchArgs = [`--remote-debugging-port=${port}`];
    const pid = launchIde(cli.command, launchArgs);
    const statusLabel = proc.running ? "relaunched" : "launched";
    console.log(`[antigravity-ide] ${statusLabel}${pid ? ` with PID ${pid}` : ""}, debug port ${port}`);

    return Response.json({
      success: true,
      ...(pid != null && { pid }),
      port,
      status: statusLabel,
      wasRunning: proc.running,
      message: `Antigravity IDE ${statusLabel} (debug port ${port})`,
    });
  } catch (error) {
    console.error(`[antigravity-ide] Error:`, error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
