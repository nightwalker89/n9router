"use strict";

const fs = require("fs");

const DEFAULT_ANTIGRAVITY_IDE_VERSION = "1.23.2";

function normalizeAntigravityIdeVersion(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || DEFAULT_ANTIGRAVITY_IDE_VERSION;
}

function loadAntigravityIdeVersionSettings(dbFile) {
  try {
    const db = JSON.parse(fs.readFileSync(dbFile, "utf-8"));
    const settings = db?.settings || {};
    return {
      enabled: settings.mitmAntigravityIdeVersionOverrideEnabled === true,
      version: normalizeAntigravityIdeVersion(settings.mitmAntigravityIdeVersion),
    };
  } catch {
    return {
      enabled: false,
      version: DEFAULT_ANTIGRAVITY_IDE_VERSION,
    };
  }
}

function shouldRewriteMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  if (String(metadata.ideName || "").toLowerCase() === "antigravity") return true;
  if (String(metadata.ideType || "").toUpperCase() === "ANTIGRAVITY") return true;
  return Object.prototype.hasOwnProperty.call(metadata, "ideVersion");
}

function rewriteAntigravityUserAgent(userAgent, version) {
  if (typeof userAgent !== "string" || !userAgent.includes("antigravity/")) {
    return userAgent;
  }
  // TODO: remove for debugging only once we're confident the override is working
  console.log("original> user-agent", userAgent);
  console.log("original> version", version);
  console.log("new> user-agent", userAgent.replace(/antigravity\/[^\s]+/, `antigravity/${version}`));
  return userAgent.replace(/antigravity\/[^\s]+/, `antigravity/${version}`);
}

function applyAntigravityIdeVersionOverride(bodyBuffer, headers, dbFile, log = () => {}) {
  const settings = loadAntigravityIdeVersionSettings(dbFile);
  if (!settings.enabled) {
    return { bodyBuffer, headers, applied: false, version: settings.version };
  }

  const nextHeaders = { ...headers };
  const nextUserAgent = rewriteAntigravityUserAgent(nextHeaders["user-agent"], settings.version);
  const userAgentChanged = nextUserAgent !== nextHeaders["user-agent"];
  if (userAgentChanged) {
    nextHeaders["user-agent"] = nextUserAgent;
  }

  try {
    const parsed = JSON.parse(bodyBuffer.toString());
    if (!shouldRewriteMetadata(parsed?.metadata)) {
      if (userAgentChanged) {
        log(`🛰️ [token-swap] Antigravity user-agent version override → ${settings.version}`);
      }
      return { bodyBuffer, headers: nextHeaders, applied: userAgentChanged, version: settings.version };
    }

    const previousVersion = parsed.metadata.ideVersion;
    parsed.metadata.ideVersion = settings.version;

    const nextBodyBuffer = Buffer.from(JSON.stringify(parsed));
    log(`🛰️ [token-swap] Antigravity IDE version override: ${previousVersion || "unknown"} → ${settings.version}`);
    return {
      bodyBuffer: nextBodyBuffer,
      headers: nextHeaders,
      applied: true,
      version: settings.version,
    };
  } catch (e) {
    if (userAgentChanged) {
      log(`🛰️ [token-swap] Antigravity user-agent version override → ${settings.version}`);
      return { bodyBuffer, headers: nextHeaders, applied: true, version: settings.version };
    }
    log(`🛰️ [token-swap] Antigravity IDE version override skipped: ${e.message}`);
    return { bodyBuffer, headers: nextHeaders, applied: false, version: settings.version };
  }
}

module.exports = {
  DEFAULT_ANTIGRAVITY_IDE_VERSION,
  applyAntigravityIdeVersionOverride,
  loadAntigravityIdeVersionSettings,
  normalizeAntigravityIdeVersion,
  rewriteAntigravityUserAgent,
};
