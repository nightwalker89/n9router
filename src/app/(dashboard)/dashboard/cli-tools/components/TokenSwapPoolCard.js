"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, Badge, Toggle } from "@/shared/components";
import Link from "next/link";
import { inferAntigravityAccountType, normalizeAntigravityAccountType } from "@/lib/antigravity/accountType";
import {
  parseQuotaData,
  formatResetTime,
  formatResetTimeDisplay,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils";
import { pickQuotaFamilyBars } from "./tokenSwapQuotaBars";

// Cache TTL: 2 minutes — avoid hammering the upstream API
const QUOTA_CACHE_TTL_MS = 2 * 60 * 1000;

// Must match DEFAULT_AG_503_RETRY_COUNT in open-sse/config/runtimeConfig.js
const DEFAULT_503_RETRY_COUNT = 3;

/**
 * Get progress color based on remaining percentage
 */
function getQuotaColor(pct) {
  if (pct > 70) return "text-green-500";
  if (pct >= 30) return "text-yellow-500";
  return "text-red-500";
}

function getQuotaBg(pct) {
  if (pct > 70) return "bg-green-500";
  if (pct >= 30) return "bg-yellow-500";
  return "bg-red-500";
}

function getQuotaPercentage(quota) {
  if (!quota) return null;
  if (quota.remainingPercentage !== undefined) {
    return Math.round(quota.remainingPercentage);
  }
  if (quota.total > 0) {
    return Math.round(((quota.total - quota.used) / quota.total) * 100);
  }
  return null;
}

function getFutureResetAt(quota) {
  if (!quota?.resetAt) return null;
  return new Date(quota.resetAt).getTime() > Date.now() ? quota.resetAt : null;
}

// "6d 23h 54m" -> "6d 23h" so the countdown fits the compact quota row
function formatCompactCountdown(resetAt) {
  return formatResetTime(resetAt).split(" ").slice(0, 2).join(" ");
}

function maskEmail(email) {
  if (!email || typeof email !== "string") return email;
  const atIndex = email.indexOf("@");
  if (atIndex <= 0 || atIndex === email.length - 1) return email;

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);

  if (local.length === 1) return `${local[0]}**@${domain}`;
  if (local.length === 2) return `${local[0]}**${local[1]}@${domain}`;

  return `${local[0]}**${local[local.length - 1]}@${domain}`;
}

function getAccountDisplay(acc, maskEmails) {
  if (acc.email) return maskEmails ? maskEmail(acc.email) : acc.email;
  return acc.name || acc.id.slice(0, 16);
}

function getAccountTypeBadgeVariant(accountType) {
  if (accountType === "Ultra") return "warning";
  if (accountType === "Pro") return "primary";
  if (accountType === "Plus") return "success";
  if (accountType === "Free") return "info";
  return "default";
}

function getPreferredAccountId(accounts, strategy) {
  if (!accounts || accounts.length === 0) return null;
  if (accounts.length === 1) return accounts[0].id;

  const byNewest = [...accounts].sort((a, b) => {
    if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
    if (!a.lastUsedAt) return 1;
    if (!b.lastUsedAt) return -1;
    return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
  });

  if (strategy === "sticky") {
    return byNewest[0]?.id || null;
  }

  const byOldest = [...accounts].sort((a, b) => {
    if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
    if (!a.lastUsedAt) return -1;
    if (!b.lastUsedAt) return 1;
    return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
  });

  return byOldest[0]?.id || null;
}

function formatCooldownDuration(untilMs, nowMs = Date.now()) {
  const diffMs = untilMs - nowMs;
  if (!Number.isFinite(diffMs) || diffMs <= 0) return null;

  const totalSeconds = Math.ceil(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (hours) parts.push(`${hours}h`);
  if (minutes || hours) parts.push(`${minutes}m`);
  if (!hours && seconds) parts.push(`${seconds}s`);
  if (parts.length === 0) parts.push("0s");

  return parts.join(" ");
}

function getAccountCooldownMeta(acc, nowMs = Date.now()) {
  if (!acc) return null;

  const candidates = [];
  if (acc.rateLimitedUntil) {
    candidates.push({ type: "account", until: acc.rateLimitedUntil });
  }

  Object.entries(acc).forEach(([key, value]) => {
    if (key.startsWith("modelLock_") && value) {
      candidates.push({ type: "model", until: value });
    }
  });

  const active = candidates
    .map((candidate) => ({
      ...candidate,
      untilMs: new Date(candidate.until).getTime(),
    }))
    .filter((candidate) => Number.isFinite(candidate.untilMs) && candidate.untilMs > nowMs)
    .sort((a, b) => a.untilMs - b.untilMs)[0];

  if (!active) return null;

  const duration = formatCooldownDuration(active.untilMs, nowMs);
  if (!duration) return null;

  return {
    duration,
    title: `${active.type === "model" ? "Model" : "Account"} cooldown until ${new Date(active.untilMs).toLocaleString()}`,
  };
}

/**
 * Token Swap Pool Card — standalone card for token rotation mode.
 */
export default function TokenSwapPoolCard({ tool, connections = [], serverRunning, dnsActive, onToggle, onRefreshConnections }) {
  const [enabled, setEnabled] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [strategy, setStrategy] = useState("round-robin"); // "round-robin" | "sticky"
  const [togglingStrategy, setTogglingStrategy] = useState(false);
  const [maskEmails, setMaskEmails] = useState(false);
  const [togglingMaskEmails, setTogglingMaskEmails] = useState(false);

  const [retryCount503, setRetryCount503] = useState(DEFAULT_503_RETRY_COUNT); // global 503 retry count
  const [accountRetryOverrides, setAccountRetryOverrides] = useState({}); // local optimistic state for per-account 503 retry inputs
  const [togglingAccountIds, setTogglingAccountIds] = useState(new Set());
  const [refreshingQuotaIds, setRefreshingQuotaIds] = useState(new Set());
  const [refreshingAllQuotas, setRefreshingAllQuotas] = useState(false);
  const [quotas, setQuotas] = useState({}); // { [connId]: { quotas: [], error: string|null, loading: bool, accountType?: string|null } }
  const quotaCacheRef = useRef({}); // { [connId]: { data: parsed, error, ts: number, accountType?: string|null } }
  const retryCount503TimerRef = useRef(null); // debounce timer for global 503 retry save
  const accountRetryTimersRef = useRef({}); // debounce timers for per-account 503 retry saves
  const [healthData, setHealthData] = useState({}); // { [connId]: HealthEvent[] } — last 100 calls per account
  const [cooldownNow, setCooldownNow] = useState(Date.now());

  const fetchEnabled = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = await res.json();
        setEnabled(!!data.tokenSwapEnabled);
        setStrategy(data.tokenSwapStrategy || "round-robin");
        setMaskEmails(!!data.tokenSwapMaskEmails);
        setRetryCount503(data.antigravity503RetryCount ?? DEFAULT_503_RETRY_COUNT);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchEnabled();
  }, [fetchEnabled]);

  // Sync per-account retry overrides from connections prop (only for accounts that have a value set)
  // We use a functional updater so we don't overwrite values the user is currently editing
  useEffect(() => {
    setAccountRetryOverrides(prev => {
      const next = { ...prev };
      connections.forEach(c => {
        // Only initialise — don't overwrite if already in state (user may be mid-edit)
        if (!(c.id in next)) {
          next[c.id] = c.antigravity503RetryCount != null ? String(c.antigravity503RetryCount) : "";
        }
      });
      return next;
    });
  }, [connections]);

  // Fetch health data for all pool accounts from disk-backed store
  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/internal/account-health");
      if (!res.ok) return;
      const data = await res.json();
      setHealthData(data.accounts || {});
    } catch { /* ignore */ }
  }, []);

  // Fetch quota for each pool account (with cache)
  const fetchQuotas = useCallback(async (accounts, force = false) => {
    if (!accounts || accounts.length === 0) return;

    const now = Date.now();
    const toFetch = [];
    const cached = {};

    // Check cache for each account
    accounts.forEach(acc => {
      const entry = quotaCacheRef.current[acc.id];
      if (!force && entry && (now - entry.ts) < QUOTA_CACHE_TTL_MS) {
        // Use cached data
        cached[acc.id] = { quotas: entry.data, error: entry.error, loading: false, accountType: entry.accountType || null };
      } else {
        toFetch.push(acc);
      }
    });

    // Apply cached results immediately
    if (Object.keys(cached).length > 0) {
      setQuotas(prev => ({ ...prev, ...cached }));
    }

    // Nothing to fetch — all served from cache
    if (toFetch.length === 0) return;

    // Mark uncached as loading
    const loadingState = {};
    toFetch.forEach(acc => { loadingState[acc.id] = { quotas: [], error: null, loading: true }; });
    setQuotas(prev => ({ ...prev, ...loadingState }));

    // Fetch in parallel
    await Promise.all(toFetch.map(async (acc) => {
      try {
        const res = await fetch(`/api/usage/${acc.id}`);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          const error = errData.error || `HTTP ${res.status}`;
          quotaCacheRef.current[acc.id] = { data: [], error, ts: Date.now(), accountType: null };
          setQuotas(prev => ({
            ...prev,
            [acc.id]: { quotas: [], error, loading: false, accountType: null },
          }));
          return;
        }
        const data = await res.json();
        const parsed = parseQuotaData(tool.tokenSwapProvider || "antigravity", data);
        const accountType = inferAntigravityAccountType(data);
        quotaCacheRef.current[acc.id] = { data: parsed, error: null, ts: Date.now(), accountType };
        setQuotas(prev => ({
          ...prev,
          [acc.id]: { quotas: parsed, error: null, loading: false, accountType },
        }));
      } catch (err) {
        const error = err.message || "Failed";
        quotaCacheRef.current[acc.id] = { data: [], error, ts: Date.now(), accountType: null };
        setQuotas(prev => ({
          ...prev,
          [acc.id]: { quotas: [], error, loading: false, accountType: null },
        }));
      }
    }));
  }, [tool.tokenSwapProvider]);

  if (!tool?.supportsTokenSwap) return null;

  const toggleEnabled = async () => {
    setToggling(true);
    const newVal = !enabled;
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenSwapEnabled: newVal }),
      });
      if (res.ok) {
        setEnabled(newVal);
        onToggle?.(newVal);
      }
    } catch { /* ignore */ }
    setToggling(false);
  };

  const setStrategyValue = async (val) => {
    if (val === strategy || togglingStrategy) return;
    setTogglingStrategy(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenSwapStrategy: val }),
      });
      if (res.ok) setStrategy(val);
    } catch { /* ignore */ }
    setTogglingStrategy(false);
  };

  const toggleMaskEmails = async () => {
    if (togglingMaskEmails) return;
    setTogglingMaskEmails(true);
    const newVal = !maskEmails;
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenSwapMaskEmails: newVal }),
      });
      if (res.ok) setMaskEmails(newVal);
    } catch { /* ignore */ }
    setTogglingMaskEmails(false);
  };


  const providerAccounts = connections.filter(
    (c) => c.provider === tool.tokenSwapProvider
  );
  const activeAccounts = providerAccounts.filter(
    (c) => c.isActive !== false
  );
  const activeCount = activeAccounts.length;
  const providerAccountsKey = providerAccounts.map((acc) => acc.id).join("|");
  const providerCooldownKey = providerAccounts
    .map((acc) => {
      const modelLocks = Object.entries(acc)
        .filter(([key, value]) => key.startsWith("modelLock_") && value)
        .map(([key, value]) => `${key}:${value}`)
        .sort()
        .join(",");
      return `${acc.id}:${acc.rateLimitedUntil || ""}:${modelLocks}`;
    })
    .join("|");
  const preferredAccountId = getPreferredAccountId(activeAccounts, strategy);

  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    const hasCooldown = providerAccounts.some((acc) => getAccountCooldownMeta(acc));
    if (!hasCooldown) return;

    const interval = setInterval(() => setCooldownNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [providerCooldownKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fetch quotas when enabled and accounts available
  // Keep this keyed to account identity only. Active/inactive toggles should not
  // fan out into quota requests for every account.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    if (enabled && providerAccounts.length > 0) {
      fetchQuotas(providerAccounts);
    }
  }, [enabled, providerAccounts.length, providerAccountsKey, fetchQuotas]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll health data every 10s when token swap is enabled
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    if (!enabled || activeCount === 0) return;
    fetchHealth();
    const interval = setInterval(fetchHealth, 10_000);
    return () => clearInterval(interval);
  }, [enabled, activeCount, fetchHealth]);

  // Prerequisites check
  const prereqsMet = serverRunning && dnsActive;
  const isFullyActive = enabled && prereqsMet && activeCount > 0;

  /**
   * Render inline quota info for a single account
   */
  const getAccountQuotaMeta = (accId) => {
    const q = quotas[accId];
    if (!q) return { state: "empty" };
    if (q.loading) return { state: "loading" };
    if (q.error) return { state: "error", error: q.error };
    if (!q.quotas || q.quotas.length === 0) return { state: "no-data" };

    const families = pickQuotaFamilyBars(q.quotas);
    if (!families.some(({ rows }) => rows.some(({ quota }) => getQuotaPercentage(quota) !== null))) {
      return { state: "no-data" };
    }
    return { state: "ready", families };
  };

  const getResolvedAccountType = (acc) => (
    normalizeAntigravityAccountType(quotas[acc.id]?.accountType) ||
    normalizeAntigravityAccountType(acc.accountType) ||
    null
  );

  /**
   * Get dot background color based on health event
   */
  const getHealthDotColor = (event) => {
    if (event.status === "success") return "#22c55e";   // green-500
    if (event.status === "fail")    return "#ef4444";   // red-500
    // retry_success — shade by attempt count
    if (event.attempts <= 2) return "#fb923c";          // orange-400
    if (event.attempts <= 3) return "#f97316";          // orange-500
    return "#ea580c";                                   // orange-600
  };

  /**
   * Tooltip text for a health event dot
   */
  const getHealthDotTitle = (event) => {
    const time = new Date(event.ts).toLocaleTimeString(undefined, {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const attempts = Number(event.attempts) || 1;
    if (event.status === "success") return `${time} — ✅ Success`;
    if (event.status === "fail")    return `${time} — ❌ Failed`;
    // retry_success — show how many attempts it took to succeed
    return `${time} — 🔄 Success after ${attempts} attempt${attempts !== 1 ? "s" : ""}`;
  };


  /**
   * Returns true if the event timestamp is from today (local time)
   */
  const isToday = (ts) => {
    const now = new Date();
    const d = new Date(ts);
    return d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
  };

  /**
   * Render the health dot strip for an account (last 100 calls)
   */
  const renderHealthDots = (accId) => {
    const events = healthData[accId];
    if (!events || events.length === 0) return null;

    const successCount  = events.filter(e => e.status === "success").length;
    const retryCount    = events.filter(e => e.status === "retry_success").length;
    const failCount     = events.filter(e => e.status === "fail").length;

    return (
      <div className="mt-1.5">
        <div
          className="flex flex-wrap gap-[2px]"
          title={`Last ${events.length} call${events.length !== 1 ? "s" : ""}${successCount ? ` · ${successCount} ok` : ""}${retryCount ? ` · ${retryCount} retry` : ""}${failCount ? ` · ${failCount} fail` : ""}`}
        >
          {events.map((event, idx) => {
            const todayDot = isToday(event.ts);
            const color = getHealthDotColor(event);
            return (
            <div
              key={idx}
              className={`shrink-0 rounded-[1px]${todayDot ? " animate-pulse" : ""}`}
              style={{
                width: todayDot ? "7px" : "6px",
                height: todayDot ? "7px" : "6px",
                backgroundColor: color,
                opacity: todayDot ? 1 : 0.45,
                boxShadow: todayDot ? `0 0 5px 1px ${color}` : undefined,
              }}
              title={getHealthDotTitle(event)}
            />
            );
          })}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[9px] text-text-muted">
            last {events.length} call{events.length !== 1 ? "s" : ""}
          </span>
          {successCount > 0 && <span className="text-[9px] text-green-500">{successCount} ok</span>}
          {retryCount > 0 && <span className="text-[9px] text-orange-400">{retryCount} retry</span>}
          {failCount > 0 && <span className="text-[9px] text-red-400">{failCount} fail</span>}
        </div>
      </div>
    );
  };

  const renderAccountQuota = (accId) => {
    const meta = getAccountQuotaMeta(accId);
    if (!meta || meta.state === "empty") {
      return <span className="text-[10px] text-text-muted">Enable to load quota data</span>;
    }
    if (meta.state === "loading") {
      return <span className="text-[10px] text-text-muted animate-pulse">Loading quota…</span>;
    }
    if (meta.state === "error") {
      return <span className="text-[10px] text-red-400" title={meta.error}>Quota unavailable</span>;
    }
    if (meta.state === "no-data") {
      return <span className="text-[10px] text-text-muted">No quota data</span>;
    }

    // Claude left, Gemini right; one line per window. Stacks on narrow screens.
    return (
      <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2 min-w-0">
        {meta.families.map(({ family, rows }) => (
          <div key={family} className="grid grid-cols-[3.75rem_1fr_2.25rem_3.25rem] items-center gap-x-2 min-w-0">
            {rows.map(({ window, quota }) => {
              const pct = getQuotaPercentage(quota);
              const resetAt = getFutureResetAt(quota);
              const title = quota
                ? [
                    quota.name,
                    quota.total > 0 && `${quota.used.toLocaleString()} / ${quota.total.toLocaleString()} used`,
                    resetAt && `resets ${formatResetTimeDisplay(resetAt)}`,
                  ].filter(Boolean).join(" · ")
                : `No ${family} ${window} quota for this account`;
              return (
                <div key={window} className="contents" title={title}>
                  <span className={`text-[10px] truncate ${pct === null ? "text-text-muted/50" : "text-text-muted"}`}>
                    {family} {window}
                  </span>
                  <div className="h-1 rounded-full bg-border/60 overflow-hidden">
                    {pct !== null && (
                      <div className={`h-full rounded-full ${getQuotaBg(pct)}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                    )}
                  </div>
                  <span className={`text-[10px] font-medium text-right tabular-nums ${pct === null ? "text-text-muted/50" : getQuotaColor(pct)}`}>
                    {pct === null ? "—" : `${pct}%`}
                  </span>
                  <span className="text-[9px] text-text-muted/70 tabular-nums truncate">
                    {resetAt ? `↺ ${formatCompactCountdown(resetAt)}` : ""}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  };

  const toggleAccountActive = async (accountId, nextActive) => {
    if (!accountId || togglingAccountIds.has(accountId)) return;
    setTogglingAccountIds(prev => new Set([...prev, accountId]));
    try {
      const res = await fetch(`/api/providers/${accountId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: nextActive }),
      });
      if (res.ok) {
        await onRefreshConnections?.();
      }
    } catch { /* ignore */ }
    setTogglingAccountIds(prev => { const next = new Set(prev); next.delete(accountId); return next; });
  };

  const refreshAccountQuota = async (acc) => {
    if (!acc?.id || refreshingQuotaIds.has(acc.id) || refreshingAllQuotas || togglingAccountIds.has(acc.id)) return;
    setRefreshingQuotaIds(prev => new Set([...prev, acc.id]));
    // Bust cache for this account and force a fresh fetch
    delete quotaCacheRef.current[acc.id];
    await fetchQuotas([acc], true);
    setRefreshingQuotaIds(prev => { const next = new Set(prev); next.delete(acc.id); return next; });
  };

  const refreshAllQuotas = async () => {
    if (refreshingAllQuotas || refreshingQuotaIds.size > 0 || providerAccounts.length === 0) return;
    setRefreshingAllQuotas(true);
    // Bust cache for all pool accounts then force-fetch in parallel
    providerAccounts.forEach((acc) => { delete quotaCacheRef.current[acc.id]; });
    await fetchQuotas(providerAccounts, true);
    setRefreshingAllQuotas(false);
  };


  const setRetryCount503Value = async (val) => {
    const clamped = Math.max(0, Math.min(20, isNaN(val) ? DEFAULT_503_RETRY_COUNT : val));
    setRetryCount503(clamped);
    // Debounce save to avoid rapid API calls while user is typing/stepping
    if (retryCount503TimerRef.current) clearTimeout(retryCount503TimerRef.current);
    retryCount503TimerRef.current = setTimeout(async () => {
      try {
        await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ antigravity503RetryCount: clamped }),
        });
      } catch { /* ignore */ }
    }, 500);
  };

  const updateAccountRetryCount = (accountId, value) => {
    // Update local state immediately so the user can type freely
    setAccountRetryOverrides(prev => ({ ...prev, [accountId]: value }));

    // Debounce the API save — no onRefreshConnections here so the input isn't reset mid-type
    if (accountRetryTimersRef.current[accountId]) clearTimeout(accountRetryTimersRef.current[accountId]);
    accountRetryTimersRef.current[accountId] = setTimeout(async () => {
      const parsed = value === "" ? null : Math.max(0, Math.min(20, parseInt(value) || 0));
      try {
        await fetch(`/api/providers/${accountId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ antigravity503RetryCount: parsed }),
        });
      } catch { /* ignore */ }
    }, 500);
  };

  // Toggle custom 503 retry on/off for an account
  const toggleAccountCustomRetry = (accountId, currentHasCustom) => {
    if (currentHasCustom) {
      // Revert to global default — save null immediately
      setAccountRetryOverrides(prev => ({ ...prev, [accountId]: "" }));
      if (accountRetryTimersRef.current[accountId]) clearTimeout(accountRetryTimersRef.current[accountId]);
      fetch(`/api/providers/${accountId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ antigravity503RetryCount: null }),
      }).catch(() => {});
    } else {
      // Enable custom — default to the current global value
      const customVal = String(retryCount503);
      setAccountRetryOverrides(prev => ({ ...prev, [accountId]: customVal }));
      fetch(`/api/providers/${accountId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ antigravity503RetryCount: retryCount503 }),
      }).catch(() => {});
    }
  };

  return (
    <Card padding="xs" className="overflow-hidden">
      {/* ── Header ────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0 rounded-lg bg-violet-500/10">
            <span className="material-symbols-outlined text-violet-400 text-[18px]">swap_horiz</span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-sm">Token Rotation</h3>
              <span className="text-[9px] uppercase tracking-wider text-text-muted bg-surface border border-border px-1.5 py-0.5 rounded font-semibold">
                Mode B
              </span>
              {isFullyActive ? (
                <Badge variant="success" size="sm">Active</Badge>
              ) : enabled ? (
                <Badge variant="warning" size="sm">Enabled</Badge>
              ) : (
                <Badge variant="default" size="sm">Off</Badge>
              )}
            </div>
            <p className="text-xs text-text-muted">
              Rotate auth tokens across pool accounts to bypass per-account quota
            </p>
          </div>
        </div>

        {/* Toggle */}
        <button
          onClick={toggleEnabled}
          disabled={toggling}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
            enabled ? "bg-violet-500" : "bg-surface-alt border border-border"
          } ${toggling ? "opacity-50" : "cursor-pointer"}`}
          title={enabled ? "Disable Token Rotation" : "Enable Token Rotation"}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform shadow-sm ${
              enabled ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {/* ── Body — only shown when enabled ───────── */}
      {enabled && (
        <div className="mt-3 pt-3 border-t border-border/50 flex flex-col gap-3">

          {/* How it works */}
          <div className="flex items-start gap-2 px-2 py-2 rounded-lg bg-violet-500/5 border border-violet-500/15">
            <span className="material-symbols-outlined text-[14px] text-violet-400 mt-0.5 shrink-0">info</span>
            <div className="text-[11px] text-text-muted leading-relaxed">
              <p>Intercepts Antigravity requests → swaps IDE&apos;s auth token with a pool account → auto-retries on 429 quota error with next account in pool.</p>
              <p className="mt-1 text-violet-400/80 font-medium">⚠ When active, Model Routing (Mode A) is bypassed.</p>
            </div>
          </div>

          {/* Strategy selector */}
          <div className="flex flex-col gap-1.5 px-1">
            <p className="text-[10px] uppercase tracking-wider text-text-muted font-semibold">Rotation Strategy</p>
            <div className="flex gap-1.5">
              <button
                onClick={() => setStrategyValue("round-robin")}
                disabled={togglingStrategy}
                className={`flex-1 flex flex-col items-center gap-0.5 px-2 py-2 rounded-lg border text-[11px] font-medium transition-colors ${
                  strategy === "round-robin"
                    ? "border-violet-500/50 bg-violet-500/10 text-violet-400"
                    : "border-border bg-surface text-text-muted hover:border-border-alt"
                } disabled:opacity-50`}
              >
                <span className="material-symbols-outlined text-[14px]">autorenew</span>
                Round Robin
              </button>
              <button
                onClick={() => setStrategyValue("sticky")}
                disabled={togglingStrategy}
                className={`flex-1 flex flex-col items-center gap-0.5 px-2 py-2 rounded-lg border text-[11px] font-medium transition-colors ${
                  strategy === "sticky"
                    ? "border-violet-500/50 bg-violet-500/10 text-violet-400"
                    : "border-border bg-surface text-text-muted hover:border-border-alt"
                } disabled:opacity-50`}
              >
                <span className="material-symbols-outlined text-[14px]">push_pin</span>
                Sticky
              </button>
            </div>
            <p className="text-[10px] text-text-muted px-0.5">
              {strategy === "sticky"
                ? "Stays on the same account until its quota is exhausted for the requested model, then switches. Optimizes session-level token cache."
                : "Chooses the least recently used eligible account first. Each successful request updates that account's last-used time."}
            </p>
          </div>

          {/* Prerequisites */}
          <div className="flex flex-col gap-1 px-1">
            <p className="text-[10px] uppercase tracking-wider text-text-muted font-semibold mb-0.5">Prerequisites</p>
            <div className="flex items-center gap-2 text-xs">
              <span className={`material-symbols-outlined text-[14px] ${serverRunning ? "text-green-500" : "text-red-400"}`}>
                {serverRunning ? "check_circle" : "cancel"}
              </span>
              <span className={serverRunning ? "text-text-main" : "text-text-muted"}>MITM Server</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className={`material-symbols-outlined text-[14px] ${dnsActive ? "text-green-500" : "text-red-400"}`}>
                {dnsActive ? "check_circle" : "cancel"}
              </span>
              <span className={dnsActive ? "text-text-main" : "text-text-muted"}>
                DNS redirect
                {!dnsActive && <span className="text-[10px] text-text-muted ml-1">— enable via Antigravity card above</span>}
              </span>
            </div>
          </div>

          {/* Pool accounts with quota */}
          <div className="flex flex-col gap-1 px-1">
            <div className="flex items-center justify-between mb-0.5">
              <div className="flex items-center gap-2">
                <p className="text-[10px] uppercase tracking-wider text-text-muted font-semibold">Pool Accounts</p>
                <span className="text-[10px] text-text-muted">
                  {providerAccounts.length > 0 ? `${activeCount}/${providerAccounts.length} active` : "none"}
                </span>
                {activeCount > 1 && (
                  <span className="text-[9px] text-text-muted bg-surface border border-border px-1 py-0.5 rounded">
                    round-robin
                  </span>
                )}
              </div>
              {providerAccounts.length > 0 && (
                <button
                  onClick={refreshAllQuotas}
                  disabled={refreshingAllQuotas || refreshingQuotaIds.size > 0}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-medium text-text-main hover:border-border-alt hover:bg-surface-alt disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  title="Refresh quotas for all pool accounts, including disabled accounts"
                >
                  <span className={`material-symbols-outlined text-[12px] ${refreshingAllQuotas ? "animate-spin" : ""}`}>refresh</span>
                  {refreshingAllQuotas ? "Refreshing…" : "Refresh All"}
                </button>
              )}
            </div>
            <p className="text-[10px] text-text-muted px-0.5">
              Round robin uses least-recently-used ordering. Accounts with no usage timestamp are tried first, then older timestamps rotate ahead of newer ones.
            </p>
            {/* Compact controls row: Mask emails + 503 retry count */}
            <div className="flex items-center gap-2 px-1.5 py-1.5 rounded-lg border border-border bg-surface-alt/40">
              {/* Mask emails */}
              <button
                onClick={toggleMaskEmails}
                disabled={togglingMaskEmails}
                title={`${maskEmails ? "Disable" : "Enable"} email masking — hides pool account emails in logs and this panel (e.g. ${maskEmail("email@gmail.com")})`}
                className={`flex items-center gap-1.5 flex-1 min-w-0 px-1.5 py-1 rounded-md transition-colors text-left ${togglingMaskEmails ? "opacity-50" : "hover:bg-surface-alt cursor-pointer"}`}
              >
                <span className={`material-symbols-outlined text-[13px] shrink-0 ${maskEmails ? "text-violet-400" : "text-text-muted"}`}>alternate_email</span>
                <span className={`text-[11px] font-medium truncate ${maskEmails ? "text-violet-300" : "text-text-muted"}`}>Mask emails</span>
                <span className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors shrink-0 ml-auto ${maskEmails ? "bg-violet-500" : "bg-surface-alt border border-border"}`}>
                  <span className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white transition-transform shadow-sm ${maskEmails ? "translate-x-3.5" : "translate-x-0.5"}`} />
                </span>
              </button>

              <div className="w-px h-5 bg-border shrink-0" />

              {/* 503 Retry Count */}
              <div
                className="flex items-center gap-1.5 shrink-0"
                title="Global 503 retry count (0–20). Retry &quot;high traffic&quot; errors on same account before switching. Each account row can override this."
              >
                <span className="text-[11px] text-text-muted whitespace-nowrap">503 retries</span>
                <input
                  type="number"
                  min="0"
                  max="20"
                  step="1"
                  value={retryCount503}
                  onChange={(e) => setRetryCount503Value(parseInt(e.target.value))}
                  className="w-10 rounded border border-border bg-surface px-1 py-0.5 text-[11px] text-text-main text-center focus:outline-none focus:border-violet-500 transition-colors"
                  title="Global 503 retry count (0-20). Each account can override this."
                />
              </div>
            </div>

            {providerAccounts.length > 0 ? (
              <>
                {providerAccounts.map((acc) => {
                  const accountType = getResolvedAccountType(acc);
                  const cooldownMeta = getAccountCooldownMeta(acc, cooldownNow);
                  return (
                  <div
                    key={acc.id}
                    className={`rounded-xl border border-border bg-surface-alt/30 px-3 py-2.5 transition-colors ${
                      acc.isActive === false ? "opacity-65" : "hover:bg-surface-alt/50"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`material-symbols-outlined text-[14px] shrink-0 ${acc.isActive === false ? "text-text-muted" : "text-green-500"}`}>
                            {acc.isActive === false ? "pause_circle" : "check_circle"}
                          </span>
                          <span className="text-xs font-medium text-text-main truncate">
                            {getAccountDisplay(acc, maskEmails)}
                          </span>
                          {accountType && (
                            <Badge variant={getAccountTypeBadgeVariant(accountType)} size="sm">
                              {accountType}
                            </Badge>
                          )}
                          {preferredAccountId === acc.id && acc.isActive !== false && (
                            <span className="text-[9px] text-violet-300 bg-violet-500/10 border border-violet-500/20 px-1 py-0.5 rounded shrink-0">
                              next
                            </span>
                          )}
                          <span title={acc.isActive === false ? "Disabled - excluded from token rotation." : "Included in token rotation."}>
                            <Badge variant={acc.isActive === false ? "default" : "success"} size="sm">
                              {acc.isActive === false ? "disabled" : "active"}
                            </Badge>
                          </span>
                          {cooldownMeta && (
                            <span
                              className="text-[9px] font-medium text-amber-300 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded shrink-0"
                              title={cooldownMeta.title}
                            >
                              cooldown {cooldownMeta.duration}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px] text-text-muted">
                          <span>Priority #{acc.priority ?? "-"}</span>
                          {acc.lastUsedAt && <span>Last used {new Date(acc.lastUsedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>}
                          {/* 503 retry: show global default OR custom override */}
                          {(() => {
                            const localVal = accountRetryOverrides[acc.id];
                            const hasCustom = localVal != null && localVal !== "";
                            return hasCustom ? (
                              <span className="inline-flex items-center gap-1 rounded bg-violet-500/10 border border-violet-500/20 px-1.5 py-0.5" title={`Custom 503 retry count for this account. Global default: ${retryCount503}. Auto-saves. Click ↩ to revert.`}>
                                <span className="text-violet-300">503:</span>
                                <input
                                  type="number"
                                  min="0"
                                  max="20"
                                  step="1"
                                  value={localVal}
                                  onChange={(e) => updateAccountRetryCount(acc.id, e.target.value)}
                                  className="w-8 rounded border-none bg-transparent text-[10px] text-center text-violet-200 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                  title={`Custom 503 retry count for this account (global: ${retryCount503}). Auto-saves as you type.`}
                                  autoFocus
                                />
                                <button
                                  onClick={() => toggleAccountCustomRetry(acc.id, true)}
                                  className="text-violet-400/70 hover:text-text-muted transition-colors leading-none"
                                  title={`Revert to global default (${retryCount503})`}
                                >
                                  <span className="material-symbols-outlined text-[11px]">undo</span>
                                </button>
                              </span>
                            ) : (
                              <button
                                onClick={() => toggleAccountCustomRetry(acc.id, false)}
                                className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-text-muted hover:bg-surface-alt hover:text-text-main transition-colors"
                                title={`Using global 503 retry count (${retryCount503}). Click to set a custom value for this account only.`}
                              >
                                <span>503: {retryCount503}</span>
                                <span className="text-[10px] opacity-60 leading-none">✎</span>
                              </button>
                            );
                          })()}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                          <button
                            onClick={() => refreshAccountQuota(acc)}
                            disabled={refreshingQuotaIds.has(acc.id) || togglingAccountIds.has(acc.id)}
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-medium text-text-main hover:border-border-alt hover:bg-surface-alt disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            title="Force-refresh quota for this account"
                          >
                            <span className="material-symbols-outlined text-[12px]">refresh</span>
                            {refreshingQuotaIds.has(acc.id) ? "…" : "Refresh Quota"}
                          </button>
                        <Toggle
                          size="sm"
                          checked={acc.isActive !== false}
                          disabled={refreshingQuotaIds.has(acc.id) || togglingAccountIds.has(acc.id)}
                          onChange={(nextChecked) => toggleAccountActive(acc.id, nextChecked)}
                        />
                      </div>

                    </div>
                    <div className="mt-2 pl-6">
                      {renderAccountQuota(acc.id)}
                      {/* Health pulse — last 100 call results as colored squares */}
                      {renderHealthDots(acc.email || acc.id)}
                    </div>
                  </div>
                  );
                })}
                <Link
                  href="/dashboard/providers"
                  className="text-[11px] text-primary hover:underline flex items-center gap-1 px-1 mt-1"
                >
                  <span className="material-symbols-outlined text-[12px]">open_in_new</span>
                  Manage accounts
                </Link>
              </>
            ) : (
              <div className="px-1">
                <p className="text-xs text-text-muted">
                  No active {tool.name} accounts in pool.{" "}
                  <Link href="/dashboard/providers" className="text-primary hover:underline">
                    Add account →
                  </Link>
                </p>
              </div>
            )}
          </div>

          {/* Status summary */}
          {!prereqsMet && (
            <div className="flex items-center gap-2 px-2 py-1.5 rounded text-xs bg-amber-500/10 text-amber-600 border border-amber-500/20">
              <span className="material-symbols-outlined text-[14px]">warning</span>
              <span>Start MITM server and enable DNS to activate token rotation</span>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
