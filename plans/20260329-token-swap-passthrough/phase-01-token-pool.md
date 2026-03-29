# Phase 01: Core — tokenPool.js + tokenSwapForward() + server.js

**Parent:** [plan.md](./plan.md)  
**Status:** Todo  
**Priority:** P0

## Overview

Two new components + modify `passthrough()` and request handler in server.js.

---

## Part A: `src/mitm/tokenPool.js` (NEW FILE)

CJS module running in MITM server process. Reads `db.json` sync, manages cooldown state.

```js
const fs = require("fs");
const path = require("path");
const http = require("http"); // NOT https — 9router is HTTP on localhost
const { DATA_DIR } = require("./paths");
const { log } = require("./logger");

const DB_FILE = path.join(DATA_DIR, "db.json");
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // refresh if <5min to expiry
const ROUTER_BASE = "http://localhost:20128"; // same as base.js hardcoded value
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

// ── In-memory state ──────────────────────────────
const cooldownMap = {};   // { [connectionId]: expiresTimestamp }
const rrState = {};       // { [provider]: roundRobinIndex }

// ── Cooldown management ──────────────────────────
function setCooldown(connId, durationMs) {
  cooldownMap[connId] = Date.now() + (durationMs || DEFAULT_COOLDOWN_MS);
}

function isInCooldown(connId) {
  if (!cooldownMap[connId]) return false;
  if (Date.now() > cooldownMap[connId]) {
    delete cooldownMap[connId];
    return false;
  }
  return true;
}

// ── Quota cooldown parser (from Antigravity error body) ──
// Format: "Your quota will reset after 2h7m23s"
function parseQuotaCooldown(errorBody) {
  try {
    const json = JSON.parse(errorBody);
    const msg = json?.error?.message || json?.message || "";
    const match = msg.match(/reset after (\d+h)?(\d+m)?(\d+s)?/i);
    if (!match) return null;
    let ms = 0;
    if (match[1]) ms += parseInt(match[1]) * 3600000;
    if (match[2]) ms += parseInt(match[2]) * 60000;
    if (match[3]) ms += parseInt(match[3]) * 1000;
    return ms > 0 ? ms : null;
  } catch { return null; }
}

// ── Read connections from db.json ────────────────
function getActiveConnections(provider) {
  try {
    if (!fs.existsSync(DB_FILE)) return [];
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    const connections = db.providerConnections || [];
    const now = Date.now();

    return connections
      .filter(c =>
        c.provider === provider &&
        c.isActive !== false &&
        c.accessToken &&
        !isInCooldown(c.id) &&
        // Skip if expired with no refresh token
        !(c.expiresAt && new Date(c.expiresAt).getTime() < now && !c.refreshToken)
      )
      .sort((a, b) => (a.priority || 999) - (b.priority || 999));
  } catch { return []; }
}

function isTokenSwapEnabled(provider) {
  return getActiveConnections(provider).length > 0;
}

function getNextConnection(provider) {
  const connections = getActiveConnections(provider);
  if (connections.length === 0) return null;
  if (connections.length === 1) return connections[0];
  const idx = (rrState[provider] || 0) % connections.length;
  rrState[provider] = idx + 1;
  return connections[idx];
}

// Get ALL active connections (for retry loop — not just next one)
function getAllActiveConnections(provider) {
  return getActiveConnections(provider);
}

// ── Token refresh trigger (fire-and-forget via HTTP) ──
function triggerRefreshIfNeeded(connection) {
  if (!connection.expiresAt) return;
  const expiresAt = new Date(connection.expiresAt).getTime();
  if (Date.now() + TOKEN_EXPIRY_BUFFER_MS < expiresAt) return;

  try {
    const url = new URL(`/api/providers/${connection.id}/test`, ROUTER_BASE);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: "POST" },
      () => {} // ignore response
    );
    req.on("error", () => {});
    req.end();
  } catch { /* ignore */ }
}

module.exports = {
  isTokenSwapEnabled,
  getNextConnection,
  getAllActiveConnections,
  triggerRefreshIfNeeded,
  setCooldown,
  parseQuotaCooldown,
};
```

---

## Part B: `tokenSwapForward()` in server.js (NEW FUNCTION)

Key difference from `passthrough()`: checks upstream response status **BEFORE** writing headers to client. Enables auto-retry on 429.

```js
// Add to server.js — imports
const { isTokenSwapEnabled, getAllActiveConnections, triggerRefreshIfNeeded,
        setCooldown, parseQuotaCooldown } = require("./tokenPool");

const TOOL_TO_PROVIDER = {
  antigravity: "antigravity",
  // copilot: "copilot",  // future extension
  // kiro: "kiro",
};

/**
 * Forward request with token swap. Auto-retries on 429/503 with next account.
 * Falls through to original IDE token if all accounts exhausted.
 */
async function tokenSwapForward(req, res, bodyBuffer, connections) {
  const targetHost = (req.headers.host || TARGET_HOSTS[0]).split(":")[0];
  const targetIP = await resolveTargetIP(targetHost);

  for (const conn of connections) {
    // Fire-and-forget refresh if near expiry
    triggerRefreshIfNeeded(conn);

    log(`🔑 [token-swap] trying "${conn.name || conn.email}" ...`);
    const swappedHeaders = { ...req.headers, host: targetHost, authorization: `Bearer ${conn.accessToken}` };

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
          // Check status BEFORE piping
          if (forwardRes.statusCode === 429 || forwardRes.statusCode === 503) {
            // Buffer small error body
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
        // Parse cooldown from error body and mark account
        const cooldownMs = parseQuotaCooldown(result.body);
        setCooldown(conn.id, cooldownMs);
        log(`⚠️ [token-swap] "${conn.name || conn.email}" → ${result.statusCode} quota exhausted${cooldownMs ? ` (cooldown ${Math.ceil(cooldownMs/60000)}m)` : ""}, trying next...`);
        continue;
      }

      // Pipe success response to client
      log(`✅ [token-swap] "${conn.name || conn.email}" → ${result.response.statusCode}`);
      res.writeHead(result.response.statusCode, result.response.headers);
      result.response.pipe(res);
      return true; // handled
    } catch (e) {
      err(`[token-swap] error for "${conn.name}": ${e.message}`);
      continue;
    }
  }

  // All accounts exhausted → return false to trigger fallthrough
  return false;
}
```

---

## Part C: server.js Request Handler Changes

Insert token swap check **before** existing mitmAlias logic:

```js
// In request handler, after line 192 (isChat check):

// ── TOKEN SWAP ────────────────────────────────────
const provider = TOOL_TO_PROVIDER[tool];
if (provider && isTokenSwapEnabled(provider)) {
  const connections = getAllActiveConnections(provider);
  if (connections.length > 0) {
    const handled = await tokenSwapForward(req, res, bodyBuffer, connections);
    if (handled) return;
    // Fallthrough: all pool accounts exhausted → use IDE's original token
    log(`⚠️ [token-swap] all accounts exhausted, falling through to original token`);
  }
}

// (existing mitmAlias logic follows unchanged)
log(`🔍 [${tool}] url=${req.url} | bodyLen=${bodyBuffer.length}`);
// ...
```

---

## Files Summary

| File | Action | ~Lines Changed |
|------|--------|----------------|
| `src/mitm/tokenPool.js` | **Create** | ~110 lines |
| `src/mitm/server.js` | **Modify** — add imports, TOOL_TO_PROVIDER, tokenSwapForward(), insert swap block | ~80 lines added |

## Todo

- [ ] Create `src/mitm/tokenPool.js`
- [ ] Add `tokenSwapForward()` function in `server.js`
- [ ] Add `TOOL_TO_PROVIDER` map and imports in `server.js`
- [ ] Insert token swap check block before mitmAlias logic (after isChat check)
- [ ] Manual test: 1 account → verify token swap works
- [ ] Manual test: 2 accounts → verify round-robin
- [ ] Manual test: 1st account quota exceeded → auto-retry 2nd account
- [ ] Manual test: all accounts exhausted → fallthrough to IDE's original token
- [ ] Manual test: near-expiry token → verify refresh triggered (check logs)

## Success Criteria

- `🔑 [token-swap]` log line appears for intercepted requests
- 429 from upstream → auto-retry next account (visible as `⚠️` then `✅`)
- Cooldown parsed from error message → account skipped for correct duration
- All accounts exhausted → normal passthrough (IDE gets response from its own token)
- Request body, URL, path, all other headers UNCHANGED (only Authorization swapped)
- No model changes, no redirect to 9router
