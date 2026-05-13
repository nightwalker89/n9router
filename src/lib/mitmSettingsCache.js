// JSON cache for MITM-relevant settings — read by the standalone MITM server (no SQLite).
// Source of truth = SQLite settings table. JSON is a read-replica synced on app startup
// and after every updateSettings() call.
//
// Pattern mirrors src/lib/mitmAliasCache.js (aliases cache).
import fs from "fs";
import path from "path";
import { DATA_DIR } from "@/lib/dataDir.js";

const CACHE_FILE = path.join(DATA_DIR, "mitm", "settings.json");

// Only the keys the MITM process actually needs. Keeping this list minimal
// avoids leaking sensitive data (tokens, passwords, etc.) to the filesystem.
const MITM_SETTINGS_KEYS = [
  // Token swap
  "tokenSwapEnabled",
  "tokenSwapStrategy",
  "tokenSwapMaskEmails",
  "cooldownStrikeThreshold",
  "antigravity503RetryCount",
  // Antigravity MITM interceptor
  "mitmAntigravityAutoDisableOnSonnetZero",
  "mitmAntigravityIdeVersionOverrideEnabled",
  "mitmAntigravityIdeVersion",
  "mitmAntigravityHostRewriteEnabled",
  "mitmAntigravityDebugLogsEnabled",
  // Alias strategy + round-robin state
  "mitmAliasStrategy",
  "mitmAliasRoundRobinState",
  // RTK compression
  "rtkEnabled",
  // Router base URL (for API callbacks)
  "mitmRouterBaseUrl",
];

function writeAtomic(data) {
  const dir = path.dirname(CACHE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, CACHE_FILE);
}

// Full sync: pull all MITM-relevant settings from SQLite and write to JSON.
// Called on app startup and can be called after bulk settings changes.
export async function syncMitmSettingsCache() {
  try {
    const { getSettings } = await import("@/lib/db/repos/settingsRepo.js");
    const settings = await getSettings();
    const subset = {};
    for (const key of MITM_SETTINGS_KEYS) {
      if (key in settings) subset[key] = settings[key];
    }
    writeAtomic(subset);
  } catch (e) {
    console.warn("[mitmSettingsCache] sync failed:", e.message);
  }
}

// Partial patch: merge only the updated MITM-relevant keys into the existing cache.
// Called from the settings API route after updateSettings() so MITM picks up
// changes immediately without a full SQLite read.
export function patchMitmSettingsCache(updates) {
  try {
    let current = {};
    if (fs.existsSync(CACHE_FILE)) {
      try { current = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { /* corrupted → reset */ }
    }
    const relevant = {};
    for (const key of MITM_SETTINGS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) relevant[key] = updates[key];
    }
    if (Object.keys(relevant).length > 0) {
      writeAtomic({ ...current, ...relevant });
    }
  } catch (e) {
    console.warn("[mitmSettingsCache] patch failed:", e.message);
  }
}
