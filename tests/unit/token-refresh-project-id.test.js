import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateProviderConnection: vi.fn(async () => ({})),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../../src/lib/localDb.js", () => ({
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("../../src/sse/utils/logger.js", () => ({
  info: mocks.info,
  warn: mocks.warn,
  error: mocks.error,
  debug: mocks.debug,
}));

const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

describe("token refresh project-ID work", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("does not start Antigravity project onboarding after a successful token refresh", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: "fresh-token", expires_in: 3600 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await checkAndRefreshToken("antigravity", {
      id: "antigravity-connection",
      accessToken: "old-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-01-01T00:00:00.000Z",
    }, { force: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
