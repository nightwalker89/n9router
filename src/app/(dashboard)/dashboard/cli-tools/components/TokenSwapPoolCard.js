"use client";

import { Card, Badge } from "@/shared/components";

/**
 * Token Swap Pool Card — standalone card shown below the Antigravity MITM card.
 *
 * Displays the pool of providerConnections used for token rotation.
 * Completely separate from model-mapping / DNS concerns.
 *
 * Props:
 *  - tool: MITM_TOOLS entry that has supportsTokenSwap:true
 *  - connections: all providerConnections from /api/providers
 *  - serverRunning: boolean — MITM server state (informational only)
 */
export default function TokenSwapPoolCard({ tool, connections = [], serverRunning }) {
  if (!tool?.supportsTokenSwap) return null;

  const poolAccounts = connections.filter(
    (c) => c.provider === tool.tokenSwapProvider && c.isActive !== false
  );

  const isNearExpiry = (expiresAt) => {
    if (!expiresAt) return false;
    return new Date(expiresAt).getTime() - Date.now() < 24 * 60 * 60 * 1000; // < 24h
  };

  const activeCount = poolAccounts.length;

  return (
    <Card padding="xs" className="overflow-hidden">
      {/* Header — always visible, no collapse */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Key icon */}
          <div className="size-8 flex items-center justify-center shrink-0 rounded-lg bg-primary/10">
            <span className="material-symbols-outlined text-primary text-[18px]">key</span>
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-sm">Token Swap Pool</h3>
              <Badge variant={activeCount > 0 ? "success" : "warning"} size="sm">
                {activeCount > 0 ? `${activeCount} active` : "No accounts"}
              </Badge>
              {activeCount > 1 && (
                <span className="text-[10px] text-text-muted bg-surface border border-border px-1.5 py-0.5 rounded">
                  round-robin
                </span>
              )}
            </div>
            <p className="text-xs text-text-muted">
              Rotate {tool.name} accounts to bypass per-account quota limits
            </p>
          </div>
        </div>

        {/* Server indicator */}
        {!serverRunning && (
          <span className="text-[10px] text-text-muted shrink-0">MITM off</span>
        )}
      </div>

      {/* Body */}
      <div className="mt-3 pt-3 border-t border-border/50 flex flex-col gap-2">
        {activeCount > 0 ? (
          <>
            <div className="flex flex-col gap-1">
              {poolAccounts.map((acc) => {
                const nearExpiry = isNearExpiry(acc.expiresAt);
                return (
                  <div key={acc.id} className="flex items-center gap-2 px-1">
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
                      <span className="text-[10px] text-text-muted shrink-0">
                        p{acc.priority}
                      </span>
                    )}
                    {nearExpiry && (
                      <span className="text-[10px] text-amber-500 shrink-0">expires soon</span>
                    )}
                  </div>
                );
              })}
            </div>

            <a
              href="/dashboard/providers"
              className="text-[11px] text-primary hover:underline flex items-center gap-1 px-1 mt-1"
            >
              <span className="material-symbols-outlined text-[12px]">open_in_new</span>
              Manage accounts
            </a>
          </>
        ) : (
          <div className="flex flex-col gap-2 px-1">
            <p className="text-xs text-text-muted">
              No active {tool.name} accounts in pool.{" "}
              <a href="/dashboard/providers" className="text-primary hover:underline">
                Add account →
              </a>
            </p>
            <p className="text-[11px] text-text-muted/70">
              When accounts are added, MITM will auto-rotate tokens on 429 quota errors.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
