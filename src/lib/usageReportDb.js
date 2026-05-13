/**
 * usageReportDb.js
 * API Key Usage Report aggregator — migrated from lowdb to SQLite.
 * Uses getUsageHistory() and direct adapter for dailySummary.
 */
import { getUsageHistory } from "@/lib/db/index.js";
import { getAdapter } from "@/lib/db/driver.js";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";

// ─── Helpers ────────────────────────────────────────────────────

const REPORT_PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };

function getCachedTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return 0;
  return tokens.cached_tokens || tokens.cache_read_input_tokens || tokens.prompt_tokens_details?.cached_tokens || 0;
}

function _maskKey(rawKey) {
  if (!rawKey || rawKey === "local-no-key") return null;
  return rawKey.length > 8 ? rawKey.slice(0, 4) + "..." + rawKey.slice(-4) : rawKey.slice(0, 4) + "...";
}

function _shouldUseHistory(normalized) {
  if (normalized.period === "24h") return true;
  if (normalized.interval === "hour") return true;
  if (normalized.period === "custom") {
    const rangeMs = new Date(normalized.endDate) - new Date(normalized.startDate);
    return rangeMs <= 48 * 3600 * 1000;
  }
  return false;
}

function _deriveInterval(period, startDate, endDate) {
  if (period === "24h") return "hour";
  if (period === "custom") {
    const ms = new Date(endDate) - new Date(startDate);
    if (ms <= 48 * 3600 * 1000) return "hour";
    if (ms <= 60 * 86400 * 1000) return "day";
    return "week";
  }
  if (period === "7d" || period === "30d" || period === "60d") return "day";
  return "week"; // "all"
}

function _getDateRange(period, startDate, endDate) {
  const now = Date.now();
  if (period === "custom") {
    return { start: new Date(startDate).getTime(), end: new Date(endDate).getTime() };
  }
  if (period === "all") return { start: 0, end: now };
  const ms = REPORT_PERIOD_MS[period];
  return { start: now - ms, end: now };
}

function _getBucketKey(ts, interval) {
  const d = new Date(ts);
  if (interval === "hour") {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}T${String(d.getHours()).padStart(2,"0")}`;
  }
  if (interval === "month") {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
  }
  if (interval === "week") {
    const day = d.getDay() || 7;
    const mon = new Date(d);
    mon.setDate(d.getDate() - day + 1);
    return `${mon.getFullYear()}-${String(mon.getMonth()+1).padStart(2,"0")}-${String(mon.getDate()).padStart(2,"0")}`;
  }
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function _getBucketLabel(bucketKey, interval) {
  if (interval === "hour") {
    const [datePart, hourPart] = bucketKey.split("T");
    const d = new Date(`${datePart}T${hourPart}:00:00`);
    return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  }
  if (interval === "month") {
    const [y, m] = bucketKey.split("-").map(Number);
    const d = new Date(y, m - 1, 1);
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }
  const d = new Date(`${bucketKey}T12:00:00`);
  if (interval === "week") return `Week of ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function _getSeriesLabel(rawKey, model, provider, groupBy, apiKeyInfoMap) {
  if (groupBy === "none") return "total";
  if (groupBy === "model") return model || "unknown";
  if (groupBy === "provider") return provider || "unknown";
  if (groupBy === "time") return "total";
  if (!rawKey || rawKey === "local-no-key") return "Local (No API Key)";
  const info = apiKeyInfoMap[rawKey];
  if (info) return info.name;
  return `Deleted key ${rawKey.slice(0, 8)}...`;
}

function _getGroupKey(rawKey, model, provider, groupBy, apiKeyInfoMap) {
  if (groupBy === "model") return model || "unknown";
  if (groupBy === "provider") return provider || "unknown";
  if (groupBy === "time") return "time";
  if (!rawKey || rawKey === "local-no-key") return "local-no-key";
  const info = apiKeyInfoMap[rawKey];
  return info ? info.id : `deleted:${rawKey.slice(0, 8)}`;
}

function _addMetrics(target, vals) {
  target.requests += vals.requests || 0;
  target.promptTokens += vals.promptTokens || 0;
  target.completionTokens += vals.completionTokens || 0;
  target.cachedTokens += vals.cachedTokens || 0;
  target.cost += vals.cost || 0;
}

function _finalizeMetrics(item) {
  item.totalTokens = item.promptTokens + item.completionTokens;
  item.avgCostPerRequest = item.requests > 0 ? item.cost / item.requests : 0;
  item.avgTokensPerRequest = item.requests > 0 ? item.totalTokens / item.requests : 0;
  item.cacheHitRatio = item.promptTokens > 0 ? item.cachedTokens / item.promptTokens : 0;
}

// ─── Main export ────────────────────────────────────────────────

/**
 * Get API key usage report with multi-dimensional filtering, grouping, and insights.
 * @param {object} filters
 * @returns {Promise<object>} Report payload
 */
export async function getApiKeyUsageReport(filters = {}) {
  const {
    period = "7d",
    startDate: rawStart,
    endDate: rawEnd,
    apiKeyIds = [],
    models = [],
    providers = [],
    groupBy = "apiKey",
    seriesBy = "apiKey",
    interval: requestedInterval,
    metric = "requests",
    limit = 25,
  } = filters;

  const { getApiKeys, getProviderNodes } = await import("@/lib/localDb.js");

  // Build lookup maps
  let allApiKeys = [];
  try { allApiKeys = await getApiKeys(); } catch {}
  const apiKeyInfoMap = {};  // rawKey → { id, name, maskedKey }
  const idToRawKey = {};     // id → rawKey
  for (const k of allApiKeys) {
    apiKeyInfoMap[k.key] = { id: k.id, name: k.name, maskedKey: _maskKey(k.key) };
    idToRawKey[k.id] = k.key;
  }

  const providerNodeNameMap = {};
  try {
    const nodes = await getProviderNodes();
    for (const n of nodes) {
      if (n.id && n.name) providerNodeNameMap[n.id] = n.name;
    }
  } catch {}

  // Resolve filter raw keys from ids
  const filterRawKeys = new Set();
  let filterLocalNoKey = false;
  for (const id of apiKeyIds) {
    if (id === "local-no-key") { filterLocalNoKey = true; continue; }
    const raw = idToRawKey[id];
    if (raw) filterRawKeys.add(raw);
  }
  const filterByKey = apiKeyIds.length > 0;
  const filterModels = new Set(models);
  const filterProviders = new Set(providers);

  const interval = requestedInterval || _deriveInterval(period, rawStart, rawEnd);
  const { start: rangeStart, end: rangeEnd } = _getDateRange(period, rawStart, rawEnd);

  const useHistory = _shouldUseHistory({ period, interval, startDate: rawStart, endDate: rawEnd });
  const source = useHistory ? "history" : "dailySummary";

  // Accumulators
  const totals = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
  const seriesBuckets = new Map();   // bucketKey → { label, total, values }
  const breakdownGroups = new Map(); // groupKey → row
  const topApiKeyMap = new Map();
  const topModelMap = new Map();
  const topProviderMap = new Map();

  function ensureBucket(bucketKey) {
    if (!seriesBuckets.has(bucketKey)) {
      seriesBuckets.set(bucketKey, { label: _getBucketLabel(bucketKey, interval), total: 0, values: {} });
    }
    return seriesBuckets.get(bucketKey);
  }

  function getMetricValue(vals, m) {
    if (m === "cost") return vals.cost || 0;
    if (m === "tokens") return (vals.promptTokens || 0) + (vals.completionTokens || 0);
    if (m === "cachedTokens") return vals.cachedTokens || 0;
    return vals.requests || 0;
  }

  function processEntry({ rawKey, rawModel, provider, vals, ts }) {
    const isLocalNoKey = !rawKey || rawKey === "local-no-key";

    if (filterByKey) {
      if (isLocalNoKey && !filterLocalNoKey) return;
      if (!isLocalNoKey && !filterRawKeys.has(rawKey)) return;
    }
    if (filterModels.size > 0 && !filterModels.has(rawModel)) return;
    if (filterProviders.size > 0 && !filterProviders.has(provider)) return;

    const akRaw = isLocalNoKey ? "local-no-key" : rawKey;
    const providerDisplay = providerNodeNameMap[provider] || provider || "unknown";
    const modelDisplay = rawModel || "unknown";

    _addMetrics(totals, vals);

    if (ts) {
      const bKey = _getBucketKey(ts, interval);
      const bucket = ensureBucket(bKey);
      const metricVal = getMetricValue(vals, metric);
      bucket.total += metricVal;
      const sl = _getSeriesLabel(akRaw, modelDisplay, providerDisplay, seriesBy, apiKeyInfoMap);
      bucket.values[sl] = (bucket.values[sl] || 0) + metricVal;
    }

    const gKey = _getGroupKey(akRaw, modelDisplay, providerDisplay, groupBy, apiKeyInfoMap);
    if (!breakdownGroups.has(gKey)) {
      const label = _getSeriesLabel(akRaw, modelDisplay, providerDisplay, groupBy, apiKeyInfoMap);
      const info = akRaw !== "local-no-key" ? apiKeyInfoMap[akRaw] : null;
      breakdownGroups.set(gKey, {
        id: `${groupBy}:${gKey}`,
        label,
        apiKeyId: info ? info.id : null,
        maskedKey: info ? info.maskedKey : (akRaw !== "local-no-key" ? _maskKey(akRaw) : null),
        model: groupBy === "model" ? modelDisplay : null,
        provider: groupBy === "provider" ? providerDisplay : null,
        requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0,
        lastUsed: ts || null,
      });
    }
    const grp = breakdownGroups.get(gKey);
    _addMetrics(grp, vals);
    if (ts && (!grp.lastUsed || ts > grp.lastUsed)) grp.lastUsed = ts;

    const keyLabel = _getSeriesLabel(akRaw, modelDisplay, providerDisplay, "apiKey", apiKeyInfoMap);
    if (!topApiKeyMap.has(keyLabel)) topApiKeyMap.set(keyLabel, 0);
    topApiKeyMap.set(keyLabel, topApiKeyMap.get(keyLabel) + getMetricValue(vals, metric));

    if (!topModelMap.has(modelDisplay)) topModelMap.set(modelDisplay, 0);
    topModelMap.set(modelDisplay, topModelMap.get(modelDisplay) + getMetricValue(vals, metric));

    if (!topProviderMap.has(providerDisplay)) topProviderMap.set(providerDisplay, 0);
    topProviderMap.set(providerDisplay, topProviderMap.get(providerDisplay) + getMetricValue(vals, metric));
  }

  if (useHistory) {
    // Use SQLite-backed getUsageHistory with date range filter
    const historyFilter = {};
    if (rangeStart) historyFilter.startDate = new Date(rangeStart).toISOString();
    if (rangeEnd) historyFilter.endDate = new Date(rangeEnd).toISOString();
    const history = await getUsageHistory(historyFilter);
    for (const entry of history) {
      const ts = entry.timestamp;
      if (!ts) continue;
      const promptTokens = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
      const completionTokens = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
      const cachedTokens = getCachedTokens(entry.tokens);
      processEntry({
        rawKey: entry.apiKey || "local-no-key",
        rawModel: entry.model || "unknown",
        provider: entry.provider || "unknown",
        vals: { requests: 1, promptTokens, completionTokens, cachedTokens, cost: entry.cost || 0 },
        ts,
      });
    }
  } else {
    // Read daily summaries from SQLite usageDaily table
    const adapter = await getAdapter();
    const startKey = new Date(rangeStart).toISOString().slice(0, 10);
    const endKey = new Date(rangeEnd).toISOString().slice(0, 10);
    const rows = adapter.all(`SELECT dateKey, data FROM usageDaily WHERE dateKey >= ? AND dateKey <= ?`, [startKey, endKey]);
    for (const row of rows) {
      const dateKey = row.dateKey;
      const day = parseJson(row.data, {});
      const dayTs = `${dateKey}T12:00:00.000Z`;
      for (const [, akData] of Object.entries(day.byApiKey || {})) {
        processEntry({
          rawKey: akData.apiKey || "local-no-key",
          rawModel: akData.rawModel || "unknown",
          provider: akData.provider || "unknown",
          vals: {
            requests: akData.requests || 0,
            promptTokens: akData.promptTokens || 0,
            completionTokens: akData.completionTokens || 0,
            cachedTokens: akData.cachedTokens || 0,
            cost: akData.cost || 0,
          },
          ts: dayTs,
        });
      }
    }
  }

  _finalizeMetrics(totals);

  const sortedBucketKeys = [...seriesBuckets.keys()].sort();
  const series = sortedBucketKeys.map((k) => ({ bucket: k, ...seriesBuckets.get(k) }));

  const breakdownAll = [...breakdownGroups.values()];
  breakdownAll.forEach(_finalizeMetrics);
  const sortMetric = metric === "cost" ? "cost" : metric === "tokens" ? "totalTokens" : metric === "cachedTokens" ? "cachedTokens" : "requests";
  breakdownAll.sort((a, b) => (b[sortMetric] || 0) - (a[sortMetric] || 0));
  const breakdown = breakdownAll.slice(0, limit);

  const totalMetricVal = getMetricValue(totals, metric) || 1;
  function mapToTop(m) {
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([label, value]) => ({ label, value, percentage: Math.round((value / totalMetricVal) * 1000) / 10 }));
  }

  const resolvedApiKeys = allApiKeys
    .filter((k) => !apiKeyIds.length || apiKeyIds.includes(k.id))
    .map((k) => ({ id: k.id, name: k.name, maskedKey: _maskKey(k.key) }));

  const resolvedProviders = [...new Set(
    [...breakdownGroups.values()].map((g) => g.provider).filter(Boolean)
  )].map((p) => ({ id: p, name: providerNodeNameMap[p] || p }));

  const resolvedModels = [...new Set(
    [...breakdownGroups.values()].map((g) => g.model).filter(Boolean)
  )];

  const insights = [];
  const costTotal = totals.cost || 0;
  if (costTotal > 0) {
    for (const item of breakdownAll.slice(0, 3)) {
      const share = item.cost / costTotal;
      if (share > 0.5) {
        insights.push({ type: "cost-driver", label: item.label, value: share, text: `${Math.round(share * 100)}% of cost` });
      }
    }
  }
  if (totals.promptTokens > 0) {
    for (const item of breakdownAll.slice(0, 5)) {
      if (item.requests > 10 && item.cacheHitRatio > 0.5) {
        insights.push({ type: "cache-efficiency", label: item.label, value: item.cacheHitRatio, text: `${Math.round(item.cacheHitRatio * 100)}% cache hit ratio` });
        break;
      }
    }
  }

  return {
    range: {
      startDate: new Date(rangeStart).toISOString(),
      endDate: new Date(rangeEnd).toISOString(),
      interval,
      source,
    },
    filters: {
      apiKeys: resolvedApiKeys,
      models: resolvedModels,
      providers: resolvedProviders,
    },
    totals,
    series,
    breakdown,
    top: {
      apiKeys: mapToTop(topApiKeyMap),
      models: mapToTop(topModelMap),
      providers: mapToTop(topProviderMap),
    },
    insights,
  };
}
