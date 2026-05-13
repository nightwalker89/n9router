"use strict";
/**
 * rtkCompressor.js — RTK (Token Killer) compression for the MITM token-swap path.
 *
 * All RTK logic lives here so server.js stays minimal.
 * Export: applyRtkCompression(bodyBuffer, log) → Buffer
 *
 * The MITM process is CJS; RTK modules are ESM — loaded via dynamic import().
 */

const fs = require("fs");
const path = require("path");
const { getMitmSettings } = require("./mitmSettings");

// ── Lazy ESM module loaders ──────────────────────────────────────────────────

let _rtkModule = null;
async function loadRtkModule() {
  if (_rtkModule) return _rtkModule;
  try {
    _rtkModule = await import(path.resolve(__dirname, "../../open-sse/rtk/index.js"));
  } catch (e) {
    _rtkModule = { compressMessages: () => null, formatRtkLog: () => null, setRtkEnabled: () => {} };
    throw new Error(`RTK index load failed: ${e.message}`);
  }
  return _rtkModule;
}

let _rtkGeminiModule = null;
async function loadRtkGeminiModule() {
  if (_rtkGeminiModule) return _rtkGeminiModule;
  try {
    _rtkGeminiModule = await import(path.resolve(__dirname, "../../open-sse/rtk/antigravity.js"));
  } catch (e) {
    _rtkGeminiModule = { compressContents: () => null };
    throw new Error(`RTK gemini load failed: ${e.message}`);
  }
  return _rtkGeminiModule;
}

// ── Schema dumper (debug only) ───────────────────────────────────────────────

let _dumpCount = 0;
function stripSchema(val, depth = 0) {
  if (val === null || val === undefined) return null;
  if (typeof val === "string") return `str:${val.length}B`;
  if (typeof val === "number" || typeof val === "boolean") return val;
  if (Array.isArray(val)) {
    if (val.length > 4 && depth > 0) {
      return [...val.slice(0, 3).map(v => stripSchema(v, depth + 1)), `…${val.length - 3} more`];
    }
    return val.map(v => stripSchema(v, depth + 1));
  }
  if (typeof val === "object") {
    const out = {};
    for (const k of Object.keys(val)) out[k] = stripSchema(val[k], depth + 1);
    return out;
  }
  return typeof val;
}

function dumpSchema(parsed, label, log) {
  try {
    const n = ++_dumpCount;
    const file = `/tmp/rtk-schema-${n}.json`;
    fs.writeFileSync(file, JSON.stringify({ _label: label, schema: stripSchema(parsed) }, null, 2));
    log(`🗜️ [token-swap] RTK schema → ${file}`);
  } catch { /* non-critical */ }
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Apply RTK compression to a token-swap request body if enabled in settings.
 *
 * @param {Buffer}   bodyBuffer  - Raw request body
 * @param {Function} log         - MITM log function
 * @returns {Promise<Buffer>}      Compressed body (or original if unchanged)
 */
async function applyRtkCompression(bodyBuffer, log) {
  try {
    if (!getMitmSettings().rtkEnabled) return bodyBuffer;

    const parsed = JSON.parse(bodyBuffer.toString());

    // Antigravity wraps Gemini body: { request: { contents: [...] }, model, ... }
    // Raw Gemini direct:             { contents: [...] }
    const geminiBody = (parsed?.request && Array.isArray(parsed.request.contents))
      ? parsed.request
      : parsed;

    const hasMessages = Array.isArray(parsed?.messages);
    const hasContents = Array.isArray(geminiBody?.contents);

    if (!hasMessages && !hasContents) {
      // dumpSchema(parsed, "unknown-format", log);
      return bodyBuffer;
    }

    // dumpSchema(parsed, `${hasMessages ? "openai" : "gemini"}-${bodyBuffer.length}B`, log);

    const rtk = await loadRtkModule();
    rtk.setRtkEnabled(true);

    const rtkStats = hasMessages
      ? rtk.compressMessages(parsed)
      : (await loadRtkGeminiModule()).compressContents(geminiBody);

    if (rtkStats?.hits?.length > 0) {
      const compressed = Buffer.from(JSON.stringify(parsed));
      const saved = bodyBuffer.length - compressed.length;
      log(`🗜️ [token-swap] RTK compressed: ${bodyBuffer.length}B → ${compressed.length}B (saved ${saved}B) ${rtk.formatRtkLog(rtkStats) || ""}`);
      return compressed;
    }

    log(`🗜️ [token-swap] RTK enabled — no compressible content found`);
    return bodyBuffer;

  } catch (e) {
    log(`🗜️ [token-swap] RTK error: ${e.stack || e.message}`);
    return bodyBuffer;
  }
}

module.exports = { applyRtkCompression };
