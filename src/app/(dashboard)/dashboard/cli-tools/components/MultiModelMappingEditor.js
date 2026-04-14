"use client";

import { Select } from "@/shared/components";
import {
  DEFAULT_MITM_ALIAS_STRATEGY,
  MAX_MITM_ALIAS_MODELS,
} from "./mitmMappingState";

const STRATEGY_OPTIONS = [
  { value: "round-robin", label: "Round-Robin" },
  { value: "fallback", label: "Fallback" },
];

export default function MultiModelMappingEditor({
  tool,
  mappings,
  strategy = DEFAULT_MITM_ALIAS_STRATEGY,
  dnsActive = true,
  hasActiveProviders,
  onChangeEntry,
  onBlurEntry,
  onOpenSelector,
  onAddEntry,
  onRemoveEntry,
  onReorderEntry,
  onChangeStrategy,
  feedback,
  compact = false,
}) {
  const rowLabelClass = compact
    ? "w-32 shrink-0 text-sm font-semibold text-text-main text-right"
    : "w-36 shrink-0 text-xs font-semibold text-text-main text-right";
  const inputClass = compact
    ? "flex-1 px-2 py-1.5 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
    : "flex-1 px-2 py-1.5 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50";
  const buttonClass = compact
    ? "px-2 py-1.5 rounded border text-xs transition-colors shrink-0 whitespace-nowrap"
    : "px-2 py-1.5 rounded border text-xs transition-colors shrink-0";
  const disabled = !dnsActive;

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-border/70 bg-surface/60 p-3">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold text-text-main">Routing strategy</p>
            <p className="text-[11px] text-text-muted">Round-robin spreads load. Fallback keeps priority order.</p>
            <p className="text-[10px] text-text-muted mt-1">Tip: paste comma-separated models into one row to expand multiple targets at once.</p>
          </div>
          <div className="sm:w-44">
            <Select
              value={strategy}
              onChange={(event) => onChangeStrategy(event.target.value)}
              disabled={disabled}
              options={STRATEGY_OPTIONS}
              selectClassName="py-1.5 px-2 pr-8 text-xs bg-surface border-border"
              aria-label={`${tool.name} MITM strategy`}
            />
          </div>
        </div>
      </div>

      {feedback && (
        <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] text-text-muted">
          {feedback}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {tool.defaultModels?.map((model) => {
          const entries = Array.isArray(mappings?.[model.alias]) ? mappings[model.alias] : [];
          const canAdd = dnsActive && entries.length < MAX_MITM_ALIAS_MODELS;

          return (
            <div key={model.alias} className="rounded-xl border border-border/70 bg-surface/40 p-3">
              <div className="flex items-start gap-3">
                <div className={rowLabelClass}>
                  <div className="flex flex-col gap-1">
                    <span>{model.name}</span>
                    <span className="text-[10px] font-normal text-text-muted">Max {MAX_MITM_ALIAS_MODELS} targets</span>
                  </div>
                </div>

                <div className="flex-1 flex flex-col gap-2">
                  {entries.length > 0 ? entries.map((value, index) => {
                    const moveUpDisabled = disabled || index === 0;
                    const moveDownDisabled = disabled || index === entries.length - 1;

                    return (
                      <div key={`${model.alias}-${index}`} className="flex items-center gap-2">
                        <span className="w-6 text-center text-[11px] font-semibold text-text-muted">{index + 1}</span>
                        <span className="material-symbols-outlined text-text-muted text-[14px]">arrow_forward</span>
                        <input
                          type="text"
                          value={value}
                          onChange={(event) => onChangeEntry(model.alias, index, event.target.value)}
                          onBlur={(event) => onBlurEntry(model.alias, index, event.target.value)}
                          placeholder="provider/model-id"
                          disabled={disabled}
                          className={`${inputClass} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                        />
                        <button
                          type="button"
                          onClick={() => onReorderEntry(model.alias, index, index - 1)}
                          disabled={moveUpDisabled}
                          className={`p-1 rounded border border-border text-text-muted transition-colors ${moveUpDisabled ? "opacity-40 cursor-not-allowed" : "hover:border-primary hover:text-primary cursor-pointer"}`}
                          title="Move up"
                        >
                          <span className="material-symbols-outlined text-[14px]">keyboard_arrow_up</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onReorderEntry(model.alias, index, index + 1)}
                          disabled={moveDownDisabled}
                          className={`p-1 rounded border border-border text-text-muted transition-colors ${moveDownDisabled ? "opacity-40 cursor-not-allowed" : "hover:border-primary hover:text-primary cursor-pointer"}`}
                          title="Move down"
                        >
                          <span className="material-symbols-outlined text-[14px]">keyboard_arrow_down</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onRemoveEntry(model.alias, index)}
                          disabled={disabled}
                          className={`p-1 rounded border border-border text-text-muted transition-colors ${disabled ? "opacity-40 cursor-not-allowed" : "hover:border-red-500 hover:text-red-500 cursor-pointer"}`}
                          title="Remove"
                        >
                          <span className="material-symbols-outlined text-[14px]">close</span>
                        </button>
                      </div>
                    );
                  }) : (
                    <div className="rounded-lg border border-dashed border-border px-3 py-2 text-[11px] text-text-muted">
                      No mapping — passthrough
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2 pl-8">
                    <button
                      type="button"
                      onClick={() => onAddEntry(model.alias)}
                      disabled={!canAdd}
                      className={`${buttonClass} ${canAdd ? "bg-surface border-border text-text-main hover:border-primary cursor-pointer" : "opacity-50 cursor-not-allowed border-border"}`}
                    >
                      + Add
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenSelector(model.alias)}
                      disabled={!hasActiveProviders || disabled || entries.length >= MAX_MITM_ALIAS_MODELS}
                      className={`${buttonClass} ${hasActiveProviders && !disabled && entries.length < MAX_MITM_ALIAS_MODELS ? "bg-surface border-border hover:border-primary cursor-pointer" : "opacity-50 cursor-not-allowed border-border"}`}
                    >
                      Select
                    </button>
                    <span className="text-[10px] text-text-muted">
                      {entries.length}/{MAX_MITM_ALIAS_MODELS} mapped
                    </span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
