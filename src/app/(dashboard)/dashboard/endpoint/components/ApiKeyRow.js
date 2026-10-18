"use client";

import { useState, useRef, useEffect } from "react";
import Toggle from "@/shared/components/Toggle";
import KeyLimitsEditor from "./KeyLimitsEditor";
import KeyAccessControls from "./KeyAccessControls";

function fmtN(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(Math.floor(n));
}

function formatDurationCompact(ms) {
  const minutes = Math.floor(ms / (60 * 1000));
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function CompactQuota({ limits, usageData }) {
  if (!limits) return null;
  const u = usageData?.usage || null;
  const wu = usageData?.windowUsage || {};

  // Legacy 5h/24h items
  const items = [
    limits.inputTokens5h  && { label: "5h tok",  cur: u?.inputTokens5h,  max: limits.inputTokens5h },
    limits.inputTokens24h && { label: "24h tok", cur: u?.inputTokens24h, max: limits.inputTokens24h },
    limits.cost5h         && { label: "5h $",    cur: u?.cost5h,         max: limits.cost5h,  isCost: true },
    limits.cost24h        && { label: "24h $",   cur: u?.cost24h,        max: limits.cost24h, isCost: true },
  ].filter(Boolean);

  // Add custom window items
  if (limits.windows && Array.isArray(limits.windows)) {
    for (const win of limits.windows) {
      if (!win.durationMs) continue;
      const tokenKey = `tokens_${win.durationMs}`;
      const costKey = `cost_${win.durationMs}`;
      const label = formatDurationCompact(win.durationMs);

      if (win.inputTokens) {
        items.push({ label: `${label} tok`, cur: wu[tokenKey], max: win.inputTokens });
      }
      if (win.cost) {
        items.push({ label: `${label} $`, cur: wu[costKey], max: win.cost, isCost: true });
      }
    }
  }

  if (items.length === 0) return null;
  return (
    <div className="flex items-center gap-1 mt-1 flex-wrap">
      {items.map(({ label, cur, max, isCost }) => {
        const pct = cur != null ? Math.min(100, (cur / max) * 100) : null;
        const cls = pct == null
          ? "bg-black/5 dark:bg-white/5 text-text-muted"
          : pct >= 100 ? "bg-red-500/15 text-red-500"
          : pct >= 80  ? "bg-amber-500/15 text-amber-500"
          : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
        const valStr = isCost
          ? `$${cur != null ? cur.toFixed(2) : "—"}/$${max.toFixed(2)}`
          : `${cur != null ? fmtN(cur) : "—"}/${fmtN(max)}`;
        return (
          <span key={label} className={`text-[10px] px-1.5 py-px rounded font-mono whitespace-nowrap ${cls}`}>
            {label} {valStr}
          </span>
        );
      })}
    </div>
  );
}

/** Mask an API key, showing only the last 4 chars. */
function maskKey(k) {
  return k ? `****${k.slice(-4)}` : "";
}

/**
 * Single row in the API Keys list, including the inline limits editor panel.
 *
 * Props passed straight from EndpointPageClient via spread or destructuring:
 *   apiKey            - key object {id, name, key, isActive, createdAt, limits?}
 *   visibleKeys       - Set<string>
 *   toggleKeyVisibility(keyId)
 *   copied            - id of currently-copied item (from useCopyToClipboard)
 *   copy(value, id)
 *   handleToggleKey(keyId, checked)
 *   handleDeleteKey(keyId)
 *   handleUpdateKeyAccess(keyId, access) - save {restricted, allow}
 *   onRequestRestrict() - confirm before turning restriction on
 *   editingLimits     - id of key whose limits panel is open (or null)
 *   keyUsage          - {[keyId]: usageResponse}
 *   limitDraft        - {inputTokens5h, inputTokens24h, cost5h, cost24h}
 *   setLimitDraft
 *   savingLimits
 *   handleOpenLimits(key)
 *   handleSaveLimits(keyId)
 *   setEditingLimits
 */
export default function ApiKeyRow({
  apiKey: key,
  visibleKeys,
  toggleKeyVisibility,
  copied,
  copy,
  handleToggleKey,
  handleDeleteKey,
  handleRenameKey,
  handleUpdateKeyAccess,
  onRequestRestrict,
  editingLimits,
  keyUsage,
  limitDraft,
  setLimitDraft,
  savingLimits,
  handleOpenLimits,
  handleSaveLimits,
  setEditingLimits,
  resetHistory,
  resettingUsage,
  handleResetUsage,
}) {
  const isVisible = visibleKeys.has(key.id);
  const inactive  = key.isActive === false;

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft]     = useState("");
  const nameInputRef = useRef(null);

  useEffect(() => {
    if (editingName && nameInputRef.current) nameInputRef.current.select();
  }, [editingName]);

  const startEditName = () => {
    setNameDraft(key.name);
    setEditingName(true);
  };

  const commitName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== key.name) handleRenameKey(key.id, trimmed);
    setEditingName(false);
  };

  const cancelName = () => setEditingName(false);

  return (
    <div className="flex flex-col border-b border-black/5 dark:border-white/5 last:border-b-0">
      {/* Key row */}
      <div className={`group flex items-center justify-between py-3 ${inactive ? "opacity-60" : ""}`}>

        {/* Left: key info */}
        <div className="flex-1 min-w-0">
          {editingName ? (
            <div className="flex items-center gap-1">
              <input
                ref={nameInputRef}
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitName();
                  if (e.key === "Escape") cancelName();
                }}
                className="text-sm font-medium bg-transparent border-b border-primary outline-none w-40 py-0"
              />
              <button onClick={commitName} className="p-1 text-primary hover:bg-primary/10 rounded" title="Save">
                <span className="material-symbols-outlined text-[14px]">check</span>
              </button>
              <button onClick={cancelName} className="p-1 text-text-muted hover:bg-black/5 dark:hover:bg-white/5 rounded" title="Cancel">
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <p className="text-sm font-medium">{key.name}</p>
              <button
                onClick={startEditName}
                className="p-1 text-text-muted hover:text-primary opacity-0 group-hover:opacity-100 transition-all rounded hover:bg-black/5 dark:hover:bg-white/5"
                title="Rename key"
              >
                <span className="material-symbols-outlined text-[13px]">edit</span>
              </button>
            </div>
          )}
          <div className="flex items-center gap-2 mt-1">
            <code className="text-xs text-text-muted font-mono">
              {isVisible ? key.key : maskKey(key.key)}
            </code>
            <button
              onClick={() => toggleKeyVisibility(key.id)}
              className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary opacity-0 group-hover:opacity-100 transition-all"
              title={isVisible ? "Hide key" : "Show key"}
            >
              <span className="material-symbols-outlined text-[14px]">
                {isVisible ? "visibility_off" : "visibility"}
              </span>
            </button>
            <button
              onClick={() => copy(key.key, key.id)}
              className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary opacity-0 group-hover:opacity-100 transition-all"
            >
              <span className="material-symbols-outlined text-[14px]">
                {copied === key.id ? "check" : "content_copy"}
              </span>
            </button>
          </div>
          <p className="text-xs text-text-muted mt-1">
            Created {new Date(key.createdAt).toLocaleDateString()}
          </p>
          {inactive && <p className="text-xs text-orange-500 mt-1">Paused</p>}
          <CompactQuota limits={key.limits} usageData={keyUsage[key.id]} />
          <KeyAccessControls
            apiKey={key}
            onChange={(access) => handleUpdateKeyAccess(key.id, access)}
            onRequestRestrict={onRequestRestrict}
          />
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-2">
          <Toggle
            size="sm"
            checked={key.isActive ?? true}
            onChange={(checked) => {
              if (key.isActive && !checked) {
                if (confirm(`Pause API key "${key.name}"?\n\nThis key will stop working immediately but can be resumed later.`)) {
                  handleToggleKey(key.id, checked);
                }
              } else {
                handleToggleKey(key.id, checked);
              }
            }}
            title={key.isActive ? "Pause key" : "Resume key"}
          />
          <button
            onClick={() => handleOpenLimits(key)}
            className={`p-2 rounded transition-all ${
              editingLimits === key.id
                ? "bg-primary/10 text-primary"
                : "hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary opacity-0 group-hover:opacity-100"
            }`}
            title="Configure usage limits"
          >
            <span className="material-symbols-outlined text-[18px]">tune</span>
          </button>
          <button
            onClick={() => handleDeleteKey(key.id)}
            className="p-2 hover:bg-red-500/10 rounded text-red-500 opacity-0 group-hover:opacity-100 transition-all"
          >
            <span className="material-symbols-outlined text-[18px]">delete</span>
          </button>
        </div>
      </div>

      {/* Inline limits editor */}
      {editingLimits === key.id && (
        <KeyLimitsEditor
          apiKey={key}
          usageData={keyUsage[key.id]}
          limitDraft={limitDraft}
          setLimitDraft={setLimitDraft}
          saving={savingLimits}
          onSave={() => handleSaveLimits(key.id)}
          onCancel={() => setEditingLimits(null)}
          onResetUsage={(windowMs, windowLabel) => handleResetUsage(key.id, windowMs, windowLabel)}
          resetHistory={resetHistory?.[key.id]}
          resettingUsage={resettingUsage}
        />
      )}
    </div>
  );
}
