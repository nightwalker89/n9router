const { exec, spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { log, err } = require("../logger");

// Per-tool DNS hosts mapping
const TOOL_HOSTS = {
  antigravity: ["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"],
  copilot: ["api.individual.githubcopilot.com"],
  kiro: ["q.us-east-1.amazonaws.com", "codewhisperer.us-east-1.amazonaws.com"],
  cursor: ["api2.cursor.sh"],
};

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const HOSTS_FILE = IS_WIN
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc", "hosts")
  : "/etc/hosts";

function compactText(value) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function describeDnsError(error, context = {}) {
  const parts = [];
  const action = context.action || "DNS operation failed";

  parts.push(action);

  if (context.tool) parts.push(`tool=${context.tool}`);
  if (context.hostsFile) parts.push(`hostsFile=${context.hostsFile}`);
  if (context.hosts && context.hosts.length) parts.push(`hosts=${context.hosts.join(", ")}`);

  if (error?.code) parts.push(`code=${error.code}`);
  if (error?.syscall) parts.push(`syscall=${error.syscall}`);
  if (error?.path) parts.push(`path=${error.path}`);

  const stdout = compactText(error?.stdout);
  const stderr = compactText(error?.stderr);
  const message = compactText(error?.message);

  if (message) parts.push(`message=${message}`);
  if (stderr) parts.push(`stderr=${stderr}`);
  if (stdout) parts.push(`stdout=${stdout}`);

  return parts.join(" | ");
}

function buildWindowsAdminHint(hostsFile = HOSTS_FILE) {
  return `Windows DNS changes require Administrator privileges. Restart 9Router as Administrator so it can update ${hostsFile} and flush the DNS cache.`;
}

function buildDnsOperationError(error, context = {}) {
  const detail = describeDnsError(error, context);
  const isWindowsLike = context.isWindows ?? IS_WIN;
  if (isWindowsLike && (error?.code === "EACCES" || error?.code === "EPERM")) {
    return `${detail} | hint=${buildWindowsAdminHint(context.hostsFile || HOSTS_FILE)}`;
  }
  return detail;
}

function isWindowsAdmin() {
  if (!IS_WIN) return false;
  try {
    execSync("net session >nul 2>&1", { windowsHide: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function createDnsFailure(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

function ensureWindowsDnsAccess(tool, action, hosts) {
  if (!IS_WIN) return;

  const context = {
    action,
    tool,
    hostsFile: HOSTS_FILE,
    hosts,
  };

  if (!isWindowsAdmin()) {
    const message = `${action} blocked | tool=${tool} | hostsFile=${HOSTS_FILE} | reason=process-not-elevated | hint=${buildWindowsAdminHint(HOSTS_FILE)}`;
    throw createDnsFailure(message, {
      code: "WINDOWS_ADMIN_REQUIRED",
      statusCode: 403,
    });
  }

  try {
    fs.accessSync(HOSTS_FILE, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    const detail = buildDnsOperationError(error, context);
    throw createDnsFailure(detail, {
      code: error?.code === "EACCES" || error?.code === "EPERM" ? "WINDOWS_ADMIN_REQUIRED" : error?.code,
      statusCode: error?.code === "EACCES" || error?.code === "EPERM" ? 403 : 500,
    });
  }
}

function verifyDnsEntriesPresent(tool, expectedPresent) {
  const hosts = TOOL_HOSTS[tool] || [];
  const hostsContent = fs.readFileSync(HOSTS_FILE, "utf8");
  const actualPresent = hosts.every((host) => hostsContent.includes(host));
  if (actualPresent !== expectedPresent) {
    const state = expectedPresent ? "present" : "absent";
    throw createDnsFailure(
      `DNS verification failed | tool=${tool} | hostsFile=${HOSTS_FILE} | expected=${state} | hosts=${hosts.join(", ")}`
    );
  }
}

function flushWindowsDns() {
  try {
    log("🌐 Windows DNS: flushing resolver cache...");
    execSync("ipconfig /flushdns", {
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    log("🌐 Windows DNS: resolver cache flushed");
  } catch (error) {
    const detail = buildDnsOperationError(error, { action: "Failed to flush Windows DNS cache", hostsFile: HOSTS_FILE });
    throw createDnsFailure(detail, {
      code: error?.code,
      statusCode: error?.code === "EACCES" || error?.code === "EPERM" ? 403 : 500,
    });
  }
}

/**
 * Execute elevated PowerShell script on Windows via Start-Process -Verb RunAs.
 * Only UAC consent dialog appears, no CMD/PS window popup.
 */
function executeElevatedPowerShell(psScriptPath, timeoutMs = 30000) {
  const flagFile = path.join(os.tmpdir(), `ps_done_${Date.now()}.flag`);
  const psSQ = (s) => s.replace(/'/g, "''");
  
  let psContent = fs.readFileSync(psScriptPath, "utf8");
  psContent += `\nSet-Content -Path '${psSQ(flagFile)}' -Value 'done' -Encoding UTF8\n`;
  fs.writeFileSync(psScriptPath, psContent, "utf8");

  const outerCmd = `Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','${psSQ(psScriptPath)}' -Verb RunAs -WindowStyle Hidden`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    exec(
      `powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "${outerCmd}"`,
      { windowsHide: true },
      () => {}
    );

    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (settled) return;
      if (fs.existsSync(flagFile)) {
        try { fs.unlinkSync(flagFile); fs.unlinkSync(psScriptPath); } catch { /* ignore */ }
        return settle(resolve);
      }
      if (Date.now() > deadline) {
        try { fs.unlinkSync(psScriptPath); } catch { /* ignore */ }
        return settle(reject, new Error("Timed out waiting for UAC confirmation"));
      }
      setTimeout(poll, 500);
    };
    setTimeout(poll, 300);
  });
}

/** True when `sudo` exists (e.g. missing on minimal Docker images like Alpine). */
function isSudoAvailable() {
  if (IS_WIN) return false;
  try {
    execSync("command -v sudo", { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute command with sudo password via stdin (macOS/Linux only).
 * Without sudo in PATH (containers), runs via sh — same user, no elevation.
 */
function execWithPassword(command, password) {
  return new Promise((resolve, reject) => {
    const useSudo = isSudoAvailable();
    const child = useSudo
      ? spawn("sudo", ["-S", "sh", "-c", command], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
      : spawn("sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Exit code ${code}`));
    });

    if (useSudo) {
      child.stdin.write(`${password}\n`);
      child.stdin.end();
    }
  });
}

/**
 * Flush DNS cache (macOS/Linux)
 */
async function flushDNS(sudoPassword) {
  if (IS_WIN) return; // Windows flushes inline via ipconfig
  if (IS_MAC) {
    await execWithPassword("dscacheutil -flushcache && killall -HUP mDNSResponder", sudoPassword);
  } else {
    await execWithPassword("resolvectl flush-caches 2>/dev/null || true", sudoPassword);
  }
}

/**
 * Check if DNS entry exists for a specific host
 */
function checkDNSEntry(host = null) {
  try {
    const hostsContent = fs.readFileSync(HOSTS_FILE, "utf8");
    if (host) return hostsContent.includes(host);
    // Legacy: check all antigravity hosts (backward compat)
    return TOOL_HOSTS.antigravity.every(h => hostsContent.includes(h));
  } catch {
    return false;
  }
}

/**
 * Check DNS status per tool — returns { [tool]: boolean }
 */
function checkAllDNSStatus() {
  try {
    const hostsContent = fs.readFileSync(HOSTS_FILE, "utf8");
    const result = {};
    for (const [tool, hosts] of Object.entries(TOOL_HOSTS)) {
      result[tool] = hosts.every(h => hostsContent.includes(h));
    }
    return result;
  } catch {
    return Object.fromEntries(Object.keys(TOOL_HOSTS).map(t => [t, false]));
  }
}

/**
 * Add DNS entries for a specific tool
 */
async function addDNSEntry(tool, sudoPassword) {
  const hosts = TOOL_HOSTS[tool];
  if (!hosts) throw new Error(`Unknown tool: ${tool}`);

  const entriesToAdd = hosts.filter(h => !checkDNSEntry(h));
  if (entriesToAdd.length === 0) {
    log(`🌐 DNS ${tool}: already active`);
    return;
  }

  const entries = entriesToAdd.map(h => `127.0.0.1 ${h}`).join("\n");

  try {
    log(`🌐 DNS ${tool}: enabling (${entriesToAdd.join(", ")})`);
    if (IS_WIN) {
      ensureWindowsDnsAccess(tool, "Enable Windows DNS override", entriesToAdd);
      const toAppend = entriesToAdd.map(h => `127.0.0.1 ${h}`).join("\r\n") + "\r\n";
      log(`🌐 DNS ${tool}: appending entries to ${HOSTS_FILE}`);
      fs.appendFileSync(HOSTS_FILE, toAppend, "utf8");
      flushWindowsDns();
      verifyDnsEntriesPresent(tool, true);
    } else {
      await execWithPassword(`echo "${entries}" >> ${HOSTS_FILE}`, sudoPassword);
      await flushDNS(sudoPassword);
    }
    log(`🌐 DNS ${tool}: ✅ added ${entriesToAdd.join(", ")} (hosts=${HOSTS_FILE})`);
  } catch (error) {
    const detail = error.message?.includes("incorrect password")
      ? "Wrong sudo password"
      : buildDnsOperationError(error, {
          action: "Failed to add DNS entry",
          tool,
          hostsFile: HOSTS_FILE,
          hosts: entriesToAdd,
        });
    err(`DNS ${tool}: add failed — ${detail}`);
    throw new Error(detail);
  }
}

/**
 * Remove DNS entries for a specific tool
 */
async function removeDNSEntry(tool, sudoPassword) {
  const hosts = TOOL_HOSTS[tool];
  if (!hosts) throw new Error(`Unknown tool: ${tool}`);

  const entriesToRemove = hosts.filter(h => checkDNSEntry(h));
  if (entriesToRemove.length === 0) {
    log(`🌐 DNS ${tool}: already inactive`);
    return;
  }

  try {
    log(`🌐 DNS ${tool}: disabling (${entriesToRemove.join(", ")})`);
    if (IS_WIN) {
      ensureWindowsDnsAccess(tool, "Disable Windows DNS override", entriesToRemove);
      const content = fs.readFileSync(HOSTS_FILE, "utf8");
      const filtered = content.split(/\r?\n/).filter(l => !entriesToRemove.some(h => l.includes(h))).join("\r\n");
      log(`🌐 DNS ${tool}: rewriting ${HOSTS_FILE} without ${entriesToRemove.join(", ")}`);
      fs.writeFileSync(HOSTS_FILE, filtered, "utf8");
      flushWindowsDns();
      verifyDnsEntriesPresent(tool, false);
    } else {
      for (const host of entriesToRemove) {
        const sedCmd = IS_MAC
          ? `sed -i '' '/${host}/d' ${HOSTS_FILE}`
          : `sed -i '/${host}/d' ${HOSTS_FILE}`;
        await execWithPassword(sedCmd, sudoPassword);
      }
      await flushDNS(sudoPassword);
    }
    log(`🌐 DNS ${tool}: ✅ removed ${entriesToRemove.join(", ")} (hosts=${HOSTS_FILE})`);
  } catch (error) {
    const detail = error.message?.includes("incorrect password")
      ? "Wrong sudo password"
      : buildDnsOperationError(error, {
          action: "Failed to remove DNS entry",
          tool,
          hostsFile: HOSTS_FILE,
          hosts: entriesToRemove,
        });
    err(`DNS ${tool}: remove failed — ${detail}`);
    throw new Error(detail);
  }
}

/**
 * Remove ALL tool DNS entries (used when stopping server)
 */
async function removeAllDNSEntries(sudoPassword) {
  for (const tool of Object.keys(TOOL_HOSTS)) {
    try {
      await removeDNSEntry(tool, sudoPassword);
    } catch (e) {
      err(`DNS ${tool}: failed to remove — ${e.message}`);
    }
  }
}

module.exports = {
  TOOL_HOSTS,
  addDNSEntry,
  removeDNSEntry,
  removeAllDNSEntries,
  execWithPassword,
  isSudoAvailable,
  executeElevatedPowerShell,
  checkDNSEntry,
  checkAllDNSStatus,
  buildWindowsAdminHint,
  buildDnsOperationError,
  describeDnsError,
  isWindowsAdmin,
};
