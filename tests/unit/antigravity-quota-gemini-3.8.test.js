import { describe, expect, it, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn(async (url) => ({
  ok: true,
  status: 200,
  json: async () => url.includes(":loadCodeAssist")
    ? { cloudaicompanionProject: "project-1", currentTier: { name: "Pro" } }
    : url.includes("daily-cloudcode")
    ? {
        models: {
          "gemini-3.8-flash": {
            displayName: "Gemini 3.8 Flash",
            quotaInfo: {
              remainingFraction: 0.75,
              resetTime: "2026-09-04T12:00:00Z",
            },
          },
        },
      }
    : { models: {} },
  text: async () => "{}",
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

describe("Antigravity quota tracker: Gemini 3.8 Flash usage", () => {
  beforeEach(() => proxyAwareFetch.mockClear());

  it("returns the unsuffixed Gemini 3.8 Flash quota bucket", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-3.8-flash"]).toMatchObject({
      used: 250,
      total: 1000,
      remainingPercentage: 75,
      displayName: "Gemini 3.8 Flash",
    });
  });
});
