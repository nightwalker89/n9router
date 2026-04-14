# Plan: MITM Mode A — Multi-Model Mapping with Fallback Strategy

## Problem

Currently in MITM Mode A, each intercepted model maps to **one** `provider/model` string. No fallback on failure.

**Desired**: Multiple targets per model, with configurable strategy (round-robin default, serial fallback):
```
antigravity "claude-opus-4-6-thinking" → ["cx/gpt-5.4", "custom-anthropic-compatible/opus"]
```

## User Decisions

1. **All MITM tools inherit** — antigravity, copilot, kiro all get multi-model from one shared implementation
2. **Strategy selector**: round-robin (default) or serial fallback
3. **Max 5 models** per mapping

---

## Architecture (Current)

### Data Flow — Mode A
```
IDE → DNS redirect → MITM proxy (server.js)
  → extractModel(url, body) → getMappedModel(tool, model)
  → mappedModel = "cx/gpt-5.4" (single string)
  → handlers/antigravity.js: intercept(req, res, bodyBuffer, mappedModel)
  → fetchRouter(body with replaced model) → pipeSSE
```

### Storage (`db.json` → `mitmAlias`)
```json
{ "mitmAlias": { "antigravity": { "gemini-3.1-pro-high": "cx/gpt-5.4" } } }
```
Values are **strings**.

### UI Components (2 pages)
- **`MitmToolCard.js`** — shared component on `/dashboard/mitm` page, used by ALL 3 MITM tools (antigravity, copilot, kiro)
- **`AntigravityToolCard.js`** — used on `/dashboard/cli-tools` page (legacy, antigravity-specific)

Both currently render **one text input + one Select button per model alias**.

### Runtime `getMappedModel()` (server.js)
Reads `db.mitmAlias[tool][model]` → returns single string or null. If null → passthrough.

### Handlers (antigravity.js, kiro.js, copilot.js)
All follow identical pattern: `intercept(req, res, bodyBuffer, mappedModel)` → replace `body.model`, fetchRouter, pipeSSE. **Swallow errors** (return 500 to client). No retry.

### Strategy Pattern Exists
Token Swap (Mode B) already stores `tokenSwapStrategy` in settings ("round-robin" or "sticky") via `getTokenSwapStrategy()`. We follow this pattern for Mode A strategy.

---

## Solution Design

### Data Format Change (Backward Compatible)

**`mitmAlias` values → `string[]`; strategy stored in `mitmAliasStrategy`:**

```json
{
  "mitmAlias": {
    "antigravity": {
      "gemini-3.1-pro-high": ["cx/gpt-5.4", "custom-anthropic-compatible/opus"],
      "gemini-3.1-pro-low": ["if/kimi-k2-thinking"]
    }
  },
  "mitmAliasStrategy": "round-robin"
}
```

Backward compat in `getMappedModels()`:
- `"cx/gpt-5.4"` (string) → `["cx/gpt-5.4"]`
- `["cx/gpt-5.4", "custom-anthropic-compatible/opus"]` → use as-is

`mitmAliasStrategy` values: `"round-robin"` (default) | `"fallback"` (serial)

### Runtime: Fallback/Round-Robin Loop in MITM Proxy

#### 1. `getMappedModels(tool, model)` — returns `string[] | null`

```js
function getMappedModels(tool, model) {
  if (!model) return null;
  try {
    if (!fs.existsSync(DB_FILE)) return null;
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    const aliases = db.mitmAlias?.[tool];
    if (!aliases) return null;
    let value = aliases[model];
    // Prefix match fallback
    if (value === undefined) {
      const prefixKey = Object.keys(aliases).find(k => k && aliases[k] && (model.startsWith(k) || k.startsWith(model)));
      if (!prefixKey) return null;
      value = aliases[prefixKey];
    }
    // Normalize: string → [string], array → array
    if (Array.isArray(value)) return value.slice(0, 5); // cap at 5
    if (typeof value === "string" && value.trim()) return [value.trim()];
    return null;
  } catch { return null; }
}
```

#### 2. `getMitmAliasStrategy()` — returns `"round-robin"` or `"fallback"`

```js
function getMitmAliasStrategy() {
  try {
    if (!fs.existsSync(DB_FILE)) return "round-robin";
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    return db.mitmAliasStrategy || "round-robin";
  } catch { return "round-robin"; }
}
```

#### 3. `tryMappedModels()` — iterate with strategy awareness

**Key constraint**: `res.headersSent` check — once SSE streaming starts, we CANNOT retry for that request. Only retry on pre-stream errors (router returns non-2xx status before any data is piped).

```js
async function tryMappedModels(req, res, bodyBuffer, models, tool, strategy) {
  // Round-robin: randomize first pick, then iterate sequentially
  let orderedModels = [...models];
  if (strategy === "round-robin" && orderedModels.length > 1) {
    const randomStart = Math.floor(Math.random() * orderedModels.length);
    orderedModels = [
      ...orderedModels.slice(randomStart),
      ...orderedModels.slice(0, randomStart),
    ];
  }

  for (let i = 0; i < orderedModels.length; i++) {
    const mappedModel = orderedModels[i];
    const posTag = orderedModels.length > 1 ? ` [${i + 1}/${orderedModels.length}]` : "";
    log(`⚡ [${tool}]${strategy === "round-robin" ? " rr" : " fb"}${posTag}: ${mappedModel}`);

    // If a previous attempt started streaming, we cannot retry
    if (res.headersSent) {
      log(`⏩ [${tool}] headers already sent, cannot fall back`);
      return true;
    }

    try {
      await handlers[tool].intercept(req, res, bodyBuffer, mappedModel, passthrough);
      // Success — pipeSSE completed, response already sent
      return true;
    } catch (error) {
      err(`[${tool}] ${mappedModel} failed: ${error.message}`);
      // If headers were sent during this attempt, we can't retry
      if (res.headersSent) {
        log(`⏩ [${tool}] headers sent during attempt, cannot fall back`);
        return true; // Response already in flight
      }
      // Continue to next model
    }
  }
  return false; // All models failed
}
```

#### 4. Request handler change (server.js)

Replace single `handlers[tool].intercept()` call:

```js
const mappedModels = getMappedModels(tool, model);
if (!mappedModels) {
  return passthrough(req, res, bodyBuffer);
}

log(`⚡ intercept | ${tool} | ${model} → ${mappedModels.join(", ")}`);
const strategy = getMitmAliasStrategy();
const handled = await tryMappedModels(req, res, bodyBuffer, mappedModels, tool, strategy);
if (!handled && !res.headersSent) {
  res.writeHead(502, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    error: { message: `All ${mappedModels.length} mapped models failed`, type: "mitm_error" }
  }));
}
```

### Handler Changes (ALL 3 handlers)

**Common change**: throw on non-2xx from router so the fallback loop can catch it.

Current pattern (all 3 handlers identical):
```js
async function intercept(req, res, bodyBuffer, mappedModel) {
  try {
    const body = JSON.parse(bodyBuffer.toString());
    body.model = mappedModel;
    const routerRes = await fetchRouter(body, "/v1/chat/completions", req.headers);
    await pipeSSE(routerRes, res);
  } catch (error) {
    err(`[antigravity] ${error.message}`);
    if (!res.headersSent) res.writeHead(500, ...);
    res.end(...);
  }
}
```

New pattern:
```js
async function intercept(req, res, bodyBuffer, mappedModel) {
  const body = JSON.parse(bodyBuffer.toString());
  body.model = mappedModel;
  const routerRes = await fetchRouter(body, "/v1/chat/completions", req.headers);
  if (!routerRes.ok) {
    const errText = await routerRes.text().catch(() => "");
    throw new Error(`Router error ${routerRes.status}: ${errText.substring(0, 200)}`);
  }
  await pipeSSE(routerRes, res);
}
```

- Remove try/catch wrapper
- Throw on non-2xx router response
- Let server.js `tryMappedModels()` catch and retry
- Copilot handler has its own `resolveRouterPath()` — keep that, just apply the same throw pattern

### UI Changes — `MitmToolCard.js` (SHARED — all tools inherit)

**State change**: `modelMappings` from `{alias: string}` → `{alias: string[]}`

**Per-model row** changes from:
```
[model-name] [input] [Select] [×]
```
To:
```
[model-name]
  ➊ cx/gpt-5.4                           [▲] [▼] [×]
  ➋ custom-anthropic-compatible/opus     [▲] [▼] [×]
  [+ Add][Select]
```

**Strategy selector** (per-tool or global, above model rows):
```
Strategy: [Round-Robin ▼]  (or [Fallback])
```

**New handlers**:
```js
const handleAddMapping = (alias, value) => {
  setModelMappings(prev => {
    const current = prev[alias] || [];
    if (current.length >= 5) return prev; // cap
    return { ...prev, [alias]: [...current, value] };
  });
};

const handleRemoveMapping = (alias, index) => {
  setModelMappings(prev => ({
    ...prev, [alias]: prev[alias].filter((_, i) => i !== index)
  }));
};

const handleReorderMapping = (alias, fromIdx, toIdx) => {
  setModelMappings(prev => {
    const list = [...prev[alias]];
    const [moved] = list.splice(fromIdx, 1);
    list.splice(toIdx, 0, moved);
    return { ...prev, [alias]: list };
  });
};
```

**`ModelSelectModal` change**: on select, `handleModelSelect` appends to array instead of replacing.

**`handleSaveMappings`**: sends arrays + strategy:
```js
const handleSaveMappings = async () => {
  const filtered = {};
  for (const [alias, models] of Object.entries(modelMappings)) {
    const arr = (Array.isArray(models) ? models : [models]).filter(m => m && m.trim());
    if (arr.length > 0) filtered[alias] = arr;
  }
  await fetch("/api/cli-tools/antigravity-mitm/alias", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tool: tool.id,
      mappings: filtered,
      strategy: selectedStrategy,  // "round-robin" or "fallback"
    }),
  });
};
```

**`AntigravityToolCard.js`**: Apply the same multi-model pattern (it's a separate component but mirrors MitmToolCard).

### API Changes

**PUT `/api/cli-tools/antigravity-mitm/alias`:**

```js
export async function PUT(request) {
  const { tool, mappings, strategy } = await request.json();
  if (!tool) return NextResponse.json({ error: "tool required" }, { status: 400 });

  // Save strategy if provided
  if (strategy && (strategy === "round-robin" || strategy === "fallback")) {
    await updateSettings({ mitmAliasStrategy: strategy });
  }

  const filtered = {};
  for (const [alias, models] of Object.entries(mappings || {})) {
    if (Array.isArray(models)) {
      const cleaned = models.filter(m => m && m.trim()).slice(0, 5);
      if (cleaned.length > 0) filtered[alias] = cleaned;
    } else if (typeof models === "string" && models.trim()) {
      filtered[alias] = [models.trim()]; // normalize string → array
    }
  }

  await setMitmAliasAll(tool, filtered);
  return NextResponse.json({ success: true, aliases: filtered, strategy: strategy || "round-robin" });
}
```

**GET `/api/cli-tools/antigravity-mitm/alias`:** Also return strategy:
```js
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const toolName = searchParams.get("tool");
  const aliases = await getMitmAlias(toolName || undefined);
  const settings = await getSettings();
  return NextResponse.json({
    aliases,
    strategy: settings.mitmAliasStrategy || "round-robin",
  });
}
```

**`localDb.js`**: Add `mitmAliasStrategy` field to defaults:
```js
// In db defaults:
mitmAliasStrategy: "round-robin",
```

### Strategy Behavior

| Strategy | Behavior |
|----------|----------|
| **round-robin** (default) | Randomize starting model each request, then iterate. Distributes load across all targets. |
| **fallback** (serial) | Try models in order. Good for cost optimization: primary → cheap → free. |

Round-robin randomization: `Math.floor(Math.random() * len)` as start index, then sequential from there. This means each request hits a potentially different primary, distributing quota usage.

---

## Files to Modify

| File | Change |
|------|--------|
| `src/mitm/server.js` | `getMappedModel()` → `getMappedModels()` + `getMitmAliasStrategy()` + `tryMappedModels()` fallback loop |
| `src/mitm/handlers/antigravity.js` | Remove try/catch, throw on non-2xx |
| `src/mitm/handlers/kiro.js` | Same pattern as antigravity.js |
| `src/mitm/handlers/copilot.js` | Same pattern as antigravity.js |
| `src/app/(dashboard)/dashboard/cli-tools/components/MitmToolCard.js` | Multi-model UI: priority list, add/remove/reorder, strategy selector |
| `src/app/(dashboard)/dashboard/cli-tools/components/AntigravityToolCard.js` | Same multi-model UI changes (legacy page) |
| `src/app/api/cli-tools/antigravity-mitm/alias/route.js` | Accept arrays + strategy, return strategy on GET |
| `src/lib/localDb.js` | Add `mitmAliasStrategy` default; `setMitmAliasAll` already works with any value type |

**All 3 handlers get the same fix.** All 2 UI cards get the same multi-model pattern. One edit, all tools inherit.

---

## Backward Compatibility

- **Old data** (`string` values) → auto-normalized to `[string]` at runtime
- **New data** (`string[]` values) → used directly, capped at 5
- **API** accepts both `string` and `string[]` in PUT, normalizes everything to arrays
- **Strategy default** → `round-robin` if not set
- **UI** shows `string` values as 1-element lists

---

## Edge Cases

1. **Empty array**: Show "No mapping — passthrough" in UI; passthrough at runtime
2. **Token swap active**: Mutual exclusion logic unchanged
3. **Stream mid-flight**: If `res.headersSent` is true, cannot retry — return current response
4. **5 model cap**: Hard cap; UI prevents adding beyond 5
5. **Round-robin randomization**: Each request starts at random index, deterministic from there
6. **Copilot has multiple endpoint paths**: `resolveRouterPath()` in copilot handler stays as-is; fallback loop handles model selection

---

## Implementation Phases

### Phase 1: Core Runtime (server.js + all handlers)
- Status: DONE 2026-04-14T14:30:47+07:00
- `server.js`: `getMappedModels()`, `getMitmAliasStrategy()`, `tryMappedModels()`
- `antigravity.js`: throw on non-2xx (remove try/catch wrapper)
- `kiro.js`: same
- `copilot.js`: same
- Update request handler in server.js

### Phase 2: API + DB Layer
- Status: DONE 2026-04-14T14:48:00+07:00
- `localDb.js`: add `mitmAliasStrategy` default
- `alias/route.js`: accept arrays + strategy, return strategy on GET
- Normalize string → array on save

### Phase 3: Shared UI Editor
- Status: DONE 2026-04-14T14:58:36+07:00
- `MitmToolCard.js`: replace single input with multi-row editor
- Add/remove target models per alias
- Add strategy selector dropdown (`round-robin` / `fallback`)
- Save sends arrays + strategy

### Phase 4: UI — AntigravityToolCard.js (legacy page)
- Status: DONE 2026-04-14T15:03:44+07:00
- Same multi-model UI pattern
- Strategy selector

### Phase 5: Polish
- Status: DONE 2026-04-14T15:19:22+07:00
- Comma-separated text input
- Visual feedback in logs during fallback
- Enforce 5-model cap in UI