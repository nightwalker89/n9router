"use strict";

const {
  DEFAULT_ANTIGRAVITY_IDE_VERSION,
  getAntigravityIdeVersionSettings,
  normalizeAntigravityIdeVersion,
} = require("./mitmSettings");

function loadAntigravityIdeVersionSettings(dbFile) {
  return getAntigravityIdeVersionSettings(dbFile);
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
        log(`🛰️ [antigravity] user-agent version override → ${settings.version}`);
      }
      return { bodyBuffer, headers: nextHeaders, applied: userAgentChanged, version: settings.version };
    }

    const previousVersion = parsed.metadata.ideVersion;
    parsed.metadata.ideVersion = settings.version;

    const nextBodyBuffer = Buffer.from(JSON.stringify(parsed));
    log(`🛰️ [antigravity] IDE version override: ${previousVersion || "unknown"} → ${settings.version}`);
    return {
      bodyBuffer: nextBodyBuffer,
      headers: nextHeaders,
      applied: true,
      version: settings.version,
    };
  } catch (e) {
    if (userAgentChanged) {
      log(`🛰️ [antigravity] user-agent version override → ${settings.version}`);
      return { bodyBuffer, headers: nextHeaders, applied: true, version: settings.version };
    }
    log(`🛰️ [antigravity] IDE version override skipped: ${e.message}`);
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
