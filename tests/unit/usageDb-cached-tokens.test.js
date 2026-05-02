import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("@/lib/localDb.js", () => ({
  getApiKeys: vi.fn(async () => []),
  getProviderConnections: vi.fn(async () => []),
  getProviderNodes: vi.fn(async () => []),
  getPricingForModel: vi.fn(async () => null),
}));

describe("usageDb cached token stats", () => {
  let tempDir;

  beforeEach(() => {
    vi.resetModules();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "n9router-usage-"));
    process.env.DATA_DIR = tempDir;
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("includes cached tokens in live and daily usage stats", async () => {
    const { saveRequestUsage, getUsageStats } = await import("@/lib/usageDb.js");

    await saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      tokens: { prompt_tokens: 1000, completion_tokens: 200, cache_read_input_tokens: 300 },
      timestamp: new Date().toISOString(),
      endpoint: "/v1/chat/completions",
    });
    await saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      tokens: { prompt_tokens: 500, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 125 } },
      timestamp: new Date().toISOString(),
      endpoint: "/v1/chat/completions",
    });

    const dailyStats = await getUsageStats("7d");
    expect(dailyStats.totalRequests).toBe(2);
    expect(dailyStats.totalCachedTokens).toBe(425);
    expect(dailyStats.byProvider.openai.cachedTokens).toBe(425);
    expect(dailyStats.byModel["gpt-4 (openai)"].cachedTokens).toBe(425);

    const liveStats = await getUsageStats("24h");
    expect(liveStats.totalRequests).toBe(2);
    expect(liveStats.totalCachedTokens).toBe(425);
    expect(liveStats.byEndpoint["/v1/chat/completions|gpt-4|openai"].cachedTokens).toBe(425);
  });

  it("filters total requests by the selected usage period", async () => {
    const { saveRequestUsage, getUsageStats } = await import("@/lib/usageDb.js");
    const now = Date.now();

    await saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      tokens: { prompt_tokens: 100, completion_tokens: 20 },
      timestamp: new Date(now).toISOString(),
    });
    await saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      tokens: { prompt_tokens: 100, completion_tokens: 20 },
      timestamp: new Date(now - 2 * 86400000).toISOString(),
    });
    await saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      tokens: { prompt_tokens: 100, completion_tokens: 20 },
      timestamp: new Date(now - 10 * 86400000).toISOString(),
    });

    expect((await getUsageStats("24h")).totalRequests).toBe(1);
    expect((await getUsageStats("7d")).totalRequests).toBe(2);
    expect((await getUsageStats("30d")).totalRequests).toBe(3);
    expect((await getUsageStats("all")).totalRequests).toBe(3);
  });

  it("backfills cached tokens into existing daily summaries", async () => {
    const today = new Date();
    const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "usage.json"), JSON.stringify({
      history: [{
        provider: "anthropic",
        model: "claude",
        timestamp: today.toISOString(),
        tokens: { prompt_tokens: 2000, completion_tokens: 400, cached_tokens: 700 },
        cost: 0,
      }],
      totalRequestsLifetime: 1,
      dailySummary: {
        [dateKey]: {
          requests: 1,
          promptTokens: 2000,
          completionTokens: 400,
          cost: 0,
          byProvider: { anthropic: { requests: 1, promptTokens: 2000, completionTokens: 400, cost: 0 } },
          byModel: { "claude|anthropic": { requests: 1, promptTokens: 2000, completionTokens: 400, cost: 0, rawModel: "claude", provider: "anthropic" } },
          byAccount: {},
          byApiKey: { "local-no-key|claude|anthropic": { requests: 1, promptTokens: 2000, completionTokens: 400, cost: 0, rawModel: "claude", provider: "anthropic", apiKey: null } },
          byEndpoint: { "Unknown|claude|anthropic": { requests: 1, promptTokens: 2000, completionTokens: 400, cost: 0, endpoint: "Unknown", rawModel: "claude", provider: "anthropic" } },
        },
      },
    }));

    const { getUsageStats } = await import("@/lib/usageDb.js");
    const stats = await getUsageStats("7d");

    expect(stats.totalCachedTokens).toBe(700);
    expect(stats.byProvider.anthropic.cachedTokens).toBe(700);
    expect(stats.byModel["claude (anthropic)"].cachedTokens).toBe(700);
  });
});
