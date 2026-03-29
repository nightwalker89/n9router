# Phase 02: UI — Token Swap Status in MitmToolCard

**Parent:** [plan.md](./plan.md)  
**Depends on:** phase-01  
**Status:** Todo

## Context

UI **không cần trang mới** vì:
- Quản lý accounts → đã có ở **Providers** page (add/remove/toggle Antigravity accounts)
- Chỉ cần hiển thị trong `MitmToolCard` — khi DNS active, show thêm section **Token Swap** để user biết có bao nhiêu accounts đang trong pool rotation

## What to Add

### Trong `MitmToolCard.js` (existing component)

Chỉ thêm 1 section nhỏ bên dưới Model Mappings khi tool là `antigravity` (hoặc bất kỳ tool nào có token swap):

```
┌─ Antigravity ─────────────────────────────── Active ─┐
│                                                        │
│  Model Mappings                                        │
│  gemini-2.0-flash-thinking → [claude-3-5-sonnet] [x]  │
│  gemini-2.5-pro             → [                 ] [x]  │
│                                                        │
│  ── Token Swap Pool ─────────────────────────────────  │
│  🔑 3 accounts active • Round-robin rotation           │
│  account1@gmail.com  ✅  used 142x  5m ago             │
│  account2@work.com   ✅  used  87x  2h ago             │
│  account3@old.com    ⚠️  expires soon                  │
│  [+ Add Account →]  (links to Providers page)          │
│                                                        │
│  [ Stop DNS ]                                          │
└────────────────────────────────────────────────────────┘
```

### Data Source

Fetch từ existing API: `GET /api/providers?provider=antigravity`  
Đã có sẵn, trả về connections với `isActive`, `email`/`name`, `usageCount`, `lastUsedAt`, `expiresAt`.

**Note:** `usageCount` và `lastUsedAt` hiện không có sẵn trên providerConnections schema.  
→ **Option A:** Bỏ usage stats, chỉ show email + expiry status (YAGNI — simpler)  
→ **Option B:** Add `mitmUsageCount` + `mitmLastUsedAt` fields khi token swap xảy ra (update via 9router API, fire-and-forget)  
→ **Recommend: Option A for MVP**, Option B là enhancement sau

## Minimal UI Addition (Option A — MVP)

```jsx
// Thêm vào MitmToolCard.js, bên dưới Model Mappings section:

{/* Token Swap Pool — chỉ show khi tool support token swap */}
{tool.supportsTokenSwap && dnsActive && (
  <div className="flex flex-col gap-2">
    <div className="flex items-center gap-2">
      <span className="material-symbols-outlined text-[14px] text-primary">key</span>
      <span className="text-xs font-semibold text-text-main">Token Swap Pool</span>
      <Badge variant={tokenSwapAccounts.length > 0 ? "success" : "warning"} size="sm">
        {tokenSwapAccounts.length > 0 ? `${tokenSwapAccounts.length} active` : "No accounts"}
      </Badge>
    </div>

    {tokenSwapAccounts.length > 0 ? (
      <div className="flex flex-col gap-1">
        {tokenSwapAccounts.map(acc => (
          <div key={acc.id} className="flex items-center gap-2 text-xs text-text-muted">
            <span className="material-symbols-outlined text-[12px] text-green-500">check_circle</span>
            <span className="flex-1 truncate">{acc.email || acc.name}</span>
            {isNearExpiry(acc.expiresAt) && (
              <Badge variant="warning" size="xs">expires soon</Badge>
            )}
          </div>
        ))}
        <a
          href="/dashboard/providers"
          className="text-xs text-primary hover:underline flex items-center gap-1 mt-1"
        >
          <span className="material-symbols-outlined text-[12px]">open_in_new</span>
          Manage accounts
        </a>
      </div>
    ) : (
      <div className="text-xs text-text-muted px-1">
        No active Antigravity accounts. 
        <a href="/dashboard/providers" className="text-primary hover:underline ml-1">Add account →</a>
      </div>
    )}
  </div>
)}
```

## Changes Required

### 1. `src/shared/constants/cliTools.js` (or wherever MITM_TOOLS is defined)

Add `supportsTokenSwap: true` to antigravity tool config:

```js
{
  id: "antigravity",
  name: "Antigravity",
  supportsTokenSwap: true,  // ← add this
  ...
}
```

### 2. `MitmToolCard.js`

- Fetch Antigravity connections when tool has `supportsTokenSwap && isExpanded`
- Add `tokenSwapAccounts` state
- Add Token Swap Pool section in expanded view
- Helper: `isNearExpiry(expiresAt)` — within 24h

### 3. `MitmPageClient.js`

- Pass connections filtered by tool's provider to `MitmToolCard` (or let card fetch itself)
- Actually: card can fetch independently since `MitmPageClient` already fetches all connections → pass them down filtered

## Files to Modify

- `src/shared/constants/cliTools.js` — add `supportsTokenSwap` flag
- `src/app/(dashboard)/dashboard/cli-tools/components/MitmToolCard.js` — add Token Swap section
- `src/app/(dashboard)/dashboard/mitm/MitmPageClient.js` — pass connections by provider to card

## Todo

- [ ] Find and update MITM_TOOLS constant — add `supportsTokenSwap: true` for antigravity
- [ ] Add `tokenSwapAccounts` derived from passed `activeProviders` filtered by `tool.provider`
- [ ] Add Token Swap Pool section in `MitmToolCard` expanded view (below Model Mappings)
- [ ] `isNearExpiry()` helper — returns true if `expiresAt` within 24h
- [ ] Link "Manage accounts" → `/dashboard/providers`
- [ ] Empty state: "No active accounts" with add link

## Success Criteria

- Token Swap Pool section appears in expanded Antigravity MITM card when DNS is active
- Shows list of connected Antigravity accounts with expiry warning
- "Manage accounts" link goes to Providers page
- No new API routes needed
- Existing accounts list updates on page refresh
