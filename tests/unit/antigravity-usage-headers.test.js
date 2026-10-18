import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn(async (url) => ({
  ok: true,
  status: 200,
  json: async () => url.includes(":loadCodeAssist")
    ? { cloudaicompanionProject: "project-1", currentTier: { name: "Pro" }, paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } }
    : url.includes(":retrieveUserQuotaSummary")
      ? { groups: [] }
      : { models: {} },
  text: async () => "{}",
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

describe("Antigravity usage headers", () => {
  beforeEach(() => proxyAwareFetch.mockClear());
  it("uses the official IDE user agent and omits router-only source headers", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    await getAntigravityUsage("access-token", {});

    // loadCodeAssist + fetchAvailableModels + the fork's daily fetchAvailableModels
    // fallback (production reports no gemini-3.8-flash bucket here) + retrieveUserQuotaSummary
    expect(proxyAwareFetch).toHaveBeenCalledTimes(4);
    for (const [url, options] of proxyAwareFetch.mock.calls) {
      expect(options.headers["User-Agent"]).toBe("antigravity/ide/2.22.0 darwin/arm64");
      expect(options.headers).not.toHaveProperty("x-request-source");
      if (String(url).includes(":fetchAvailableModels")) {
        expect(options.headers["X-Client-Version"]).toBe("2.22.0");
      }
    }
  });
});
