/**
 * Unit tests for Kiro executor retry logic with exponential backoff.
 *
 * Tests cover:
 *  - 429 triggers retry with exponential backoff
 *  - 400 with "improperly formed request" triggers retry
 *  - 400 with other messages does NOT retry
 *  - Retry count is respected (stops after max)
 *  - kiroRetryCount from credentials overrides default
 *  - 500/502/503/504 trigger retry
 *  - Successful response after retries
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock proxyAwareFetch
const mockFetch = vi.fn();
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => mockFetch(...args)
}));

// Mock uuid
vi.mock("uuid", () => ({
  v4: () => "test-uuid-1234"
}));

// Mock tokenRefresh
vi.mock("open-sse/services/tokenRefresh.js", () => ({
  refreshKiroToken: vi.fn()
}));

import { KiroExecutor } from "../../open-sse/executors/kiro.js";

function createMockResponse(status, body = "") {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers: new Map([["content-type", "application/json"]]),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      }
    }),
    clone() {
      return createMockResponse(status, body);
    },
    text() {
      return Promise.resolve(body);
    }
  };
}

function createSuccessStreamResponse() {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Map([["content-type", "application/vnd.amazon.eventstream"]]),
    body: new ReadableStream({
      start(controller) {
        controller.close();
      }
    }),
    clone() { return createSuccessStreamResponse(); },
    text() { return Promise.resolve(""); }
  };
}

describe("KiroExecutor retry logic", () => {
  let executor;
  let mockLog;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new KiroExecutor();
    // These tests exercise Kiro's own retry-config/backoff/400-classification
    // logic in isolation from BaseExecutor's endpoint fallback (kiro has 3
    // baseUrls; that cross-host failover is a separate upstream concern) and
    // from the integrity gate's own repair-retry fetches (a separate concern
    // covered by its own tests) — an empty mock stream reads as incomplete
    // output and would otherwise trigger extra, unrelated fetch calls here.
    vi.spyOn(executor, "getFallbackCount").mockReturnValue(1);
    vi.spyOn(executor, "attachIntegrityGate").mockImplementation(() => {});
    // Mock _computeBackoff to return 0 for fast tests
    vi.spyOn(executor, "_computeBackoff").mockReturnValue(0);
    mockLog = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
  });

  const baseArgs = {
    model: "claude-sonnet-4.6",
    body: { conversationState: {} },
    stream: true,
    credentials: { accessToken: "test-token" },
    signal: null,
    log: null,
    proxyOptions: null,
    streamWatchdogEnabled: true
  };

  describe("429 retry with exponential backoff", () => {
    it("should retry 429 up to default max (3 times)", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse(429, '{"message":"Too many requests"}')));

      const result = await executor.execute({ ...baseArgs, log: mockLog });

      expect(result.response.status).toBe(429);
      // Initial call + 3 retries = 4 total calls
      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(mockLog.debug).toHaveBeenCalledTimes(3);
      // Verify retry log messages
      expect(mockLog.debug.mock.calls[0][0]).toBe("RETRY");
      expect(mockLog.debug.mock.calls[0][1]).toContain("429 retry 1/3");
    });

    it("should succeed after retry on 429", async () => {
      mockFetch
        .mockImplementationOnce(() => Promise.resolve(createMockResponse(429, '{"message":"Too many requests"}')))
        .mockImplementationOnce(() => Promise.resolve(createSuccessStreamResponse()));

      const result = await executor.execute({ ...baseArgs, log: mockLog });

      expect(result.response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockLog.debug).toHaveBeenCalledTimes(1);
    });
  });

  describe("400 retry for transient patterns", () => {
    it("should retry 400 with 'improperly formed request'", async () => {
      mockFetch
        .mockImplementationOnce(() => Promise.resolve(createMockResponse(400, '{"message":"Improperly formed request.","reason":null}')))
        .mockImplementationOnce(() => Promise.resolve(createSuccessStreamResponse()));

      const result = await executor.execute({ ...baseArgs, log: mockLog });

      expect(result.response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockLog.debug).toHaveBeenCalledTimes(1);
      expect(mockLog.debug.mock.calls[0][1]).toContain("400 retry 1/3");
    });

    it("should NOT retry 400 with other error messages", async () => {
      mockFetch.mockImplementationOnce(() => Promise.resolve(createMockResponse(400, '{"message":"Invalid model specified","reason":"validation"}')));

      const result = await executor.execute({ ...baseArgs, log: mockLog });

      expect(result.response.status).toBe(400);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockLog.debug).not.toHaveBeenCalled();
    });

    it("should NOT retry 400 with empty body", async () => {
      mockFetch.mockImplementationOnce(() => Promise.resolve(createMockResponse(400, "")));

      const result = await executor.execute({ ...baseArgs, log: mockLog });

      expect(result.response.status).toBe(400);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should remap 400 to 429 when retries exhausted on transient error", async () => {
      // All calls return transient 400
      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse(400, '{"message":"Improperly formed request.","reason":null}')));

      const result = await executor.execute({ ...baseArgs, log: mockLog });

      // Should be remapped to 429 for Claude Code CLI compatibility
      expect(result.response.status).toBe(429);
      // Initial call + 3 retries = 4 total calls
      expect(mockFetch).toHaveBeenCalledTimes(4);
      // Last debug log should be the remap message
      const lastCall = mockLog.debug.mock.calls[mockLog.debug.mock.calls.length - 1];
      expect(lastCall[1]).toContain("400 → 429 remap");
    });
  });

  describe("5xx retry", () => {
    it("should retry 500 errors", async () => {
      mockFetch
        .mockImplementationOnce(() => Promise.resolve(createMockResponse(500, '{"message":"Internal server error"}')))
        .mockImplementationOnce(() => Promise.resolve(createSuccessStreamResponse()));

      const result = await executor.execute({ ...baseArgs, log: mockLog });

      expect(result.response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("should retry 502 errors", async () => {
      mockFetch
        .mockImplementationOnce(() => Promise.resolve(createMockResponse(502, "Bad Gateway")))
        .mockImplementationOnce(() => Promise.resolve(createSuccessStreamResponse()));

      const result = await executor.execute({ ...baseArgs, log: mockLog });

      expect(result.response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("should retry 503 errors", async () => {
      mockFetch
        .mockImplementationOnce(() => Promise.resolve(createMockResponse(503, "Service Unavailable")))
        .mockImplementationOnce(() => Promise.resolve(createSuccessStreamResponse()));

      const result = await executor.execute({ ...baseArgs, log: mockLog });

      expect(result.response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("should retry 504 errors", async () => {
      mockFetch
        .mockImplementationOnce(() => Promise.resolve(createMockResponse(504, "Gateway Timeout")))
        .mockImplementationOnce(() => Promise.resolve(createSuccessStreamResponse()));

      const result = await executor.execute({ ...baseArgs, log: mockLog });

      expect(result.response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("configurable retry count", () => {
    it("should use kiroRetryCount from credentials", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse(429, '{"message":"Too many requests"}')));

      const result = await executor.execute({
        ...baseArgs,
        credentials: { accessToken: "test-token", kiroRetryCount: 5 },
        log: mockLog
      });

      expect(result.response.status).toBe(429);
      // Initial call + 5 retries = 6 total calls
      expect(mockFetch).toHaveBeenCalledTimes(6);
      expect(mockLog.debug).toHaveBeenCalledTimes(5);
      expect(mockLog.debug.mock.calls[4][1]).toContain("retry 5/5");
    });

    it("should respect kiroRetryCount of 0 (no retries)", async () => {
      mockFetch.mockImplementationOnce(() => Promise.resolve(createMockResponse(429, '{"message":"Too many requests"}')));

      const result = await executor.execute({
        ...baseArgs,
        credentials: { accessToken: "test-token", kiroRetryCount: 0 },
        log: mockLog
      });

      expect(result.response.status).toBe(429);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockLog.debug).not.toHaveBeenCalled();
    });

    it("should use kiroRetryCount of 1 for single retry", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse(503, "Service Unavailable")));

      const result = await executor.execute({
        ...baseArgs,
        credentials: { accessToken: "test-token", kiroRetryCount: 1 },
        log: mockLog
      });

      expect(result.response.status).toBe(503);
      // Initial call + 1 retry = 2 total calls
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("non-retryable errors", () => {
    it("should NOT retry 401 errors", async () => {
      mockFetch.mockImplementationOnce(() => Promise.resolve(createMockResponse(401, '{"message":"Unauthorized"}')));

      const result = await executor.execute({ ...baseArgs, log: mockLog });

      expect(result.response.status).toBe(401);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should NOT retry 403 errors", async () => {
      mockFetch.mockImplementationOnce(() => Promise.resolve(createMockResponse(403, '{"message":"Forbidden"}')));

      const result = await executor.execute({ ...baseArgs, log: mockLog });

      expect(result.response.status).toBe(403);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should NOT retry 404 errors", async () => {
      mockFetch.mockImplementationOnce(() => Promise.resolve(createMockResponse(404, '{"message":"Not found"}')));

      const result = await executor.execute({ ...baseArgs, log: mockLog });

      expect(result.response.status).toBe(404);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("_isRetryable400", () => {
    it("should match 'improperly formed request' case-insensitively", () => {
      expect(executor._isRetryable400('{"message":"Improperly formed request.","reason":null}')).toBe(true);
      expect(executor._isRetryable400('{"message":"IMPROPERLY FORMED REQUEST"}')).toBe(true);
      expect(executor._isRetryable400("improperly formed request")).toBe(true);
    });

    it("should not match other error messages", () => {
      expect(executor._isRetryable400('{"message":"Invalid model"}')).toBe(false);
      expect(executor._isRetryable400('{"message":"Missing required field"}')).toBe(false);
      expect(executor._isRetryable400("")).toBe(false);
      expect(executor._isRetryable400(null)).toBe(false);
    });
  });

  describe("_computeBackoff", () => {
    beforeEach(() => {
      // Restore real implementation for these tests
      executor._computeBackoff.mockRestore();
    });

    it("should return values within expected range", () => {
      // attempt 1: base/2 + random(0, min(cap, base*2^0)) = 1000 + random(0, 2000) = [1000, 3000]
      for (let i = 0; i < 20; i++) {
        const val = executor._computeBackoff(1);
        expect(val).toBeGreaterThanOrEqual(1000);
        expect(val).toBeLessThanOrEqual(3000);
      }
    });

    it("should increase with attempt number", () => {
      const samples1 = Array.from({ length: 50 }, () => executor._computeBackoff(1));
      const samples3 = Array.from({ length: 50 }, () => executor._computeBackoff(3));
      const avg1 = samples1.reduce((a, b) => a + b, 0) / samples1.length;
      const avg3 = samples3.reduce((a, b) => a + b, 0) / samples3.length;
      expect(avg3).toBeGreaterThan(avg1);
    });

    it("should be capped at BACKOFF_CAP + BASE/2", () => {
      // At high attempts, ceiling is 15000, so max = 15000 + 1000 = 16000
      for (let i = 0; i < 50; i++) {
        const val = executor._computeBackoff(10);
        expect(val).toBeLessThanOrEqual(16000);
      }
    });
  });
});
