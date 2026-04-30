"use strict";

const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./paths");

const DEFAULT_DB_FILE = path.join(DATA_DIR, "db.json");
const DEFAULT_ANTIGRAVITY_IDE_VERSION = "1.23.2";
const DEFAULT_SETTINGS_CACHE_TTL_MS = 1000;

const settingsCache = new Map();

function normalizeAntigravityIdeVersion(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || DEFAULT_ANTIGRAVITY_IDE_VERSION;
}

function getCacheEntry(dbFile) {
  let entry = settingsCache.get(dbFile);
  if (!entry) {
    entry = {
      checkedAt: 0,
      mtimeMs: null,
      settings: {},
    };
    settingsCache.set(dbFile, entry);
  }
  return entry;
}

function readSettingsFromDb(dbFile) {
  const db = JSON.parse(fs.readFileSync(dbFile, "utf-8"));
  const settings = db?.settings;
  return settings && typeof settings === "object" && !Array.isArray(settings)
    ? settings
    : {};
}

function getMitmSettings(dbFile = DEFAULT_DB_FILE, options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_SETTINGS_CACHE_TTL_MS;
  const now = Date.now();
  const entry = getCacheEntry(dbFile);

  if (ttlMs > 0 && entry.checkedAt && now - entry.checkedAt < ttlMs) {
    return entry.settings;
  }

  entry.checkedAt = now;

  try {
    if (!fs.existsSync(dbFile)) {
      entry.mtimeMs = null;
      entry.settings = {};
      return entry.settings;
    }

    const stat = fs.statSync(dbFile);
    if (entry.mtimeMs === stat.mtimeMs) {
      return entry.settings;
    }

    entry.mtimeMs = stat.mtimeMs;
    entry.settings = readSettingsFromDb(dbFile);
    return entry.settings;
  } catch {
    return entry.settings || {};
  }
}

function getAntigravityIdeVersionSettings(dbFile = DEFAULT_DB_FILE) {
  const settings = getMitmSettings(dbFile);
  return {
    enabled: settings.mitmAntigravityIdeVersionOverrideEnabled === true,
    version: normalizeAntigravityIdeVersion(settings.mitmAntigravityIdeVersion),
  };
}

function getAntigravityHostRewriteTarget(host, dbFile = DEFAULT_DB_FILE) {
  const settings = getMitmSettings(dbFile);
  const enabled = settings.mitmAntigravityHostRewriteEnabled !== false;
  if (!enabled) return host;
  if (host === "cloudcode-pa.googleapis.com") {
    return "daily-cloudcode-pa.googleapis.com";
  }
  return host;
}

function resetMitmSettingsCache(dbFile = null) {
  if (dbFile) {
    settingsCache.delete(dbFile);
    return;
  }
  settingsCache.clear();
}

module.exports = {
  DEFAULT_ANTIGRAVITY_IDE_VERSION,
  DEFAULT_DB_FILE,
  getAntigravityHostRewriteTarget,
  getAntigravityIdeVersionSettings,
  getMitmSettings,
  normalizeAntigravityIdeVersion,
  resetMitmSettingsCache,
};
