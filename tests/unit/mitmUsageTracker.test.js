import { describe, it, expect, afterEach, vi } from "vitest";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const trackerPath = path.resolve("../src/mitm/usageTracker.js");

function loadTracker() {
  delete require.cache[require.resolve(trackerPath)];
  return require(trackerPath);
}

describe("MITM usage tracker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
  });

  it("persists token-swap usage with model detected from Antigravity response when request model is missing", async () => {
    const posts = [];
    global.fetch = vi.fn(async (url, options) => {
      posts.push({ url: String(url), body: JSON.parse(options.body) });
      return { ok: true, status: 200, text: async () => "" };
    });

    const { createTokenSwapUsageObserver } = loadTracker();
    const observer = createTokenSwapUsageObserver({
      provider: "antigravity",
      model: null,
      connectionId: "conn-1",
      accountLabel: "Account",
      bodyBuffer: Buffer.from(JSON.stringify({
        userAgent: "antigravity",
        request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      })),
      contentType: "text/event-stream",
      contentEncoding: "",
      statusCode: 200,
      detailRecord: { id: "detail-1", provider: "antigravity", model: "unknown" },
      requestStartTime: Date.now(),
    });

    observer.onChunk(Buffer.from(
      'data: {"response":{"modelVersion":"claude-sonnet-4-6","usageMetadata":{"promptTokenCount":140222,"candidatesTokenCount":291},"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n',
    ));
    await observer.onEnd();

    const usagePost = posts.find((post) => post.url.includes("/api/internal/usage"));
    const detailPost = posts.find((post) => post.url.includes("/api/internal/request-detail"));
    expect(usagePost.body.model).toBe("claude-sonnet-4-6");
    expect(usagePost.body.tokens.prompt_tokens).toBe(140222);
    expect(usagePost.body.tokens.completion_tokens).toBe(291);
    expect(detailPost.body.model).toBe("claude-sonnet-4-6");
  });
});
