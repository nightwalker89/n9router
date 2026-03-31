const https = require("https");
const fs = require("fs");
const path = require("path");
const dns = require("dns");
const { promisify } = require("util");
const { log, err } = require("./logger");
const { TARGET_HOSTS, URL_PATTERNS, getToolForHost } = require("./config");
const { DATA_DIR, MITM_DIR } = require("./paths");
const { isTokenSwapEnabled, getAllActiveConnections, triggerRefreshIfNeeded,
        setCooldown, setModelCooldown, getTokenSwapStrategy,
        parseQuotaCooldown, markAccountUsed } = require("./tokenPool");
const { getCertForDomain } = require("./cert/generate");

const DB_FILE = path.join(DATA_DIR, "db.json");
const LOCAL_PORT = 443;
const ENABLE_FILE_LOG = false;
const LOG_DIR = path.join(DATA_DIR, "logs", "mitm");
const INTERNAL_REQUEST_HEADER = { name: "x-request-source", value: "local" };

// Map MITM tool → provider name in providerConnections
const TOOL_TO_PROVIDER = {
  antigravity: "antigravity",
  // copilot: "copilot",   // future
  // kiro: "kiro",         // future
};

if (ENABLE_FILE_LOG && !fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

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

function sniCallback(servername, cb) {
  try {
    if (certCache.has(servername)) return cb(null, certCache.get(servername));
    const certData = getCertForDomain(servername);
    if (!certData) return cb(new Error(`Failed to generate cert for ${servername}`));
    const ctx = require("tls").createSecureContext({ key: certData.key, cert: certData.cert });
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
  sslOptions = {
    key: fs.readFileSync(path.join(MITM_DIR, "rootCA.key")),
    cert: fs.readFileSync(path.join(MITM_DIR, "rootCA.crt")),
    SNICallback: sniCallback
  };
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

function getMappedModel(tool, model) {
  if (!model) return null;
  try {
    if (!fs.existsSync(DB_FILE)) return null;
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    const aliases = db.mitmAlias?.[tool];
    if (!aliases) return null;
    if (aliases[model]) return aliases[model];
    // Prefix match fallback
    const prefixKey = Object.keys(aliases).find(k => k && aliases[k] && (model.startsWith(k) || k.startsWith(model)));
    return prefixKey ? aliases[prefixKey] : null;
  } catch { return null; }
}

function saveRequestLog(url, bodyBuffer) {
  if (!ENABLE_FILE_LOG) return;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = url.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 60);
    const body = JSON.parse(bodyBuffer.toString());
    fs.writeFileSync(path.join(LOG_DIR, `${ts}_${slug}.json`), JSON.stringify(body, null, 2));
  } catch { /* ignore */ }
}

/**
 * Forward request to real upstream.
 * Optional onResponse(rawBuffer) callback — if provided, tees the response
 * so it's both forwarded to client AND passed to the callback for inspection.
 */
async function passthrough(req, res, bodyBuffer, onResponse) {
  const targetHost = (req.headers.host || TARGET_HOSTS[0]).split(":")[0];
  const targetIP = await resolveTargetIP(targetHost);

  const forwardReq = https.request({
    hostname: targetIP,
    port: 443,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: targetHost },
    servername: targetHost,
    rejectUnauthorized: false
  }, (forwardRes) => {
    res.writeHead(forwardRes.statusCode, forwardRes.headers);

    if (!onResponse) {
      forwardRes.pipe(res);
      return;
    }

    // Tee: forward to client AND buffer for callback
    const chunks = [];
    forwardRes.on("data", chunk => { chunks.push(chunk); res.write(chunk); });
    forwardRes.on("end", () => {
      res.end();
      try { onResponse(Buffer.concat(chunks), forwardRes.headers); } catch { /* ignore */ }
    });
  });

  forwardReq.on("error", (e) => {
    err(`Passthrough error: ${e.message}`);
    if (!res.headersSent) res.writeHead(502);
    res.end("Bad Gateway");
  });

  if (bodyBuffer.length > 0) forwardReq.write(bodyBuffer);
  forwardReq.end();
}

// ── Token swap forward ────────────────────────────────────────
// Unlike passthrough(), this checks upstream statusCode BEFORE
// piping to client — enabling auto-retry on 429/503.

async function tokenSwapForward(req, res, bodyBuffer, connections, model, strategy) {
  const targetHost = (req.headers.host || TARGET_HOSTS[0]).split(":")[0];
  const targetIP = await resolveTargetIP(targetHost);

  for (let i = 0; i < connections.length; i++) {
    const conn = connections[i];
    triggerRefreshIfNeeded(conn);

    const label = conn.name && conn.email ? `${conn.name} <${conn.email}>` : conn.name || conn.email || conn.id.slice(0, 8);
    const modelTag = model ? ` model=${model}` : "";
    const posTag = connections.length > 1 ? ` [${i + 1}/${connections.length}]` : "";
    const useTag = conn.consecutiveUseCount > 1 ? ` uses=${conn.consecutiveUseCount}` : "";
    log(`🔑 [token-swap]${posTag} trying "${label}"${modelTag}${useTag}`);

    const swappedHeaders = {
      ...req.headers,
      host: targetHost,
      authorization: `Bearer ${conn.accessToken}`
    };

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
          if (forwardRes.statusCode === 429 || forwardRes.statusCode === 503) {
            // Buffer the short error body to parse cooldown duration
            const chunks = [];
            forwardRes.on("data", c => chunks.push(c));
            forwardRes.on("end", () => {
              const body = Buffer.concat(chunks).toString();
              resolve({ retry: true, body, statusCode: forwardRes.statusCode });
            });
          } else {
            // Success or non-quota error → pipe to client
            resolve({ retry: false, response: forwardRes });
          }
        });
        forwardReq.on("error", reject);
        if (bodyBuffer.length > 0) forwardReq.write(bodyBuffer);
        forwardReq.end();
      });

      if (result.retry) {
        const cooldownMs = parseQuotaCooldown(result.body);
        const cdLabel = cooldownMs ? ` cooldown=${Math.ceil(cooldownMs / 60000)}m` : "";
        if (strategy === "sticky" && model) {
          // Sticky: mark only this account+model as exhausted, not the whole account
          setModelCooldown(conn.id, model, cooldownMs);
          log(`⚠️ [token-swap] "${label}" → ${result.statusCode} model=${model} quota exhausted${cdLabel}, trying next...`);
        } else {
          // Round-robin: put whole account on cooldown
          setCooldown(conn.id, cooldownMs);
          log(`⚠️ [token-swap] "${label}" → ${result.statusCode} account quota exhausted${cdLabel}, trying next...`);
        }
        continue;
      }

      const newCount = (conn.consecutiveUseCount || 0) + 1;
      const successModelTag = model ? ` model=${model}` : "";
      const successStrategyTag = strategy === "sticky" ? ` sticky(use #${newCount})` : ` rr`;
      log(`✅ [token-swap] "${label}" → ${result.response.statusCode}${successModelTag}${successStrategyTag}`);
      markAccountUsed(conn.id);
      res.writeHead(result.response.statusCode, result.response.headers);
      result.response.pipe(res);
      return true;
    } catch (e) {
      err(`[token-swap] error for "${label}": ${e.message}`);
      continue;
    }
  }

  // All accounts exhausted
  return false;
}

// ── Request handler ───────────────────────────────────────────

const server = https.createServer(sslOptions, async (req, res) => {
  try {
    if (req.url === "/_mitm_health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }

    const bodyBuffer = await collectBodyRaw(req);
    if (bodyBuffer.length > 0) saveRequestLog(req.url, bodyBuffer);

    // Anti-loop: skip requests from 9Router
    if (req.headers[INTERNAL_REQUEST_HEADER.name] === INTERNAL_REQUEST_HEADER.value) {
      return passthrough(req, res, bodyBuffer);
    }

    const tool = getToolForHost(req.headers.host);
    if (!tool) return passthrough(req, res, bodyBuffer);

    const patterns = URL_PATTERNS[tool] || [];
    const isChat = patterns.some(p => req.url.includes(p));
    if (!isChat) return passthrough(req, res, bodyBuffer);

    // Extract model early — needed for sticky token-swap strategy and mitmAlias.
    // Cursor uses binary proto so model extraction is deferred to its handler.
    const model = tool !== "cursor" ? extractModel(req.url, bodyBuffer) : null;

    // ── TOKEN SWAP: rotate auth tokens before mitmAlias ──────
    const swapProvider = TOOL_TO_PROVIDER[tool];
    if (swapProvider && isTokenSwapEnabled(swapProvider)) {
      const strategy = getTokenSwapStrategy();
      const poolConns = getAllActiveConnections(swapProvider, model);
      if (poolConns.length > 0) {
        log(`🔑 [${tool}] token-swap: ${poolConns.length} account(s) available (strategy=${strategy}${model ? `, model=${model}` : ""})`);
        const handled = await tokenSwapForward(req, res, bodyBuffer, poolConns, model, strategy);
        if (handled) return;
        log(`⚠️ [${tool}] token-swap: all accounts exhausted, falling through to original token`);
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

    const mappedModel = getMappedModel(tool, model);
    if (!mappedModel) {
      log(`⏩ passthrough | no mapping | ${tool} | ${model || "unknown"}`);
      return passthrough(req, res, bodyBuffer);
    }

    log(`⚡ intercept | ${tool} | ${model} → ${mappedModel}`);
    return handlers[tool].intercept(req, res, bodyBuffer, mappedModel, passthrough);
  } catch (e) {
    err(`Unhandled error: ${e.message}`);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: e.message, type: "mitm_error" } }));
  }
});

server.listen(LOCAL_PORT, () => log(`🚀 Server ready on :${LOCAL_PORT}`));

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") err(`Port ${LOCAL_PORT} already in use`);
  else if (e.code === "EACCES") err(`Permission denied for port ${LOCAL_PORT}`);
  else err(e.message);
  process.exit(1);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
if (process.platform === "win32") process.on("SIGBREAK", shutdown);
