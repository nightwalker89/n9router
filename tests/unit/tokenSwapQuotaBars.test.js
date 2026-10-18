import { describe, it, expect } from "vitest";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { pickQuotaFamilyBars } from "@/app/(dashboard)/dashboard/cli-tools/components/tokenSwapQuotaBars.js";

const quota = (remainingPercentage, resetAt, displayName) => ({
  used: 1000 - remainingPercentage * 10,
  total: 1000,
  remainingPercentage,
  resetAt,
  displayName,
});

const summarize = (bars) => bars.map(({ family, rows }) => ({
  family,
  rows: rows.map(({ window, quota: q }) => [window, q?.modelKey ?? null, q?.remainingPercentage ?? null]),
}));

describe("pickQuotaFamilyBars", () => {
  it("maps Antigravity summary buckets to Claude/Gemini 5h + weekly rows", () => {
    const parsed = parseQuotaData("antigravity", {
      quotas: {
        gemini_session: quota(100, "2026-10-19T02:33:00Z", "Gemini (5h)"),
        gemini_weekly: quota(80, "2026-10-25T02:33:00Z", "Gemini (Weekly)"),
        claude_gpt_session: quota(40, "2026-10-19T02:33:00Z", "Claude & GPT (5h)"),
        claude_gpt_weekly: quota(10, "2026-10-25T02:33:00Z", "Claude & GPT (Weekly)"),
        "gemini-3.1-flash-image": quota(100, "2026-10-19T02:33:00Z", "Gemini 3.1 Flash Image"),
      },
    });

    expect(summarize(pickQuotaFamilyBars(parsed))).toEqual([
      { family: "Claude", rows: [["5h", "claude_gpt_session", 40], ["Wk", "claude_gpt_weekly", 10]] },
      { family: "Gemini", rows: [["5h", "gemini_session", 100], ["Wk", "gemini_weekly", 80]] },
    ]);
  });

  it("falls back to per-model family rows when 5h summaries are missing", () => {
    const parsed = parseQuotaData("antigravity", {
      quotas: {
        "claude-sonnet-4-6": quota(60, "2026-10-19T02:33:00Z"),
        "claude-opus-4-6-thinking": quota(30, "2026-10-19T02:33:00Z"),
        "gemini-3-flash": quota(90, "2026-10-19T02:33:00Z"),
      },
    });

    expect(summarize(pickQuotaFamilyBars(parsed))).toEqual([
      { family: "Claude", rows: [["5h", "claude", 30], ["Wk", null, null]] },
      { family: "Gemini", rows: [["5h", "gemini", 90], ["Wk", null, null]] },
    ]);
  });

  it("returns empty rows for both families when no quotas exist", () => {
    expect(summarize(pickQuotaFamilyBars([]))).toEqual([
      { family: "Claude", rows: [["5h", null, null], ["Wk", null, null]] },
      { family: "Gemini", rows: [["5h", null, null], ["Wk", null, null]] },
    ]);
  });
});
