const https = require("https");
const fs = require("fs");
const path = require("path");
const dns = require("dns");
const { promisify } = require("util");
const { log, err } = require("./logger");
const { TARGET_HOSTS, URL_PATTERNS, getToolForHost } = require("./config");
const { DATA_DIR, MITM_DIR } = require("./paths");
const {
  getMappedModelSelection,
  getMitmAliasStrategy,
  shouldPassthroughModel,
  tryMappedModels,
} = require("./modelMapping");
const { isTokenSwapEnabled, getAllActiveConnections, triggerRefreshIfNeeded,
        forceRefreshConnection, setCooldown, setAuthCooldown, setModelCooldown,
        recordStrike, recordModelStrike, clearStrikes, clearModelStrikes,
        getTokenSwapStrategy,
        parseQuotaCooldown, shouldImmediateQuotaCooldown,
        autoDisableAccountIfSonnetQuotaZero,
        markAccountUsed, getConnectionLabel, getTokenSwapAvailabilitySummary,
        getAntigravity503RetryCount } = require("./tokenPool");
const { createAntigravityDebugContext, extractBearerToken, maskToken } = require("./antigravityDebugLog");
const { getCertForDomain } = require("./cert/generate");
const { buildInputOnlyRequestDetail, createTokenSwapUsageObserver, generateDetailId } = require("./usageTracker");
const { pushHealthEvent, getLastEventStatus, migrateToEmailKeys } = require("./healthStore");

const { applyRtkCompression } = require("./rtkCompressor");
const { applyAntigravityIdeVersionOverride } = require("./antigravityIdeVersion");
const { getAntigravityHostRewriteTarget } = require("./mitmSettings");

const DB_FILE = path.join(DATA_DIR, "db.json");
const LOCAL_PORT = 443;
const INTERNAL_REQUEST_HEADER = { name: "x-request-source", value: "local" };

/**
 * Record account health event to disk (fire-and-forget, never blocks request flow).
 * @param {string} accountKey - Stable key (email preferred, falls back to connection ID)
 * @param {"success"|"retry_success"|"fail"} status
 * @param {number} attempts - Total attempts including retries
 * @param {string|null} model
 */
function reportHealth(accountKey, status, attempts, model) {
  try {
    pushHealthEvent(accountKey, status, attempts || 1, model || null);
  } catch { /* ignore — health tracking must never affect request flow */ }
}

// Map MITM tool → provider name in providerConnections
const TOOL_TO_PROVIDER = {
  antigravity: "antigravity",
  // copilot: "copilot",   // future
  // kiro: "kiro",         // future
};


// Load handlers — dev/ overrides handlers/ for private implementations
function loadHandler(name) {
  try { return require(`./dev/${name}`); } catch {}
  return require(`./handlers/${name}`);
}

const handlers = {
  antigravity: loadHandler("antigravity"),
  copilot: loadHandler("copilot"),
  kiro: loadHandler("kiro"),
  cursor: loadHandler("cursor"),
};

// ── SSL / SNI ─────────────────────────────────────────────────

const certCache = new Map();
let rootCAPem;

function sniCallback(servername, cb) {
  try {
    if (certCache.has(servername)) return cb(null, certCache.get(servername));
    const certData = getCertForDomain(servername);
    if (!certData) return cb(new Error(`Failed to generate cert for ${servername}`));
    const ctx = require("tls").createSecureContext({
      key: certData.key,
      cert: `${certData.cert}\n${rootCAPem}`
    });
    certCache.set(servername, ctx);
    log(`🔐 Cert generated: ${servername}`);
    cb(null, ctx);
  } catch (e) {
    err(`SNI error for ${servername}: ${e.message}`);
    cb(e);
  }
}

let sslOptions;
try {
  const rootKey = fs.readFileSync(path.join(MITM_DIR, "rootCA.key"));
  const rootCert = fs.readFileSync(path.join(MITM_DIR, "rootCA.crt"));
  rootCAPem = rootCert.toString("utf8");
  sslOptions = { key: rootKey, cert: rootCert, SNICallback: sniCallback };
} catch (e) {
  err(`Root CA not found: ${e.message}`);
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────

const cachedTargetIPs = {};
const CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveTargetIP(hostname) {
  const cached = cachedTargetIPs[hostname];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.ip;
  const resolver = new dns.Resolver();
  resolver.setServers(["8.8.8.8"]);
  const resolve4 = promisify(resolver.resolve4.bind(resolver));
  const addresses = await resolve4(hostname);
  cachedTargetIPs[hostname] = { ip: addresses[0], ts: Date.now() };
  return cachedTargetIPs[hostname].ip;
}

function collectBodyRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Extract model from URL path (Gemini), body (OpenAI/Anthropic), or Kiro conversationState
function extractModel(url, body) {
  const urlMatch = url.match(/\/models\/([^/:]+)/);
  if (urlMatch) return urlMatch[1];
  try {
    const parsed = JSON.parse(body.toString());
    if (parsed.conversationState) {
      return parsed.conversationState.currentMessage?.userInputMessage?.modelId || null;
    }
    return parsed.model || null;
  } catch { return null; }
}

/**
 * Forward request to real upstream.
 * Optional onResponse(rawBuffer) callback — if provided, tees the response
 * so it's both forwarded to client AND passed to the callback for inspection.
 */
async function passthrough(req, res, bodyBuffer, onResponse, debugContext = null) {
  let targetHost = (req.headers.host || TARGET_HOSTS[0]).split(":")[0];
  const rewrittenHost = getAntigravityHostRewriteTarget(targetHost, DB_FILE);
  if (rewrittenHost !== targetHost) targetHost = rewrittenHost;
  const targetIP = await resolveTargetIP(targetHost);
  const tool = getToolForHost(req.headers.host);
  const versionOverride = tool === "antigravity"
    ? applyAntigravityIdeVersionOverride(bodyBuffer, req.headers, DB_FILE, log)
    : { bodyBuffer, headers: req.headers };
  const bodyForForwarding = versionOverride.bodyBuffer;
  const headersForForwarding = {
    ...versionOverride.headers,
    host: targetHost,
  };
  if (bodyForForwarding !== bodyBuffer) {
    headersForForwarding["content-length"] = String(bodyForForwarding.length);
  }

  const forwardReq = https.request({
    hostname: targetIP,
    port: 443,
    path: req.url,
    method: req.method,
    headers: headersForForwarding,
    servername: targetHost,
    rejectUnauthorized: false
  }, (forwardRes) => {
    res.writeHead(forwardRes.statusCode, forwardRes.headers);
    const chunks = [];
    forwardRes.on("data", chunk => {
      chunks.push(chunk);
      res.write(chunk);
    });
    forwardRes.on("end", () => {
      res.end();
      const rawBuffer = Buffer.concat(chunks);
      try { onResponse?.(rawBuffer, forwardRes.headers, forwardRes.statusCode); } catch { /* ignore */ }
      debugContext?.logResponse({
        statusCode: forwardRes.statusCode,
        headers: forwardRes.headers,
        bodyBuffer: rawBuffer,
        streamed: String(forwardRes.headers["content-type"] || "").includes("text/event-stream"),
        note: "Direct upstream passthrough response",
      });
    });
  });

  forwardReq.on("error", (e) => {
    err(`Passthrough error: ${e.message}`);
    debugContext?.logError("passthrough.error", e, { targetHost, url: req.url });
    if (!res.headersSent) res.writeHead(502);
    res.end("Bad Gateway");
  });

  if (bodyForForwarding.length > 0) forwardReq.write(bodyForForwarding);
  forwardReq.end();
}

// ── Token swap forward ────────────────────────────────────────
// Unlike passthrough(), this checks upstream statusCode BEFORE
// piping to client — enabling auto-retry on 403/429/503.

async function tokenSwapForward(req, res, bodyBuffer, connections, model, strategy, provider, requestStartTime, debugContext = null) {
  let targetHost = (req.headers.host || TARGET_HOSTS[0]).split(":")[0];
  const rewrittenHost = getAntigravityHostRewriteTarget(targetHost, DB_FILE);
  if (rewrittenHost !== targetHost) targetHost = rewrittenHost;
  const targetIP = await resolveTargetIP(targetHost);
  let lastRetryResponse = null;

  const versionOverride = provider === "antigravity"
    ? applyAntigravityIdeVersionOverride(bodyBuffer, req.headers, DB_FILE, log)
    : { bodyBuffer, headers: req.headers };
  const bodyForForwarding = versionOverride.bodyBuffer;
  const headersForForwarding = versionOverride.headers;

  // ── RTK compression (see src/mitm/rtkCompressor.js) ──
  const effectiveBody = await applyRtkCompression(bodyForForwarding, DB_FILE, log);

  for (let i = 0; i < connections.length; i++) {
    const originalConn = connections[i];
    let conn = await triggerRefreshIfNeeded(originalConn);
    let authRefreshAttempted = false;

    while (true) {
      const label = getConnectionLabel(conn);
      const modelTag = model ? ` model=${model}` : "";
      const posTag = connections.length > 1 ? ` [${i + 1}/${connections.length}]` : "";
      const recencyTag = conn.lastUsedAt ? ` lastUsed=${conn.lastUsedAt}` : " lastUsed=never";
      log(`🔑 [token-swap]${posTag} trying "${label}"${modelTag}${recencyTag}`);
      debugContext?.log("token_swap.attempt", {
        strategy,
        position: i + 1,
        total: connections.length,
        lastUsedAt: conn.lastUsedAt || null,
        accessTokenMasked: maskToken(conn.accessToken),
        ...{
          connectionId: conn.id || null,
          accountEmail: conn.email || null,
          accountName: conn.name || null,
        },
      });

      const swappedHeaders = {
        ...headersForForwarding,
        host: targetHost,
        authorization: `Bearer ${conn.accessToken}`
      };
      // Update Content-Length if the MITM changed the request body.
      if (effectiveBody !== bodyBuffer) {
        swappedHeaders['content-length'] = String(effectiveBody.length);
      }

      try {
        const result = await new Promise((resolve, reject) => {
          const forwardReq = https.request({
            hostname: targetIP,
            port: 443,
            path: req.url,
            method: req.method,
            headers: swappedHeaders,
            servername: targetHost,
            rejectUnauthorized: false
          }, (forwardRes) => {
            if (forwardRes.statusCode === 403 || forwardRes.statusCode === 429 || forwardRes.statusCode === 503 || forwardRes.statusCode === 401) {
              const chunks = [];
              forwardRes.on("data", c => chunks.push(c));
              forwardRes.on("end", () => {
                const body = Buffer.concat(chunks).toString();
                const retryType = forwardRes.statusCode === 401
                  ? "auth"
                  : forwardRes.statusCode === 403
                    ? "permission"
                    : "quota";
                resolve({ retry: true, retryType, body, headers: forwardRes.headers, statusCode: forwardRes.statusCode });
              });
            } else {
              resolve({ retry: false, response: forwardRes });
            }
          });
          forwardReq.on("error", reject);
          if (effectiveBody.length > 0) forwardReq.write(effectiveBody);
          forwardReq.end();
        });

        if (result.retry && (result.retryType === "quota" || result.retryType === "permission")) {
          // ── Unified retry: 403 IAM denial, 429 and 503 treated identically ──
          // Both are false-positive-prone from Antigravity; retry same account
          // with exponential backoff before moving on.
          const maxRetries = getAntigravity503RetryCount(conn.antigravity503RetryCount);
          if (!conn._quotaRetryCount) conn._quotaRetryCount = 0;
          conn._quotaRetryCount++;

          if (conn._quotaRetryCount < maxRetries) {
            const backoffMs = Math.min(1000 * Math.pow(2, conn._quotaRetryCount - 1), 10000);
            log(`🔄 [token-swap] "${label}" → ${result.statusCode} retry ${conn._quotaRetryCount}/${maxRetries} after ${backoffMs / 1000}s`);
            debugContext?.log("token_swap.quota_retry", {
              statusCode: result.statusCode,
              attempt: conn._quotaRetryCount,
              maxRetries,
              backoffMs,
              connectionId: conn.id || null,
            });
            await new Promise(r => setTimeout(r, backoffMs));
            continue; // retry same account
          }

          log(`⚠️ [token-swap] "${label}" → ${result.statusCode} exhausted ${maxRetries} retries, trying next...`);

          // ── 2-consecutive-fail rule: only apply cooldown/strike if this
          // account's last health event was already a fail. A single transient
          // 403/429/503 burst doesn't warrant a cooldown. ──
          const accountKey = conn.email || conn.id;
          const lastStatus = getLastEventStatus(accountKey);
          const isConsecutiveFail = lastStatus === "fl";

          const cooldownMs = parseQuotaCooldown(result.body);
          const cdLabel = cooldownMs ? ` cooldown=${Math.ceil(cooldownMs / 60000)}m` : "";
          const immediateCooldown = shouldImmediateQuotaCooldown(result.statusCode, result.body);
          const autoDisabled = autoDisableAccountIfSonnetQuotaZero(conn, {
            statusCode: result.statusCode,
            model,
          });
          lastRetryResponse = {
            statusCode: result.statusCode,
            headers: result.headers,
            body: result.body,
          };
          debugContext?.log("token_swap.retryable_error", {
            strategy,
            statusCode: result.statusCode,
            retryType: result.retryType,
            consecutiveFail: isConsecutiveFail,
            responseHeaders: result.headers,
            responseBody: result.body,
            ...{
              connectionId: conn.id || null,
              accountEmail: conn.email || null,
              accountName: conn.name || null,
            },
          });

          if (autoDisabled) {
            log(`⚠️ [token-swap] "${label}" → ${result.statusCode} auto-disabled because Claude Sonnet 4.6 quota is 0%, trying next...`);
          } else if (isConsecutiveFail) {
            // 2nd consecutive fail — apply cooldown/strike as normal
            if (strategy === "sticky" && model) {
              if (immediateCooldown) {
                setModelCooldown(conn.id, model, cooldownMs);
                log(`⚠️ [token-swap] "${label}" → ${result.statusCode} model=${model} COOLDOWN${cdLabel}, trying next...`);
              } else {
                const locked = recordModelStrike(conn.id, model, cooldownMs);
                log(`⚠️ [token-swap] "${label}" → ${result.statusCode} model=${model}${locked ? " LOCKED" : " strike"}${cdLabel}, trying next...`);
              }
            } else {
              if (immediateCooldown) {
                setCooldown(conn.id, cooldownMs);
                log(`⚠️ [token-swap] "${label}" → ${result.statusCode} COOLDOWN${cdLabel}, trying next...`);
              } else {
                const locked = recordStrike(conn.id, cooldownMs);
                log(`⚠️ [token-swap] "${label}" → ${result.statusCode}${locked ? " LOCKED" : " strike"}${cdLabel}, trying next...`);
              }
            }
          } else {
            // 1st fail — skip this account but don't penalise it yet
            log(`⚠️ [token-swap] "${label}" → ${result.statusCode} (1st fail, no cooldown), trying next...`);
          }

          reportHealth(conn.email || conn.id, "fail", conn._quotaRetryCount || 1, model);
          break;
        }

        if (result.retry && result.retryType === "auth") {
          const retryableAuth = isRetryableAuthFailure(result.statusCode, result.headers, result.body);
          if (!retryableAuth) {
            debugContext?.log("token_swap.non_retryable_auth", {
              strategy,
              statusCode: result.statusCode,
              responseHeaders: result.headers,
              responseBody: result.body,
              ...{
                connectionId: conn.id || null,
                accountEmail: conn.email || null,
                accountName: conn.name || null,
              },
            });
            res.writeHead(result.statusCode, result.headers);
            res.end(result.body);
            return true;
          }

          if (!authRefreshAttempted && conn.refreshToken) {
            authRefreshAttempted = true;
            log(`⚠️ [token-swap] "${label}" → 401 invalid_token, forcing refresh...`);
            const refreshResult = await forceRefreshConnection(conn);
            conn = refreshResult.connection || conn;
            if (refreshResult.refreshed) {
              log(`↻ [token-swap] "${label}" refreshed, retrying same account...`);
              continue;
            }
          }

          setAuthCooldown(conn.id);
          lastRetryResponse = {
            statusCode: result.statusCode,
            headers: result.headers,
            body: result.body,
          };
          debugContext?.log("token_swap.retryable_error", {
            strategy,
            statusCode: result.statusCode,
            retryType: result.retryType,
            responseHeaders: result.headers,
            responseBody: result.body,
            ...{
              connectionId: conn.id || null,
              accountEmail: conn.email || null,
              accountName: conn.name || null,
            },
          });
          log(`⚠️ [token-swap] "${label}" → 401 invalid_token, trying next...`);
          reportHealth(conn.email || conn.id, "fail", 1, model);
          break;
        }

        const statusCode = result.response.statusCode || 0;
        const successModelTag = model ? ` model=${model}` : "";
        const successStrategyTag = strategy === "sticky" ? " sticky" : " rr-lru";
        log(`✅ [token-swap] "${label}" → ${statusCode}${successModelTag}${successStrategyTag}`);
        // Clear strikes on success — previous 429s were likely false positives
        clearStrikes(conn.id);
        if (model) clearModelStrikes(conn.id, model);
        markAccountUsed(conn.id);
        // Record health: success on first try vs retry success (403/429/503 retries count)
        const _healthAttempts = (conn._quotaRetryCount || 0) + 1;
        reportHealth(conn.email || conn.id, _healthAttempts > 1 ? "retry_success" : (i > 0 ? "retry_success" : "success"), _healthAttempts, model);
        res.writeHead(statusCode, result.response.headers);

        const detailId = generateDetailId(model);
        const inputOnlyDetail = buildInputOnlyRequestDetail({
          detailId,
          provider,
          model,
          connectionId: conn.id,
          bodyBuffer
        });
        fetch("http://127.0.0.1:20128/api/internal/request-detail", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [INTERNAL_REQUEST_HEADER.name]: INTERNAL_REQUEST_HEADER.value
          },
          body: JSON.stringify(inputOnlyDetail)
        }).catch((detailError) => {
          err(`[token-swap] failed to create request detail for "${label}": ${detailError.message}`);
        });

        const usageObserver = createTokenSwapUsageObserver({
          provider,
          model,
          connectionId: conn.id,
          accountLabel: label,
          bodyBuffer,
          contentType: result.response.headers["content-type"] || "",
          contentEncoding: result.response.headers["content-encoding"] || "",
          statusCode,
          detailRecord: inputOnlyDetail,
          requestStartTime
        });
        const responseChunks = [];

        result.response.on("data", (chunk) => {
          usageObserver.onChunk(chunk);
          responseChunks.push(chunk);
          res.write(chunk);
        });
        result.response.on("end", () => {
          res.end();
          debugContext?.logResponse({
            statusCode,
            headers: result.response.headers,
            bodyBuffer: Buffer.concat(responseChunks),
            streamed: true,
            note: "Token-swap upstream response",
            extra: {
              strategy,
              connectionId: conn.id || null,
              accountEmail: conn.email || null,
              accountName: conn.name || null,
            },
          });
          usageObserver.onEnd().catch(() => {});
        });
        result.response.on("error", (streamError) => {
          err(`[token-swap] upstream stream error for "${label}": ${streamError.message}`);
          debugContext?.logError("token_swap.stream_error", streamError, {
            strategy,
            connectionId: conn.id || null,
            accountEmail: conn.email || null,
            accountName: conn.name || null,
          });
          if (!res.writableEnded) res.end();
        });
        return true;
      } catch (e) {
        err(`[token-swap] error for "${label}": ${e.message}`);
        const autoDisabled = autoDisableAccountIfSonnetQuotaZero(conn, {
          statusCode: "network_error",
          model,
        });
        if (autoDisabled) {
          log(`⚠️ [token-swap] "${label}" auto-disabled because Claude Sonnet 4.6 quota is 0%, trying next...`);
        }
        debugContext?.logError("token_swap.error", e, {
          strategy,
          connectionId: conn.id || null,
          accountEmail: conn.email || null,
          accountName: conn.name || null,
        });
        reportHealth(conn.email || conn.id, "fail", 1, model);
        break;
      }
    }
  }

  if (lastRetryResponse) {
    log(`⚠️ [token-swap] exhausted ${connections.length} account(s), returning last retryable ${lastRetryResponse.statusCode}`);
    debugContext?.log("token_swap.exhausted", {
      attemptedAccounts: connections.length,
      statusCode: lastRetryResponse.statusCode,
      responseHeaders: lastRetryResponse.headers,
      responseBody: lastRetryResponse.body,
    });
    res.writeHead(lastRetryResponse.statusCode, lastRetryResponse.headers);
    res.end(lastRetryResponse.body);
    return true;
  }

  // All accounts exhausted with no retryable upstream response captured
  return false;
}

function getHeaderValue(headers, name) {
  const value = headers?.[String(name).toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return typeof value === "string" ? value : "";
}

function isRetryableAuthFailure(statusCode, headers, body) {
  if (statusCode !== 401) return false;

  const authHeader = getHeaderValue(headers, "www-authenticate").toLowerCase();
  if (authHeader.includes("invalid_token")) return true;

  try {
    const parsed = JSON.parse(body || "{}");
    const status = String(parsed?.error?.status || parsed?.status || "").toUpperCase();
    const message = String(parsed?.error?.message || parsed?.message || "").toLowerCase();
    if (status === "UNAUTHENTICATED") return true;
    if (message.includes("invalid authentication credentials")) return true;
    if (message.includes("invalid token")) return true;
    if (message.includes("unauthenticated")) return true;
  } catch {
    const fallback = String(body || "").toLowerCase();
    if (fallback.includes("invalid authentication credentials")) return true;
    if (fallback.includes("invalid token")) return true;
    if (fallback.includes("unauthenticated")) return true;
  }

  return false;
}

// ── Request handler ───────────────────────────────────────────

const server = https.createServer(sslOptions, async (req, res) => {
  let debugContext = null;
  try {
    if (req.url === "/_mitm_health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }

    const host = (req.headers.host || "").split(":")[0];
    log(`📥 [request] ${req.method} ${host}${req.url}`);

    const bodyCollectStart = Date.now();
    const bodyBuffer = await collectBodyRaw(req);
    log(`📦 [request] body collected: ${bodyBuffer.length}B in ${Date.now() - bodyCollectStart}ms from ${host}`);

    // Anti-loop: skip requests from 9Router
    if (req.headers[INTERNAL_REQUEST_HEADER.name] === INTERNAL_REQUEST_HEADER.value) {
      // log(`🔁 [request] anti-loop skip: ${host}${req.url}`);
      return passthrough(req, res, bodyBuffer);
    }

    const tool = getToolForHost(req.headers.host);
    if (!tool) {
      // log(`⏩ [request] no tool for host="${host}", passthrough`);
      return passthrough(req, res, bodyBuffer);
    }

    const model = tool !== "cursor" ? extractModel(req.url, bodyBuffer) : null;
    debugContext = tool === "antigravity"
      ? createAntigravityDebugContext({ req, bodyBuffer, model })
      : null;
    debugContext?.logRequest({ tool });

    const patterns = URL_PATTERNS[tool] || [];
    const isChat = patterns.some(p => req.url.includes(p));
    if (!isChat) {
      // log(`⏩ [request] url="${req.url}" not a chat pattern for tool=${tool}, passthrough`);
      debugContext?.log("route.selected", {
        tool,
        mode: "passthrough",
        reason: "non_chat_pattern",
      });
      return passthrough(req, res, bodyBuffer, null, debugContext);
    }

    // Extract model early — needed for sticky token-swap strategy and mitmAlias.
    // Cursor uses binary proto so model extraction is deferred to its handler.
    log(`🧩 [request] tool=${tool} model="${model || "unknown"}" url=${req.url}`);

    if (shouldPassthroughModel({ tool, model })) {
      log(`⏩ [${tool}] passthrough forced for model="${model}"`);
      debugContext?.log("route.selected", {
        tool,
        mode: "passthrough",
        reason: "forced_model_passthrough",
      });
      return passthrough(req, res, bodyBuffer, null, debugContext);
    }

    // ── TOKEN SWAP: rotate auth tokens before mitmAlias ──────
    const swapProvider = TOOL_TO_PROVIDER[tool];
    if (swapProvider && isTokenSwapEnabled(swapProvider)) {
      const strategy = getTokenSwapStrategy();
      const poolConns = getAllActiveConnections(swapProvider, model);
      if (poolConns.length > 0) {
        const availability = getTokenSwapAvailabilitySummary(swapProvider, model);
        log(`🔑 [${tool}] token-swap: ${availability.summaryText} (strategy=${strategy}${model ? `, model=${model}` : ""})`);
        debugContext?.log("route.selected", {
          tool,
          mode: "token_swap",
          strategy,
          availability: availability.summaryText,
        });
        const handled = await tokenSwapForward(req, res, bodyBuffer, poolConns, model, strategy, swapProvider, bodyCollectStart, debugContext);
        if (handled) return;
        log(`⚠️ [${tool}] token-swap: all accounts exhausted, falling through to original token`);
        debugContext?.log("token_swap.fallthrough", {
          tool,
          strategy,
          reason: "all_accounts_exhausted",
        });
      } else {
        log(`⚠️ [token-swap] 0 active connections for provider=${swapProvider} model="${model || "any"}" — all on cooldown?`);
        debugContext?.log("token_swap.unavailable", {
          tool,
          strategy,
          reason: "no_active_connections",
        });
      }
    }

    log(`🔍 [${tool}] url=${req.url} | bodyLen=${bodyBuffer.length}`);

    // Cursor uses binary proto — model extraction not possible at this layer.
    // Delegate directly to handler which decodes proto internally.
    if (tool === "cursor") {
      log(`⚡ intercept | cursor | proto`);
      return handlers[tool].intercept(req, res, bodyBuffer, null, passthrough);
    }

    log(`🔍 [${tool}] model="${model}"`);

    const mappedSelection = getMappedModelSelection({ dbFile: DB_FILE, tool, model });
    if (!mappedSelection) {
      // log(`⏩ passthrough | no mapping | ${tool} | ${model || "unknown"}`);
      debugContext?.log("route.selected", {
        tool,
        mode: "passthrough",
        reason: "no_mapping",
      });
      return passthrough(req, res, bodyBuffer, null, debugContext);
    }

    const { aliasKey, models: mappedModels } = mappedSelection;
    const strategy = getMitmAliasStrategy({ dbFile: DB_FILE });
    const strategyTag = strategy === "round-robin" ? "rr" : "fb";
    log(`⚡ intercept | ${tool} | mode=${strategyTag} | ${model} → ${mappedModels.join(", ")}`);
    debugContext?.log("route.selected", {
      tool,
      mode: "mapped",
      aliasKey,
      mappedModels,
      strategy,
    });
    const handled = await tryMappedModels({
      dbFile: DB_FILE,
      req,
      res,
      bodyBuffer,
      models: mappedModels,
      tool,
      aliasKey,
      strategy,
      handlers,
      interceptOptions: { debugContext },
      log,
      err,
    });

    if (!handled && !res.headersSent) {
      debugContext?.log("mapped_models.exhausted", {
        tool,
        mappedModels,
        strategy,
      });
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: { message: `All ${mappedModels.length} mapped models failed`, type: "mitm_error" }
      }));
    }
    return;
  } catch (e) {
    err(`Unhandled error: ${e.message}`);
    debugContext?.logError("request.unhandled_error", e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: e.message, type: "mitm_error" } }));
  }
});

server.listen(LOCAL_PORT, () => {
  log(`🚀 Server ready on :${LOCAL_PORT}`);

  // One-time migration: convert old UUID-keyed health data to email-keyed data
  try {
    if (fs.existsSync(DB_FILE)) {
      const db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
      const connections = (db.providerConnections || []).filter(c => c.email);
      if (connections.length > 0) migrateToEmailKeys(connections);
    }
  } catch { /* ignore — migration is best-effort */ }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") err(`Port ${LOCAL_PORT} already in use`);
  else if (e.code === "EACCES") err(`Permission denied for port ${LOCAL_PORT}`);
  else err(e.message);
  process.exit(1);
});

process.setMaxListeners(0);
const { removeAllDNSEntriesSync } = require("./dns/dnsConfig");
let isShuttingDown = false;
const shutdown = () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  // Strip tool hosts from /etc/hosts so other apps aren't broken after exit
  removeAllDNSEntriesSync();
  const forceExit = setTimeout(() => process.exit(0), 1500);
  server.close(() => { clearTimeout(forceExit); process.exit(0); });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
if (process.platform === "win32") process.on("SIGBREAK", shutdown);
