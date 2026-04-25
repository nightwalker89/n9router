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
 * Keys are account emails (stable across re-adds) with fallback to
 * connection IDs for accounts without email.
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
 * @returns {{ [accountKey: string]: Array<{ts,s,a,m?}> }}
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
 * @param {{ [accountKey: string]: Array }} data
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
 * Keeps only the last MAX_EVENTS events per accountKey.
 *
 * @param {string} accountKey - Stable key (email preferred, falls back to connection ID)
 * @param {"success"|"retry_success"|"fail"} status
 * @param {number} [attempts=1] - Total attempts (including retries)
 * @param {string|null} [model] - Model name (optional)
 */
function pushHealthEvent(accountKey, status, attempts, model) {
  if (!accountKey || !status) return;

  const store = readStore();
  if (!store[accountKey]) store[accountKey] = [];

  const event = {
    ts: Date.now(),
    s: STATUS_CODE[status] || status,
    a: attempts || 1,
  };
  if (model) event.m = model;

  store[accountKey].push(event);

  // Drop oldest events beyond MAX_EVENTS
  if (store[accountKey].length > MAX_EVENTS) {
    store[accountKey] = store[accountKey].slice(-MAX_EVENTS);
  }

  writeStore(store);
}

/**
 * Return the compact status code of the most recent health event for
 * an account, or null if no events exist yet.
 * Used to implement the "2 consecutive fails = cooldown" policy.
 *
 * @param {string} accountKey - Stable key (email preferred, falls back to connection ID)
 * @returns {"ok"|"rs"|"fl"|null}
 */
function getLastEventStatus(accountKey) {
  if (!accountKey) return null;
  try {
    const store = readStore();
    const events = store[accountKey];
    if (!events || events.length === 0) return null;
    return events[events.length - 1].s || null;
  } catch {
    return null;
  }
}

/**
 * One-time migration: convert old UUID-keyed entries to email-keyed entries.
 * Call at startup with the current list of connections. For each connection
 * that has an email, if there are health events under its old `id` key,
 * merge them into the email key and remove the old key.
 *
 * @param {{ id: string, email?: string }[]} connections
 */
function migrateToEmailKeys(connections) {
  if (!connections || connections.length === 0) return;

  const store = readStore();
  let changed = false;

  for (const conn of connections) {
    if (!conn.email || !conn.id) continue;
    if (conn.email === conn.id) continue; // already email-keyed
    if (!store[conn.id]) continue;          // no old data to migrate

    // Merge old events into email key (append, then trim)
    const existing = store[conn.email] || [];
    const merged = [...existing, ...store[conn.id]];
    // Sort by timestamp and keep only the latest MAX_EVENTS
    merged.sort((a, b) => a.ts - b.ts);
    store[conn.email] = merged.slice(-MAX_EVENTS);

    delete store[conn.id];
    changed = true;
  }

  if (changed) writeStore(store);
}

module.exports = {
  pushHealthEvent,
  getLastEventStatus,
  readStore,
  migrateToEmailKeys,
  HEALTH_FILE,
  MAX_EVENTS,
};
