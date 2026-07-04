import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  testProxyUrl: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("@/lib/network/proxyTest", () => ({
  testProxyUrl: mocks.testProxyUrl,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

const originalFetch = global.fetch;

describe("ClinePass provider test route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({ connectionProxyEnabled: false });
    mocks.updateProviderConnection.mockResolvedValue(undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("validates ClinePass OAuth connections with Cline auth headers", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-clinepass-oauth",
      provider: "clinepass",
      authType: "oauth",
      accessToken: "oauth-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      providerSpecificData: {},
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "user" }), { status: 200 }));
    global.fetch = fetchMock;

    const { POST } = await import("../../src/app/api/providers/[id]/test/route.js");
    const res = await POST(new Request("http://localhost/api/providers/conn-clinepass-oauth/test", { method: "POST" }), {
      params: Promise.resolve({ id: "conn-clinepass-oauth" }),
    });
    const body = await res.json();

    expect(body.valid).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cline.bot/api/v1/users/me",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer workos:oauth-token",
          "X-CLIENT-TYPE": "9router",
        }),
      }),
    );
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      "conn-clinepass-oauth",
      expect.objectContaining({ testStatus: "active", lastError: null }),
    );
  });

  it("validates ClinePass API-key connections against the Cline models endpoint", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-clinepass-key",
      provider: "clinepass",
      authType: "apikey",
      apiKey: "cp-key",
      providerSpecificData: {},
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    global.fetch = fetchMock;

    const { POST } = await import("../../src/app/api/providers/[id]/test/route.js");
    const res = await POST(new Request("http://localhost/api/providers/conn-clinepass-key/test", { method: "POST" }), {
      params: Promise.resolve({ id: "conn-clinepass-key" }),
    });
    const body = await res.json();

    expect(body.valid).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cline.bot/api/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: "Bearer cp-key",
        }),
      }),
    );
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      "conn-clinepass-key",
      expect.objectContaining({ testStatus: "active", lastError: null }),
    );
  });
});
