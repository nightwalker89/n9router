"use client";

import PropTypes from "prop-types";

const PROMO_URL = "https://agentkit.best/?ref=RCRJ2I8M";

export default function AgentKitPromo({
  variant = "sidebar",
  onClick,
  className = "",
}) {
  if (variant === "header") {
    return (
      <a
        href={PROMO_URL}
        target="_blank"
        rel="nofollow noopener"
        onClick={onClick}
        className={`relative overflow-hidden inline-flex items-center gap-1.5 px-2 sm:px-2.5 h-8 rounded-lg bg-gradient-to-r from-emerald-500 via-teal-600 to-emerald-600 hover:from-emerald-600 hover:to-teal-700 text-white transition-all duration-300 text-xs font-medium shadow-xs hover:shadow-[0_4px_16px_rgba(16,185,129,0.35)] hover:scale-[1.03] group shrink-0 border border-emerald-400/30 hover:border-emerald-300/60 ${className}`}
        title="Get 20% Off AgentKit - AI Agent Bundles"
        style={{ textDecoration: "none" }}
      >
        {/* Shimmer gleam light sweep */}
        <div className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-1000 ease-out bg-gradient-to-r from-transparent via-white/30 to-transparent pointer-events-none" />

        <span className="flex items-center justify-center size-4 rounded-full bg-white/20 text-[10px] font-bold shrink-0 transition-transform duration-300 group-hover:rotate-12 group-hover:scale-110">
          %
        </span>
        <span className="hidden md:inline font-semibold tracking-tight">
          AgentKit <span className="text-[11px] font-normal text-white/80">(was ClaudeKit)</span>
        </span>
        <span className="px-1.5 py-0.5 rounded bg-white/20 group-hover:bg-white group-hover:text-emerald-800 text-[9px] font-bold uppercase tracking-wider leading-none transition-all duration-300">
          20% OFF
        </span>
        <svg
          className="size-3 text-white/80 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 hidden sm:inline"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M7 7h10v10" />
          <path d="M7 17 17 7" />
        </svg>
      </a>
    );
  }

  // default: "sidebar"
  return (
    <div className={`p-3 border-t border-border-subtle shrink-0 ${className}`}>
      <a
        href={PROMO_URL}
        target="_blank"
        rel="nofollow noopener"
        onClick={onClick}
        className="group relative overflow-hidden flex items-center gap-2.5 p-2 rounded-xl bg-gradient-to-br from-emerald-600/95 via-teal-700/95 to-emerald-800/95 hover:from-emerald-500 hover:via-teal-600 hover:to-emerald-700 border border-emerald-400/30 hover:border-emerald-300/70 text-white shadow-xs hover:shadow-[0_8px_25px_-4px_rgba(16,185,129,0.45),0_0_15px_rgba(52,211,153,0.3)] hover:scale-[1.02] hover:-translate-y-0.5 transition-all duration-300 ease-out w-full"
        style={{ textDecoration: "none" }}
      >
        {/* Ambient radial blur glow on hover */}
        <div className="absolute -top-8 -right-8 size-20 rounded-full bg-emerald-300/20 blur-xl group-hover:scale-150 group-hover:bg-emerald-300/35 transition-all duration-500 pointer-events-none" />

        {/* Shimmer light sweep beam */}
        <div className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-1000 ease-out bg-gradient-to-r from-transparent via-white/25 to-transparent pointer-events-none" />

        {/* Icon with spin/tilt & pop effect */}
        <div className="relative shrink-0 flex items-center justify-center size-7 rounded-lg bg-white/15 group-hover:bg-white/25 group-hover:shadow-[0_0_12px_rgba(255,255,255,0.4)] group-hover:rotate-12 group-hover:scale-110 transition-all duration-300">
          <svg
            className="size-3.5 text-white transition-transform duration-300 group-hover:scale-105"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="19" x2="5" y1="5" y2="19" />
            <circle cx="6.5" cy="6.5" r="2.5" />
            <circle cx="17.5" cy="17.5" r="2.5" />
          </svg>
        </div>

        {/* Text area with smooth slide-up reveal */}
        <div className="flex-1 min-w-0 z-10">
          <div className="flex items-center justify-between gap-1.5">
            <span className="text-xs font-semibold leading-tight truncate min-w-0">
              AgentKit <span className="text-[10px] font-normal text-white/80">(was ClaudeKit)</span>
            </span>
            <span className="shrink-0 whitespace-nowrap px-1.5 py-0.5 rounded bg-white/20 group-hover:bg-white group-hover:text-emerald-900 group-hover:shadow-xs text-[8.5px] font-bold uppercase tracking-wide transition-all duration-300">
              20% OFF
            </span>
          </div>

          {/* Dual-line flip: Default subtext slides up, magical CTA slides in */}
          <div className="relative h-[14px] overflow-hidden mt-0.5">
            <p className="text-[10px] text-white/70 leading-tight truncate transition-all duration-300 ease-out transform group-hover:-translate-y-full group-hover:opacity-0">
              AI agent starter bundle
            </p>
            <p className="text-[10px] text-emerald-100 font-medium leading-tight truncate absolute inset-0 transition-all duration-300 ease-out transform translate-y-full opacity-0 group-hover:translate-y-0 group-hover:opacity-100 flex items-center gap-1">
              <span>Claim discount</span>
              <span className="inline-block animate-pulse">✨</span>
            </p>
          </div>
        </div>
      </a>
    </div>
  );
}

AgentKitPromo.propTypes = {
  variant: PropTypes.oneOf(["header", "sidebar"]),
  onClick: PropTypes.func,
  className: PropTypes.string,
};
