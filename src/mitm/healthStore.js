/**
 * Account Health Store — persists per-account request health events
 * to disk at ${DATA_DIR}/account-health.json.
 *
 * Compact event format to keep file small:
 *   { ts: number, s: "ok"|"rs"|"fl", a: number, m?: string }
 *   s: "ok" = success, "rs" = retry_success, "fl" = fail
 *   a: total attempts (1 = first-try success)
 *   m: model (optional)
 *
 * Runs in MITM server process (CJS, separate from Next.js).
 */
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./paths");

const HEALTH_FILE = path.join(DATA_DIR, "account-health.json");
const MAX_EVENTS = 100;

// Map from public status names → compact file format
const STATUS_CODE = {
  success:       "ok",
  retry_success: "rs",
  fail:          "fl",
};

/**
 * Read the health store from disk. Returns {} on any read/parse error.
 * @returns {{ [connectionId: string]: Array<{ts,s,a,m?}> }}
 */
function readStore() {
  try {
    if (!fs.existsSync(HEALTH_FILE)) return {};
    return JSON.parse(fs.readFileSync(HEALTH_FILE, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Write the health store to disk. Silently ignores write errors
 * so request flow is never interrupted.
 * @param {{ [connectionId: string]: Array }} data
 */
function writeStore(data) {
  try {
    // Ensure data directory exists (first-run safety)
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(data));
  } catch { /* ignore — never block request flow */ }
}

/**
 * Push a health event for an account.
 * Keeps only the last MAX_EVENTS events per connectionId.
 *
 * @param {string} connectionId
 * @param {"success"|"retry_success"|"fail"} status
 * @param {number} [attempts=1] - Total attempts (including retries)
 * @param {string|null} [model] - Model name (optional)
 */
function pushHealthEvent(connectionId, status, attempts, model) {
  if (!connectionId || !status) return;

  const store = readStore();
  if (!store[connectionId]) store[connectionId] = [];

  const event = {
    ts: Date.now(),
    s: STATUS_CODE[status] || status,
    a: attempts || 1,
  };
  if (model) event.m = model;

  store[connectionId].push(event);

  // Drop oldest events beyond MAX_EVENTS
  if (store[connectionId].length > MAX_EVENTS) {
    store[connectionId] = store[connectionId].slice(-MAX_EVENTS);
  }

  writeStore(store);
}

module.exports = {
  pushHealthEvent,
  readStore,
  HEALTH_FILE,
  MAX_EVENTS,
};
