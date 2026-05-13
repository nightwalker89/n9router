const fs = require("fs");
const path = require("path");
const os = require("os");

const APP_NAME = "n9router";

function defaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();
  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      console.warn(`[DATA_DIR] '${configured}' not writable → fallback ~/.${APP_NAME}`);
      return defaultDir();
    }
    throw e;
  }
}

const DATA_DIR = getDataDir();
const MITM_DIR = path.join(DATA_DIR, "mitm");

// Windows: MITM uses %APPDATA%\n9router\mitm (same as db.json), but some setups only have
// certs under %USERPROFILE%\.n9router\mitm (Unix-style path). Copy once so server.js can load rootCA.*.
if (process.platform === "win32") {
  try {
    const legacyMitm = path.join(os.homedir(), ".n9router", "mitm");
    const destKey = path.join(MITM_DIR, "rootCA.key");
    const legacyKey = path.join(legacyMitm, "rootCA.key");
    if (!fs.existsSync(destKey) && fs.existsSync(legacyKey)) {
      fs.mkdirSync(MITM_DIR, { recursive: true });
      fs.cpSync(legacyMitm, MITM_DIR, { recursive: true });
    }
  } catch (e) {
    console.error("[n9router mitm] Could not sync MITM from ~/.n9router/mitm:", e.message);
  }
}

module.exports = { DATA_DIR, MITM_DIR };
