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

// Model to highlight in the quota summary
const HIGHLIGHT_MODEL = "claude-sonnet-4-6";

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
  const [togglingAccountId, setTogglingAccountId] = useState(null);
  const [resettingAccountId, setResettingAccountId] = useState(null);
  const [resettingAll, setResettingAll] = useState(false);
  const [quotas, setQuotas] = useState({}); // { [connId]: { quotas: [], error: string|null, loading: bool, accountType?: string|null } }
  const quotaCacheRef = useRef({}); // { [connId]: { data: parsed, error, ts: number, accountType?: string|null } }
  const retryCount503TimerRef = useRef(null); // debounce timer for 503 retry save

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
  const activeAccountsKey = activeAccounts.map((acc) => acc.id).join("|");
  const preferredAccountId = getPreferredAccountId(activeAccounts, strategy);

  // Auto-fetch quotas when enabled and accounts available
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    if (enabled && activeCount > 0) {
      fetchQuotas(activeAccounts);
    }
  }, [enabled, activeCount, activeAccountsKey, fetchQuotas]); // eslint-disable-line react-hooks/exhaustive-deps

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

    // Find highlight model, fallback to first quota with data
    const highlight = q.quotas.find(m =>
      m.modelKey?.includes(HIGHLIGHT_MODEL) || m.name?.toLowerCase().includes("opus")
    ) || q.quotas[0];

    if (!highlight) return { state: "no-data" };

    const pct = highlight.remainingPercentage !== undefined
      ? Math.round(highlight.remainingPercentage)
      : highlight.total > 0
        ? Math.round(((highlight.total - highlight.used) / highlight.total) * 100)
        : null;

    const highlightResetAt = highlight.resetAt && new Date(highlight.resetAt).getTime() > Date.now()
      ? highlight.resetAt
      : null;

    const nextResetAt = highlightResetAt || [...q.quotas]
      .map((quota) => quota.resetAt)
      .filter(Boolean)
      .filter((resetAt) => new Date(resetAt).getTime() > Date.now())
      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0] || null;

    return {
      state: pct === null ? "no-data" : "ready",
      highlight,
      accountType: q.accountType || null,
      pct,
      nextResetAt,
      resetCountdown: formatResetTime(nextResetAt),
      resetDisplay: formatResetTimeDisplay(nextResetAt),
    };
  };

  const getResolvedAccountType = (acc) => (
    normalizeAntigravityAccountType(quotas[acc.id]?.accountType) ||
    normalizeAntigravityAccountType(acc.accountType) ||
    null
  );

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

    const { highlight, pct, resetCountdown, resetDisplay } = meta;
    return (
      <div className="flex flex-col gap-1.5 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] text-text-muted truncate">{highlight.name}</span>
          <div className="flex-1 h-1.5 rounded-full bg-surface-alt overflow-hidden min-w-[56px]">
            <div className={`h-full rounded-full ${getQuotaBg(pct)}`} style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
          <span className={`text-[10px] font-medium shrink-0 ${getQuotaColor(pct)}`}>{pct}%</span>
        </div>
        {resetCountdown !== "-" && resetDisplay ? (
          <div className="text-[10px] text-text-muted">
            Reset in <span className="text-text-main">{resetCountdown}</span>
            <span className="text-text-muted/70"> • {resetDisplay}</span>
          </div>
        ) : (
          <div className="text-[10px] text-text-muted">Reset time unavailable</div>
        )}
      </div>
    );
  };

  const toggleAccountActive = async (accountId, nextActive) => {
    if (!accountId || togglingAccountId || resettingAll || resettingAccountId) return;
    setTogglingAccountId(accountId);
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
    setTogglingAccountId(null);
  };

  const resetAccountRecency = async (accountId) => {
    if (!accountId || resettingAccountId || resettingAll || togglingAccountId) return;
    setResettingAccountId(accountId);
    try {
      const res = await fetch(`/api/providers/${accountId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lastUsedAt: null,
        }),
      });
      if (res.ok) {
        await onRefreshConnections?.();
      }
    } catch { /* ignore */ }
    setResettingAccountId(null);
  };

  const resetAllRecency = async () => {
    if (resettingAll || resettingAccountId || togglingAccountId || providerAccounts.length === 0) return;
    setResettingAll(true);
    try {
      await Promise.all(providerAccounts.map((acc) => (
        fetch(`/api/providers/${acc.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lastUsedAt: null,
          }),
        })
      )));
      await onRefreshConnections?.();
    } catch { /* ignore */ }
    setResettingAll(false);
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

  const updateAccountRetryCount = async (accountId, value) => {
    const parsed = value === "" ? null : Math.max(0, Math.min(20, parseInt(value) || 0));
    try {
      await fetch(`/api/providers/${accountId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ antigravity503RetryCount: parsed }),
      });
      await onRefreshConnections?.();
    } catch { /* ignore */ }
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
              <div className="flex items-center gap-2">
                {activeCount > 0 && (
                  <button
                    onClick={() => fetchQuotas(activeAccounts, true)}
                    className="text-[10px] text-text-muted hover:text-primary flex items-center gap-0.5 transition-colors"
                    title="Refresh quotas"
                  >
                    <span className="material-symbols-outlined text-[12px]">refresh</span>
                  </button>
                )}
                {strategy === "round-robin" && providerAccounts.length > 0 && (
                  <button
                    onClick={resetAllRecency}
                    disabled={resettingAll || !!resettingAccountId}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-medium text-text-main hover:border-border-alt hover:bg-surface-alt disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    title="Clear last-used timestamps for all pool accounts"
                  >
                    <span className="material-symbols-outlined text-[12px]">restart_alt</span>
                    Reset order
                  </button>
                )}
              </div>
            </div>
            <p className="text-[10px] text-text-muted px-0.5">
              Round robin uses least-recently-used ordering. Accounts with no usage timestamp are tried first, then older timestamps rotate ahead of newer ones.
            </p>
            <div className="flex items-center justify-between gap-3 px-2 py-2 rounded-lg border border-border bg-surface-alt/40">
              <div className="min-w-0">
                <p className="text-[11px] font-medium text-text-main">Mask account emails</p>
                <p className="text-[10px] text-text-muted">
                  Hide pool account emails in token swap logs and this panel. Example: {maskEmail("email@gmail.com")}
                </p>
              </div>
              <button
                onClick={toggleMaskEmails}
                disabled={togglingMaskEmails}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
                  maskEmails ? "bg-violet-500" : "bg-surface border border-border"
                } ${togglingMaskEmails ? "opacity-50" : "cursor-pointer"}`}
                title={maskEmails ? "Disable email masking" : "Enable email masking"}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform shadow-sm ${
                    maskEmails ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>

            {/* 503 Retry Count (global) */}
            <div className="flex items-center justify-between gap-3 px-2 py-2 rounded-lg border border-border bg-surface-alt/40">
              <div className="min-w-0">
                <p className="text-[11px] font-medium text-text-main">503 Retry Count</p>
                <p className="text-[10px] text-text-muted">
                  Retry 503 &quot;high traffic&quot; errors on same account before switching. Google often returns false 503s.
                </p>
              </div>
              <input
                type="number"
                min="0"
                max="20"
                step="1"
                value={retryCount503}
                onChange={(e) => setRetryCount503Value(parseInt(e.target.value))}
                className="w-14 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-main text-center focus:outline-none focus:border-violet-500 transition-colors"
                title="Global 503 retry count (0-20). Each account can override this."
              />
            </div>

            {providerAccounts.length > 0 ? (
              <>
                {providerAccounts.map((acc) => {
                  const accountType = getResolvedAccountType(acc);
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
                          <Badge variant={acc.isActive === false ? "default" : "success"} size="sm">
                            {acc.isActive === false ? "disabled" : "active"}
                          </Badge>
                        </div>
                        <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px] text-text-muted">
                          <span>Priority #{acc.priority ?? "-"}</span>
                          {acc.lastUsedAt && <span>Last used {new Date(acc.lastUsedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>}
                          <span className="flex items-center gap-1">
                            503 retries:
                            <input
                              type="number"
                              min="0"
                              max="20"
                              step="1"
                              value={acc.antigravity503RetryCount ?? ""}
                              placeholder={String(retryCount503)}
                              onChange={(e) => updateAccountRetryCount(acc.id, e.target.value)}
                              className="w-10 rounded border border-border bg-surface px-1 py-0.5 text-[10px] text-center text-text-main placeholder:text-text-muted/50 focus:outline-none focus:border-violet-500 transition-colors"
                              title={`Override 503 retry count for this account (global default: ${retryCount503}). Leave empty to use global.`}
                            />
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        {strategy === "round-robin" && (
                          <button
                            onClick={() => resetAccountRecency(acc.id)}
                            disabled={resettingAll || togglingAccountId === acc.id || resettingAccountId === acc.id}
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-medium text-text-main hover:border-border-alt hover:bg-surface-alt disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            title="Clear this account's last-used timestamp"
                          >
                            <span className="material-symbols-outlined text-[12px]">restart_alt</span>
                            {resettingAccountId === acc.id ? "..." : "Reset Order"}
                          </button>
                        )}
                        <Toggle
                          size="sm"
                          checked={acc.isActive !== false}
                          disabled={resettingAll || resettingAccountId === acc.id || togglingAccountId === acc.id}
                          onChange={(nextChecked) => toggleAccountActive(acc.id, nextChecked)}
                        />
                      </div>
                    </div>
                    <div className="mt-2 pl-6">
                      {acc.isActive === false ? (
                        <div className="text-[10px] text-text-muted">
                          Enable this account to include it in token rotation and load quota reset info.
                        </div>
                      ) : (
                        renderAccountQuota(acc.id)
                      )}
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
