import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveRequestUsage: vi.fn(() => Promise.resolve()),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: mocks.saveRequestUsage,
  appendRequestLog: mocks.appendRequestLog,
  saveRequestDetail: mocks.saveRequestDetail,
}));

describe("ClinePass non-streaming response envelope", () => {
  it("unwraps successful data.choices envelopes before returning to OpenAI clients", async () => {
    const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");

    const providerResponse = new Response(JSON.stringify({
      data: {
        id: "gen_123",
        object: "chat.completion",
        created: 123,
        model: "zai/glm-5.2",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      success: true,
      object: "chat.completion",
      created: 123,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const result = await handleNonStreamingResponse({
      providerResponse,
      provider: "clinepass",
      model: "cline-pass/glm-5.2",
      sourceFormat: "openai",
      targetFormat: "openai",
      body: { model: "clinepass/cline-pass/glm-5.2", messages: [], stream: false },
      stream: false,
      translatedBody: null,
      finalBody: null,
      requestStartTime: Date.now(),
      connectionId: "conn-clinepass",
      apiKey: null,
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      onRequestSuccess: null,
      reqLogger: {
        logProviderResponse: vi.fn(),
        logConvertedResponse: vi.fn(),
      },
      toolNameMap: null,
      trackDone: vi.fn(),
      appendLog: vi.fn(),
    });

    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(body).toMatchObject({
      id: "gen_123",
      object: "chat.completion",
      model: "zai/glm-5.2",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      }],
    });
    expect(body.data).toBeUndefined();
  });
});
