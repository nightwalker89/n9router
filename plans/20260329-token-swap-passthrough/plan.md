# Plan: Token Swap Passthrough (MITM Token Rotation) — v3 FINAL

**Date:** 2026-03-29  
**Status:** Reviewed — Ready  
**Priority:** High

## Problem

Antigravity IDEs per-account quota limits force users to logout/login frequently.  
Current 9router MITM redirects to 9router server — request params change → Antigravity detects and bans accounts.

## Solution

Add a **Token Swap Passthrough** mode to the MITM layer:
- Intercept request from IDE
- Swap `Authorization: Bearer <token>` with a rotating token from existing **providerConnections**
- Forward request to **real upstream domain** (unchanged body, unchanged path)
- If upstream returns 429 (quota exceeded) → **auto-retry with next account**
- If all accounts exhausted → **fallthrough to IDE's original token**

## Key Design: Reuse Existing providerConnections (zero new DB schema)

`providerConnections[]` with `provider="antigravity"` already has:
- `accessToken` / `refreshToken` / `expiresAt` (full OAuth lifecycle)
- `isActive` toggle
- `priority` for ordering
- Full CRUD UI in dashboard Providers page
- Refresh mechanism via existing `POST /api/providers/:id/test`

## Architecture

```
IDE → MITM Server (port 443)
         ↓
    isTokenSwapEnabled("antigravity")?
         ↓ YES
    get active connections (filtered by cooldown + expiry)
         ↓
    for each connection (round-robin):
         ↓
    swap Authorization header → forward to real upstream
         ↓
    upstream returns 429/quota? → mark cooldown → try next
         ↓
    upstream returns 200? → pipe to client ✅
         ↓
    all exhausted? → fallthrough with IDE's original token  
```

## Phases

| Phase | Description | Files |
|-------|-------------|-------|
| 01 | Core: tokenPool.js + tokenSwapForward() + server.js changes | `src/mitm/tokenPool.js` (new), `src/mitm/server.js` (modify) |
| 02 | UI: Token Swap status section in MitmToolCard | `MitmToolCard.js` (modify) |

## Key Design Decisions

1. **Zero new DB schema** — reuse `providerConnections`
2. **`tokenSwapForward()` NOT `passthrough()`** — must inspect response status BEFORE committing headers to client, to enable auto-retry on 429
3. **In-memory cooldown map** — skip quota-exhausted accounts. Parse cooldown from Antigravity error message (`"reset after 2h7m23s"`)
4. **Fallthrough to IDE's original token** when all pool accounts exhausted (not hard 429)
5. **Token auto-refresh** — fire-and-forget `POST /api/providers/:id/test` via `http.request()` (not https) when near expiry
6. **Round-robin** by `priority` field. Cooldown map resets on timer expiry

## Risks

| Risk | Mitigation |
|------|-----------|
| accessToken short-lived (~1hr) | Expiry check + refresh trigger |
| Sync fs.readFileSync in hot path | Existing pattern in server.js — acceptable |
| Double-refresh race condition | Harmless — Google token endpoint is idempotent |
| Cooldown map lost on restart | Acceptable — re-discovers 429 on first request |
| SSE streaming + retry | 429 responses are small JSON, not SSE — safe to buffer |

## Related Files

- `src/mitm/server.js` — main handler + passthrough()
- `src/mitm/tokenPool.js` — new file
- `src/mitm/paths.js` — DATA_DIR resolution
- `src/mitm/config.js` — tool/host mapping
- `open-sse/executors/antigravity.js` — reference: quota error parsing
- `open-sse/services/accountFallback.js` — reference: cooldown patterns
- `src/app/api/providers/[id]/test/testUtils.js` — refresh mechanism
- `src/shared/constants/cliTools.js` — MITM_TOOLS config
