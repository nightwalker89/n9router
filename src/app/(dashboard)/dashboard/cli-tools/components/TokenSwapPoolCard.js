"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Badge } from "@/shared/components";
import Link from "next/link";

/**
 * Token Swap Pool Card — standalone card for token rotation mode.
 *
 * Clearly separated from Model Routing (MitmToolCard).
 * Has its own enable/disable toggle stored in settings.tokenSwapEnabled.
 * Shows prerequisite status (MITM server + DNS).
 *
 * When enabled:
 *  - MITM intercepts Antigravity requests
 *  - Swaps IDE auth token with pool account token
 *  - Auto-retries on 429 with next account (round-robin)
 *  - Model routing (mitmAlias) is BYPASSED
 */
export default function TokenSwapPoolCard({ tool, connections = [], serverRunning, dnsActive, onToggle }) {
  const [enabled, setEnabled] = useState(false);
  const [toggling, setToggling] = useState(false);

  const fetchEnabled = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = await res.json();
        setEnabled(!!data.tokenSwapEnabled);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchEnabled();
  }, [fetchEnabled]);

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

  const poolAccounts = connections.filter(
    (c) => c.provider === tool.tokenSwapProvider && c.isActive !== false
  );
  const activeCount = poolAccounts.length;

  // Prerequisites check
  const prereqsMet = serverRunning && dnsActive;
  const isFullyActive = enabled && prereqsMet && activeCount > 0;

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

          {/* Pool accounts */}
          <div className="flex flex-col gap-1 px-1">
            <div className="flex items-center gap-2 mb-0.5">
              <p className="text-[10px] uppercase tracking-wider text-text-muted font-semibold">Pool Accounts</p>
              <span className="text-[10px] text-text-muted">
                {activeCount > 0 ? `${activeCount} active` : "none"}
              </span>
              {activeCount > 1 && (
                <span className="text-[9px] text-text-muted bg-surface border border-border px-1 py-0.5 rounded">
                  round-robin
                </span>
              )}
            </div>

            {activeCount > 0 ? (
              <>
                {poolAccounts.map((acc) => {
                  const nearExpiry = acc.expiresAt
                    ? new Date(acc.expiresAt).getTime() - Date.now() < 24 * 60 * 60 * 1000
                    : false;
                  return (
                    <div key={acc.id} className="flex items-center gap-2 px-1 py-0.5">
                      <span
                        className={`material-symbols-outlined text-[14px] shrink-0 ${
                          nearExpiry ? "text-amber-500" : "text-green-500"
                        }`}
                      >
                        {nearExpiry ? "warning" : "check_circle"}
                      </span>
                      <span className="flex-1 text-xs text-text-main truncate">
                        {acc.email || acc.name || acc.id.slice(0, 16)}
                      </span>
                      {acc.priority != null && (
                        <span className="text-[10px] text-text-muted shrink-0">p{acc.priority}</span>
                      )}
                      {nearExpiry && (
                        <span className="text-[10px] text-amber-500 shrink-0">expires soon</span>
                      )}
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
