import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grokTlsFetch } from "open-sse/services/grokTlsClient.js";
import { fetchWebIdentity } from "open-sse/services/webIdentity.js";
import { GrokWebExecutor } from "open-sse/executors/grok-web.js";

vi.mock("open-sse/services/grokTlsClient.js", () => ({
  grokTlsFetch: vi.fn(),
  GROK_TLS_USER_AGENT: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  GrokTlsUnavailableError: class extends Error {},
  isCloudflareChallenge: (text) => typeof text === "string" && /just a moment|attention required|cf-mitigated/i.test(text),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => {
    throw new Error("Node fetch fallback must not be called for grok-web");
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWebIdentity grok-web probe", () => {
  it("returns unknown (not invalid) when Cloudflare returns a 403 challenge page", async () => {
    grokTlsFetch.mockResolvedValueOnce({
      status: 403,
      ok: false,
      headers: new Headers({ "content-type": "text/html; charset=UTF-8" }),
      text: async () => "<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>",
    });

    const result = await fetchWebIdentity("grok-web", "sso=test-sso; sso-rw=test-rw");

    expect(result.status).toBe("unknown");
    expect(result.error).toMatch(/Cloudflare challenge/i);
  });

  it("returns unknown when Cloudflare sets cf-mitigated: challenge header on 403", async () => {
    grokTlsFetch.mockResolvedValueOnce({
      status: 403,
      ok: false,
      headers: new Headers({ "cf-mitigated": "challenge" }),
      text: async () => "",
    });

    const result = await fetchWebIdentity("grok-web", "sso=test-sso");

    expect(result.status).toBe("unknown");
    expect(result.error).toMatch(/Cloudflare challenge/i);
  });

  it("returns unknown without falling back to Node fetch when grokTlsFetch throws", async () => {
    grokTlsFetch.mockRejectedValueOnce(new Error("wreq-js missing"));

    const result = await fetchWebIdentity("grok-web", "sso=test-sso");

    expect(result.status).toBe("unknown");
    expect(result.error).toContain("wreq-js missing");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns invalid on non-Cloudflare 401/403 auth rejection", async () => {
    grokTlsFetch.mockResolvedValueOnce({
      status: 401,
      ok: false,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ error: "unauthorized" }),
    });

    const result = await fetchWebIdentity("grok-web", "sso=expired-sso");

    expect(result).toEqual({
      ok: false,
      status: "invalid",
      email: "",
      error: "sso cookie is invalid or expired",
    });
  });

  it("returns valid + email when Grok returns authenticated session JSON and normalizes JSON cookie dumps", async () => {
    grokTlsFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({
        status: "authenticated",
        session: { email: "grok@example.com" },
      }),
    });

    const jsonJar = JSON.stringify([
      { name: "sso", value: "tok-1" },
      { name: "sso-rw", value: "rw-1" },
    ]);
    const result = await fetchWebIdentity("grok-web", jsonJar);

    expect(result).toEqual({
      ok: true,
      status: "valid",
      email: "grok@example.com",
    });
    expect(grokTlsFetch).toHaveBeenCalledTimes(1);
    const [, options] = grokTlsFetch.mock.calls[0];
    expect(options.headers.Cookie).toBe("sso=tok-1; sso-rw=rw-1");
    expect(options.headers["Sec-Fetch-Mode"]).toBe("cors");
  });

  it("returns invalid when sso cookie is missing", async () => {
    const result = await fetchWebIdentity("grok-web", "other=1; another=2");

    expect(result.status).toBe("invalid");
    expect(result.error).toBe("Missing sso cookie");
    expect(grokTlsFetch).not.toHaveBeenCalled();
  });

  it("uses override userAgent and matching Sec-Ch-Ua version when provided", async () => {
    grokTlsFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ status: "authenticated", session: { email: "a@b.com" } }),
    });

    const customUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36";
    const result = await fetchWebIdentity("grok-web", "sso=tok", { userAgent: customUa });

    expect(result.status).toBe("valid");
    const [, options] = grokTlsFetch.mock.calls[0];
    expect(options.headers["User-Agent"]).toBe(customUa);
    expect(options.headers["Sec-Ch-Ua"]).toContain('v="158"');
  });

  it("passes stored providerSpecificData.userAgent and matching Sec-Ch-Ua in GrokWebExecutor.generateMedia", async () => {
    const storedUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
    const videoLine = JSON.stringify({ result: { response: { videoUrl: "users/u1/v1.mp4" } } });
    grokTlsFetch
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: async () => videoLine,
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });

    const out = await new GrokWebExecutor().generateMedia({
      prompt: "test clip",
      kind: "video",
      credentials: {
        apiKey: "sso=tok; sso-rw=rw; cf_clearance=cf1",
        providerSpecificData: { userAgent: storedUa },
      },
    });

    expect(out).toHaveLength(1);
    expect(out[0].mime).toBe("video/mp4");
    const [, postOpts] = grokTlsFetch.mock.calls[0];
    expect(postOpts.headers["User-Agent"]).toBe(storedUa);
    expect(postOpts.headers["Sec-Ch-Ua"]).toContain('v="157"');
    expect(postOpts.headers.Cookie).toBe("sso=tok; sso-rw=rw; cf_clearance=cf1");
    const [, dlOpts] = grokTlsFetch.mock.calls[1];
    expect(dlOpts.headers["User-Agent"]).toBe(storedUa);
  });
});
