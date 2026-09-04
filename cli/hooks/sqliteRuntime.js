// Verify node:sqlite runtime availability.
// node:sqlite is built into Node.js >= 22.13.0, requiring no external installation.
const path = require("path");
const os = require("os");

function getDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  return process.platform === "win32"
    ? path.join(process.env.APPDATA || os.homedir(), "n9router")
    : path.join(os.homedir(), ".n9router");
}

function getRuntimeDir() {
  return path.join(getDataDir(), "runtime");
}

function getRuntimeNodeModules() {
  return path.join(getRuntimeDir(), "node_modules");
}

// Verify node:sqlite is available in current Node runtime.
function ensureSqliteRuntime({ silent = false } = {}) {
  try {
    require("node:sqlite");
    if (!silent) console.log("✅ SQLite engine ready (node:sqlite)");
    return { sqlite: true };
  } catch (err) {
    if (!silent) {
      console.warn("⚠️  node:sqlite not available on this Node runtime:", err.message);
      console.warn("   Node.js >= 22.13.0 is recommended for API key usage limits.");
    }
    return { sqlite: false };
  }
}

// Inject runtime + bundled node_modules into NODE_PATH for packaged child processes.
function buildEnvWithRuntime(baseEnv = process.env) {
  const runtimeNm = getRuntimeNodeModules();
  const bundledNm = path.join(__dirname, "..", "app", "node_modules");
  const existing = baseEnv.NODE_PATH || "";
  const NODE_PATH = [runtimeNm, bundledNm, existing].filter(Boolean).join(path.delimiter);
  return { ...baseEnv, NODE_PATH };
}

module.exports = {
  ensureSqliteRuntime,
  buildEnvWithRuntime,
  getRuntimeDir,
  getRuntimeNodeModules,
};
