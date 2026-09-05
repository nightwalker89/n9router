"use strict";

const {
  DEFAULT_ANTIGRAVITY_IDE_VERSION,
  getAntigravityIdeVersionSettings,
  normalizeAntigravityIdeVersion,
} = require("./mitmSettings");

const ANTIGRAVITY_IDE_VERSION = "2.11.0";
const ANTIGRAVITY_IDE_VERSION_OVERRIDE_ENABLED = true;

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

function isDbFile(val) {
  return typeof val === "string" && val.endsWith(".json");
}

function isUrlString(val) {
  return typeof val === "string" && !val.endsWith(".json") && (val.startsWith("/") || val.includes(":"));
}

function applyAntigravityIdeVersionOverride(bodyBuffer, headers, dbFileOrUrl, logOrUrl = () => {}, requestUrl = null) {
  let targetVersion = ANTIGRAVITY_IDE_VERSION;
  let enabled = true;
  let log = typeof logOrUrl === "function" ? logOrUrl : () => {};
  let url = requestUrl || (isUrlString(logOrUrl) ? logOrUrl : (isUrlString(dbFileOrUrl) ? dbFileOrUrl : null));

  if (isDbFile(dbFileOrUrl)) {
    const settings = loadAntigravityIdeVersionSettings(dbFileOrUrl);
    enabled = settings.enabled;
    targetVersion = settings.version || DEFAULT_ANTIGRAVITY_IDE_VERSION;
  } else {
    enabled = ANTIGRAVITY_IDE_VERSION_OVERRIDE_ENABLED;
    targetVersion = ANTIGRAVITY_IDE_VERSION;
  }

  if (url) {
    const isGenerationEndpoint = url.includes(":generateContent") || url.includes(":streamGenerateContent");
    if (!isGenerationEndpoint) {
      return { bodyBuffer, headers, applied: false, version: targetVersion };
    }
  }

  if (!enabled) {
    return { bodyBuffer, headers, applied: false, version: targetVersion };
  }

  const nextHeaders = { ...headers };
  const nextUserAgent = rewriteAntigravityUserAgent(nextHeaders["user-agent"], targetVersion);
  const userAgentChanged = nextUserAgent !== nextHeaders["user-agent"];
  if (userAgentChanged) {
    nextHeaders["user-agent"] = nextUserAgent;
  }

  try {
    const parsed = JSON.parse(bodyBuffer.toString());
    if (!shouldRewriteMetadata(parsed?.metadata)) {
      if (userAgentChanged) {
        log(`🛰️ [antigravity] user-agent version override → ${targetVersion}`);
        return { bodyBuffer, headers: nextHeaders, applied: true, version: targetVersion };
      }
      return { bodyBuffer, headers, applied: false, version: targetVersion };
    }

    const previousVersion = parsed.metadata.ideVersion;
    parsed.metadata.ideVersion = targetVersion;

    const nextBodyBuffer = Buffer.from(JSON.stringify(parsed));
    if (url) {
      nextHeaders["content-length"] = String(nextBodyBuffer.length);
    }
    log(`🛰️ [antigravity] IDE version override: ${previousVersion || "unknown"} → ${targetVersion}`);
    return {
      bodyBuffer: nextBodyBuffer,
      headers: nextHeaders,
      applied: true,
      version: targetVersion,
    };
  } catch (e) {
    if (userAgentChanged) {
      log(`🛰️ [antigravity] user-agent version override → ${targetVersion}`);
      return { bodyBuffer, headers: nextHeaders, applied: true, version: targetVersion };
    }
    log(`🛰️ [antigravity] IDE version override skipped: ${e.message}`);
    return { bodyBuffer, headers, applied: false, version: targetVersion };
  }
}

module.exports = {
  ANTIGRAVITY_IDE_VERSION,
  DEFAULT_ANTIGRAVITY_IDE_VERSION,
  applyAntigravityIdeVersionOverride,
  loadAntigravityIdeVersionSettings,
  normalizeAntigravityIdeVersion,
  rewriteAntigravityUserAgent,
};
