"use strict";

const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./paths");

// MITM settings are read from a dedicated JSON cache file (mitm/settings.json)
// synced from SQLite by the app process. This avoids reading the full db.json
// and aligns with the mitm/aliases.json pattern used for mitmAlias.
const DEFAULT_SETTINGS_FILE = path.join(DATA_DIR, "mitm", "settings.json");
const DEFAULT_ANTIGRAVITY_IDE_VERSION = "1.23.2";
const DEFAULT_SETTINGS_CACHE_TTL_MS = 1000;

const settingsCache = new Map();

function normalizeAntigravityIdeVersion(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || DEFAULT_ANTIGRAVITY_IDE_VERSION;
}

function getCacheEntry(file) {
  let entry = settingsCache.get(file);
  if (!entry) {
    entry = { checkedAt: 0, mtimeMs: null, settings: {} };
    settingsCache.set(file, entry);
  }
  return entry;
}

// Read the settings JSON cache file (mitm/settings.json).
// The file contains only MITM-relevant keys — no connection tokens or secrets.
function readSettingsFromCache(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  // Accept both flat format (new: mitm/settings.json) and legacy nested
  // format (old: db.json → db.settings) so a cold start without a cache
  // file still degrades gracefully if only db.json exists.
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw.settings && !Array.isArray(raw.settings) ? raw.settings : raw;
  }
  return {};
}

function getMitmSettings(settingsFile = DEFAULT_SETTINGS_FILE, options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_SETTINGS_CACHE_TTL_MS;
  const now = Date.now();
  const entry = getCacheEntry(settingsFile);

  if (ttlMs > 0 && entry.checkedAt && now - entry.checkedAt < ttlMs) {
    return entry.settings;
  }

  entry.checkedAt = now;

  try {
    if (!fs.existsSync(settingsFile)) {
      entry.mtimeMs = null;
      entry.settings = {};
      return entry.settings;
    }

    const stat = fs.statSync(settingsFile);
    if (entry.mtimeMs === stat.mtimeMs) {
      return entry.settings;
    }

    entry.mtimeMs = stat.mtimeMs;
    entry.settings = readSettingsFromCache(settingsFile);
    return entry.settings;
  } catch {
    return entry.settings || {};
  }
}

function getAntigravityIdeVersionSettings() {
  const settings = getMitmSettings();
  return {
    enabled: settings.mitmAntigravityIdeVersionOverrideEnabled === true,
    version: normalizeAntigravityIdeVersion(settings.mitmAntigravityIdeVersion),
  };
}

function getAntigravityHostRewriteTarget(host) {
  const settings = getMitmSettings();
  const enabled = settings.mitmAntigravityHostRewriteEnabled !== false;
  if (!enabled) return host;
  if (host === "cloudcode-pa.googleapis.com") {
    return "daily-cloudcode-pa.googleapis.com";
  }
  return host;
}

function resetMitmSettingsCache(file = null) {
  if (file) { settingsCache.delete(file); return; }
  settingsCache.clear();
}

module.exports = {
  DEFAULT_ANTIGRAVITY_IDE_VERSION,
  DEFAULT_SETTINGS_FILE,
  getAntigravityHostRewriteTarget,
  getAntigravityIdeVersionSettings,
  getMitmSettings,
  normalizeAntigravityIdeVersion,
  resetMitmSettingsCache,
};
