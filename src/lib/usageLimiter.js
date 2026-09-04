/**
 * API Key Usage Limiter
 *
 * SQLite-backed rolling window tracker for per-API-key usage limits.
 * Uses node:sqlite (built into Node.js >= 22.13.0) for fast synchronous persistence.
 *
 * Architecture:
 * - SQLite stores every usage entry (input_tokens, cost, ts)
 * - In-memory totals cache enables O(1) pre-request checks
 * - Background recalc every 60s self-heals the cache
 * - Instant startup — one SELECT SUM() GROUP BY rebuilds totals in ~1ms
 */

import path from "node:path";
import fs from "node:fs";
import { DATA_DIR } from "@/lib/dataDir.js";

// ─── Node:sqlite with graceful fallback ──────────────────────
let DatabaseSync = null;
let sqliteAvailable = false;
try {
  const sqliteModule = await import("node:sqlite");
  DatabaseSync = sqliteModule.DatabaseSync;
  sqliteAvailable = true;
} catch (err) {
  console.warn("[usageLimiter] node:sqlite not available:", err.message);
  console.warn("[usageLimiter] API key usage limiting will be disabled.");
}

const DB_PATH = path.join(DATA_DIR, "usage-limits.db");
const WINDOW_5H_MS = 5 * 60 * 60 * 1000;
const WINDOW_24H_MS = 24 * 60 * 60 * 1000;
const RECALC_INTERVAL_MS = 60 * 1000; // self-healing every 60s
const LIMITS_CACHE_TTL_MS = 5000; // re-read key limits from DB every 5s

// ─── Predefined Window Durations ────────────────────────────
export const PREDEFINED_DURATIONS = [
  { label: "15 min", ms: 15 * 60 * 1000 },
  { label: "1 hour", ms: 60 * 60 * 1000 },
  { label: "5 hours", ms: 5 * 60 * 60 * 1000 },
  { label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
];

// Max window to track (30 days) - determines data retention
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// ─── SQLite Instance (global singleton) ─────────────────────
if (!global._usageLimiterDb) {
  global._usageLimiterDb = null;
}
if (!global._usageLimiterStmts) {
  global._usageLimiterStmts = null;
}

function getDb() {
  if (global._usageLimiterDb) return global._usageLimiterDb;
  if (!sqliteAvailable) return null;

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  try {
    const db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL;"); // concurrent reads while writing
    db.exec("PRAGMA synchronous = NORMAL;"); // balanced durability/perf

    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_key_ts ON usage_entries(api_key, ts);

      CREATE TABLE IF NOT EXISTS reset_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT NOT NULL,
        window_ms INTEGER,
        window_label TEXT NOT NULL,
        reset_at INTEGER NOT NULL,
        tokens_cleared INTEGER NOT NULL DEFAULT 0,
        cost_cleared REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_reset_history_key ON reset_history(api_key, reset_at);
    `);

    global._usageLimiterDb = db;
    return db;
  } catch (err) {
    console.error("[usageLimiter] Failed to open database:", err.message);
    return null;
  }
}

function getStmts() {
  // Re-initialize if cached stmts are missing newer statements (e.g. after hot reload)
  if (global._usageLimiterStmts && !global._usageLimiterStmts.insertReset) {
    global._usageLimiterStmts = null;
  }
  if (global._usageLimiterStmts) return global._usageLimiterStmts;
  const db = getDb();
  if (!db) return null;

  // Ensure reset_history table exists (migration for DBs opened before this schema change)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reset_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT NOT NULL,
        window_ms INTEGER,
        window_label TEXT NOT NULL,
        reset_at INTEGER NOT NULL,
        tokens_cleared INTEGER NOT NULL DEFAULT 0,
        cost_cleared REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_reset_history_key ON reset_history(api_key, reset_at);
    `);
  } catch { /* table already exists */ }

  global._usageLimiterStmts = {
    insert: db.prepare(
      "INSERT INTO usage_entries (api_key, input_tokens, cost, ts) VALUES (?, ?, ?, ?)"
    ),
    // Legacy hardcoded 5h/24h sums for backward compatibility
    sumByKey: db.prepare(`
      SELECT
        SUM(CASE WHEN ts >= ? THEN input_tokens ELSE 0 END) AS inputTokens5h,
        SUM(input_tokens) AS inputTokens24h,
        SUM(CASE WHEN ts >= ? THEN cost ELSE 0 END) AS cost5h,
        SUM(cost) AS cost24h
      FROM usage_entries
      WHERE api_key = ? AND ts >= ?
    `),
    sumAllKeys: db.prepare(`
      SELECT
        api_key,
        SUM(CASE WHEN ts >= ? THEN input_tokens ELSE 0 END) AS inputTokens5h,
        SUM(input_tokens) AS inputTokens24h,
        SUM(CASE WHEN ts >= ? THEN cost ELSE 0 END) AS cost5h,
        SUM(cost) AS cost24h
      FROM usage_entries
      WHERE ts >= ?
      GROUP BY api_key
    `),
    // Dynamic window sum for custom time windows
    sumByKeyWindow: db.prepare(`
      SELECT
        SUM(input_tokens) AS inputTokens,
        SUM(cost) AS cost
      FROM usage_entries
      WHERE api_key = ? AND ts >= ?
    `),
    prune: db.prepare("DELETE FROM usage_entries WHERE ts < ?"),
    insertReset: db.prepare(
      "INSERT INTO reset_history (api_key, window_ms, window_label, reset_at, tokens_cleared, cost_cleared) VALUES (?, ?, ?, ?, ?, ?)"
    ),
    getResetHistory: db.prepare(
      "SELECT id, window_ms, window_label, reset_at, tokens_cleared, cost_cleared FROM reset_history WHERE api_key = ? ORDER BY reset_at DESC LIMIT 30"
    ),
    sumForWindow: db.prepare(
      "SELECT SUM(input_tokens) AS tokens, SUM(cost) AS cost FROM usage_entries WHERE api_key = ? AND ts >= ?"
    ),
    sumAllForKey: db.prepare(
      "SELECT SUM(input_tokens) AS tokens, SUM(cost) AS cost FROM usage_entries WHERE api_key = ?"
    ),
    deleteByWindow: db.prepare(
      "DELETE FROM usage_entries WHERE api_key = ? AND ts >= ?"
    ),
    deleteAllForKey: db.prepare(
      "DELETE FROM usage_entries WHERE api_key = ?"
    ),
  };

  return global._usageLimiterStmts;
}

// ─── In-Memory Totals Cache ──────────────────────────────────
// { [apiKeyValue]: { inputTokens5h, inputTokens24h, cost5h, cost24h, windows: [{label, ms, inputTokens, cost}] } }
if (!global._usageLimiterTotals) {
  global._usageLimiterTotals = {};
}
const totalsCache = global._usageLimiterTotals;

// Per-key limits cache (from localDb, refreshed every 5s)
if (!global._usageLimiterLimits) {
  global._usageLimiterLimits = { data: {}, ts: 0 };
}
const limitsCache = global._usageLimiterLimits;

// Background recalc timer
if (!global._usageLimiterTimer) {
  global._usageLimiterTimer = null;
}

// ─── Limits Cache ────────────────────────────────────────────

async function refreshLimitsCache() {
  if (Date.now() - limitsCache.ts < LIMITS_CACHE_TTL_MS) return;
  try {
    const { getApiKeys } = await import("@/lib/localDb.js");
    const allKeys = await getApiKeys();
    const newData = {};
    for (const k of allKeys) {
      if (k.limits) newData[k.key] = k.limits;
    }
    limitsCache.data = newData;
    limitsCache.ts = Date.now();
  } catch (err) {
    console.error("[usageLimiter] Failed to refresh limits cache:", err.message);
  }
}

// ─── Rolling Sums ────────────────────────────────────────────

function recalcKey(apiKeyValue) {
  if (!sqliteAvailable) {
    totalsCache[apiKeyValue] = { inputTokens5h: 0, inputTokens24h: 0, cost5h: 0, cost24h: 0, windows: [] };
    return;
  }

  const now = Date.now();
  const cutoff5h = now - WINDOW_5H_MS;
  const cutoff24h = now - WINDOW_24H_MS;

  try {
    const stmts = getStmts();
    if (!stmts) {
      totalsCache[apiKeyValue] = { inputTokens5h: 0, inputTokens24h: 0, cost5h: 0, cost24h: 0, windows: [] };
      return;
    }
    const row = stmts.sumByKey.get(cutoff5h, cutoff5h, apiKeyValue, cutoff24h);
    totalsCache[apiKeyValue] = {
      inputTokens5h: row?.inputTokens5h || 0,
      inputTokens24h: row?.inputTokens24h || 0,
      cost5h: row?.cost5h || 0,
      cost24h: row?.cost24h || 0,
      windows: [], // Custom windows calculated on-demand
    };
  } catch (err) {
    console.error("[usageLimiter] recalcKey failed:", err.message);
    totalsCache[apiKeyValue] = { inputTokens5h: 0, inputTokens24h: 0, cost5h: 0, cost24h: 0, windows: [] };
  }
}

/**
 * Calculate usage for a custom time window.
 * @param {string} apiKeyValue
 * @param {number} durationMs - window duration in milliseconds
 * @returns {{inputTokens: number, cost: number}}
 */
function getWindowUsage(apiKeyValue, durationMs) {
  if (!sqliteAvailable) return { inputTokens: 0, cost: 0 };

  const now = Date.now();
  const cutoff = now - durationMs;
  try {
    const stmts = getStmts();
    if (!stmts) return { inputTokens: 0, cost: 0 };
    const row = stmts.sumByKeyWindow.get(apiKeyValue, cutoff);
    return {
      inputTokens: row?.inputTokens || 0,
      cost: row?.cost || 0,
    };
  } catch (err) {
    console.error("[usageLimiter] getWindowUsage failed:", err.message);
    return { inputTokens: 0, cost: 0 };
  }
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Check if apiKey is within its configured limits.
 * O(1) in-memory check after first access.
 * @param {string|null} apiKeyValue
 * @returns {Promise<{allowed: true}|{allowed: false, reason: string, limitType: string, usage: object}>}
 */
export async function checkLimit(apiKeyValue) {
  if (!apiKeyValue) return { allowed: true };

  // Start background recalc if not running
  if (!global._usageLimiterTimer) {
    startBackgroundRecalc();
  }

  await refreshLimitsCache();
  const limits = limitsCache.data[apiKeyValue];
  if (!limits) return { allowed: true }; // No limits configured for this key

  // Ensure totals initialized (first request for this key since startup)
  if (!totalsCache[apiKeyValue]) {
    recalcKey(apiKeyValue);
  }

  const sums = totalsCache[apiKeyValue] || { inputTokens5h: 0, inputTokens24h: 0, cost5h: 0, cost24h: 0, windows: [] };

  // Build checks array: legacy fields + custom windows
  const checks = [];

  // Legacy 5h/24h fields (for backward compatibility)
  if (limits.inputTokens5h) {
    checks.push({ field: "inputTokens5h", limit: limits.inputTokens5h, label: "5h input token", fmt: (v) => v.toLocaleString() + " tokens", type: "legacy" });
  }
  if (limits.inputTokens24h) {
    checks.push({ field: "inputTokens24h", limit: limits.inputTokens24h, label: "24h input token", fmt: (v) => v.toLocaleString() + " tokens", type: "legacy" });
  }
  if (limits.cost5h) {
    checks.push({ field: "cost5h", limit: limits.cost5h, label: "5h cost", fmt: (v) => "$" + v.toFixed(4), type: "legacy" });
  }
  if (limits.cost24h) {
    checks.push({ field: "cost24h", limit: limits.cost24h, label: "24h cost", fmt: (v) => "$" + v.toFixed(4), type: "legacy" });
  }

  // Custom windows
  if (limits.windows && Array.isArray(limits.windows)) {
    for (const win of limits.windows) {
      if (!win.durationMs || (!win.inputTokens && !win.cost)) continue;
      const usage = getWindowUsage(apiKeyValue, win.durationMs);
      if (win.inputTokens) {
        checks.push({
          field: `window_${win.durationMs}_tokens`,
          limit: win.inputTokens,
          label: `${formatDuration(win.durationMs)} input token`,
          fmt: (v) => v.toLocaleString() + " tokens",
          type: "window",
          durationMs: win.durationMs,
          current: usage.inputTokens,
        });
      }
      if (win.cost) {
        checks.push({
          field: `window_${win.durationMs}_cost`,
          limit: win.cost,
          label: `${formatDuration(win.durationMs)} cost`,
          fmt: (v) => "$" + v.toFixed(4),
          type: "window",
          durationMs: win.durationMs,
          current: usage.cost,
        });
      }
    }
  }

  for (const check of checks) {
    const current = check.type === "window" ? check.current : sums[check.field];
    if (current >= check.limit) {
      // Get the key name for a friendlier error message
      let keyName = apiKeyValue.slice(0, 8) + "...";
      try {
        const { getApiKeys } = await import("@/lib/localDb.js");
        const allKeys = await getApiKeys();
        const k = allKeys.find((k) => k.key === apiKeyValue);
        if (k) keyName = k.name;
      } catch {
        // keep default masked key name
      }

      return {
        allowed: false,
        reason: `API key "${keyName}" exceeded ${check.label} limit (${check.fmt(current)} / ${check.fmt(check.limit)})`,
        limitType: check.field,
        usage: { ...sums },
      };
    }
  }

  return { allowed: true, usage: { ...sums } };
}

/**
 * Record usage after a request completes.
 * Synchronous SQLite INSERT + increment in-memory totals.
 * @param {string} apiKeyValue
 * @param {number} inputTokens
 * @param {number} cost
 */
export function recordUsage(apiKeyValue, inputTokens, cost) {
  if (!apiKeyValue || typeof apiKeyValue !== "string") return;
  if (!sqliteAvailable) return; // Silently skip if SQLite unavailable

  const ts = Date.now();
  try {
    const stmts = getStmts();
    if (!stmts) return;
    stmts.insert.run(apiKeyValue, inputTokens || 0, cost || 0, ts);
  } catch (err) {
    console.error("[usageLimiter] INSERT failed:", err.message);
    return;
  }

  // Increment in-memory totals (avoids recalc on every request)
  if (!totalsCache[apiKeyValue]) {
    totalsCache[apiKeyValue] = { inputTokens5h: 0, inputTokens24h: 0, cost5h: 0, cost24h: 0, windows: [] };
  }
  const t = totalsCache[apiKeyValue];
  const tokens = inputTokens || 0;
  const c = cost || 0;
  t.inputTokens5h += tokens;
  t.inputTokens24h += tokens;
  t.cost5h += c;
  t.cost24h += c;
  // Note: Custom windows are calculated on-demand in checkLimit to avoid complexity
}

/**
 * Get usage summary for a key — reads fresh from SQLite (for dashboard accuracy).
 * @param {string} apiKeyValue
 * @returns {Promise<{usage: object, limits: object}>}
 */
export async function getUsageSummary(apiKeyValue) {
  const now = Date.now();
  const cutoff5h = now - WINDOW_5H_MS;
  const cutoff24h = now - WINDOW_24H_MS;

  let usage = { inputTokens5h: 0, inputTokens24h: 0, cost5h: 0, cost24h: 0 };
  try {
    if (!sqliteAvailable) {
      return { usage, limits: {}, windowUsage: {} };
    }
    const stmts = getStmts();
    if (!stmts) {
      return { usage, limits: {}, windowUsage: {} };
    }
    const row = stmts.sumByKey.get(cutoff5h, cutoff5h, apiKeyValue, cutoff24h);
    usage = {
      inputTokens5h: row?.inputTokens5h || 0,
      inputTokens24h: row?.inputTokens24h || 0,
      cost5h: row?.cost5h || 0,
      cost24h: row?.cost24h || 0,
    };
  } catch (err) {
    console.error("[usageLimiter] getUsageSummary failed:", err.message);
  }

  await refreshLimitsCache();
  const limits = limitsCache.data[apiKeyValue] || {};

  // Calculate custom window usage if defined
  const windowUsage = {};
  if (limits.windows && Array.isArray(limits.windows)) {
    for (const win of limits.windows) {
      if (!win.durationMs) continue;
      const wu = getWindowUsage(apiKeyValue, win.durationMs);
      windowUsage[`tokens_${win.durationMs}`] = wu.inputTokens;
      windowUsage[`cost_${win.durationMs}`] = wu.cost;
    }
  }

  return { usage, limits, windowUsage };
}

/**
 * Format duration in milliseconds to human-readable label.
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  const minutes = Math.floor(ms / (60 * 1000));
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

/**
 * Reset usage for an API key within a given time window.
 * Deletes usage_entries in the window, logs to reset_history, invalidates cache.
 * @param {string} apiKeyValue
 * @param {number|null} windowMs  - ms duration to clear (null = all time)
 * @param {string} windowLabel    - human-readable label for history
 * @returns {{tokensCleared: number, costCleared: number}}
 */
export function resetKeyUsage(apiKeyValue, windowMs, windowLabel) {
  if (!sqliteAvailable) return { tokensCleared: 0, costCleared: 0 };
  const stmts = getStmts();
  if (!stmts) return { tokensCleared: 0, costCleared: 0 };

  const now = Date.now();
  let tokensCleared = 0;
  let costCleared = 0;

  try {
    if (windowMs) {
      const cutoff = now - windowMs;
      const row = stmts.sumForWindow.get(apiKeyValue, cutoff);
      tokensCleared = row?.tokens || 0;
      costCleared = row?.cost || 0;
      stmts.deleteByWindow.run(apiKeyValue, cutoff);
    } else {
      const row = stmts.sumAllForKey.get(apiKeyValue);
      tokensCleared = row?.tokens || 0;
      costCleared = row?.cost || 0;
      stmts.deleteAllForKey.run(apiKeyValue);
    }

    stmts.insertReset.run(
      apiKeyValue,
      windowMs || null,
      windowLabel || "All time",
      now,
      Math.round(tokensCleared),
      costCleared
    );

    // Invalidate in-memory totals cache so next request recalculates
    delete totalsCache[apiKeyValue];
  } catch (err) {
    console.error("[usageLimiter] resetKeyUsage failed:", err.message);
  }

  return { tokensCleared: Math.round(tokensCleared), costCleared };
}

/**
 * Get reset history for an API key.
 * @param {string} apiKeyValue
 * @returns {Array<{id, window_ms, window_label, reset_at, tokens_cleared, cost_cleared}>}
 */
export function getResetHistory(apiKeyValue) {
  if (!sqliteAvailable) return [];
  const stmts = getStmts();
  if (!stmts) return [];
  try {
    return stmts.getResetHistory.all(apiKeyValue);
  } catch (err) {
    console.error("[usageLimiter] getResetHistory failed:", err.message);
    return [];
  }
}

/**
 * Validate a custom window configuration.
 * @param {object} win
 * @returns {{valid: boolean, error?: string}}
 */
export function validateWindow(win) {
  if (!win || typeof win !== "object") return { valid: false, error: "Window must be an object" };
  if (!win.durationMs || typeof win.durationMs !== "number" || win.durationMs < 60 * 1000) {
    return { valid: false, error: "durationMs must be at least 1 minute" };
  }
  if (win.durationMs > MAX_WINDOW_MS) {
    return { valid: false, error: `durationMs cannot exceed ${MAX_WINDOW_MS}ms (30 days)` };
  }
  const hasTokenLimit = win.inputTokens && typeof win.inputTokens === "number" && win.inputTokens > 0;
  const hasCostLimit = win.cost && typeof win.cost === "number" && win.cost > 0;
  if (!hasTokenLimit && !hasCostLimit) {
    return { valid: false, error: "Window must have either inputTokens or cost limit" };
  }
  return { valid: true };
}

// ─── Background Recalc & Prune ───────────────────────────────

function backgroundRecalcAndPrune() {
  if (!sqliteAvailable) return; // Silently skip if SQLite unavailable

  try {
    const stmts = getStmts();
    if (!stmts) return;

    const now = Date.now();
    const cutoff5h = now - WINDOW_5H_MS;
    const cutoff24h = now - WINDOW_24H_MS;
    const cutoffMax = now - MAX_WINDOW_MS;

    // Prune entries older than max window (30 days)
    stmts.prune.run(cutoffMax);

    // Recalc all active keys from SQLite
    const rows = stmts.sumAllKeys.all(cutoff5h, cutoff5h, cutoff24h);

    const newTotals = {};
    for (const row of rows) {
      newTotals[row.api_key] = {
        inputTokens5h: row.inputTokens5h || 0,
        inputTokens24h: row.inputTokens24h || 0,
        cost5h: row.cost5h || 0,
        cost24h: row.cost24h || 0,
      };
    }

    // Sync cache — remove stale keys, add/update active ones
    // Preserve custom windows array when updating
    for (const key of Object.keys(totalsCache)) {
      if (!newTotals[key]) delete totalsCache[key];
    }
    for (const [key, totals] of Object.entries(newTotals)) {
      if (totalsCache[key]) {
        // Preserve existing windows array
        totalsCache[key] = { ...totals, windows: totalsCache[key].windows || [] };
      } else {
        totalsCache[key] = { ...totals, windows: [] };
      }
    }
  } catch (err) {
    console.error("[usageLimiter] Background recalc failed:", err.message);
  }
}

export function startBackgroundRecalc() {
  if (global._usageLimiterTimer) return;
  if (!sqliteAvailable) {
    console.warn("[usageLimiter] Background recalc disabled: node:sqlite not available");
    return;
  }

  // Initial recalc on startup — builds totals from SQLite instantly
  backgroundRecalcAndPrune();

  global._usageLimiterTimer = setInterval(backgroundRecalcAndPrune, RECALC_INTERVAL_MS);

  // Don't prevent process exit
  if (global._usageLimiterTimer.unref) {
    global._usageLimiterTimer.unref();
  }
}

export function stopBackgroundRecalc() {
  if (global._usageLimiterTimer) {
    clearInterval(global._usageLimiterTimer);
    global._usageLimiterTimer = null;
  }
}
