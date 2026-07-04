const originalFetch = globalThis.fetch;
let mockFetchFn = null;
globalThis.fetch = (...args) => {
  if (mockFetchFn) return mockFetchFn(...args);
  return originalFetch(...args);
};

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => mockFetchFn(...args),
}));

describe("Antigravity Usage & Quota Parsing", () => {
  beforeEach(() => {
    mockFetchFn = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockFetchFn = null;
  });

  describe("getAntigravitySubscriptionInfo", () => {
    it("should resolve Paid Tier with highest priority", async () => {
      mockFetchFn = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          cloudaicompanionProject: "mock-project-123",
          paidTier: { name: "Google One AI Premium" },
          currentTier: { name: "Antigravity Free" },
          allowedTiers: [{ id: "free-tier", isDefault: true }]
        }),
      });

      const usageModule = await import("../../open-sse/services/usage.js");
      const info = await usageModule.getUsageForProvider({
        provider: "antigravity",
        accessToken: "test-token"
      });

      expect(info.plan).toBe("Google One AI Premium");
    });

    it("should fallback to allowedTiers restricted badge if ineligible", async () => {
      mockFetchFn = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          cloudaicompanionProject: "mock-project-123",
          currentTier: { name: "Antigravity Free" },
          ineligibleTiers: [{ reasonCode: "BLOCKED" }],
          allowedTiers: [{ name: "Limited Plan", isDefault: true }]
        }),
      });

      const usageModule = await import("../../open-sse/services/usage.js");
      const info = await usageModule.getUsageForProvider({
        provider: "antigravity",
        accessToken: "test-token"
      });

      expect(info.plan).toBe("Limited Plan (Restricted)");
    });

    it("should resolve Plus Tier correctly", async () => {
      mockFetchFn = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          cloudaicompanionProject: "mock-project-123",
          paidTier: { name: "Google One AI Plus" },
          currentTier: { name: "Antigravity Free" },
          allowedTiers: [{ id: "free-tier", isDefault: true }]
        }),
      });

      const usageModule = await import("../../open-sse/services/usage.js");
      const info = await usageModule.getUsageForProvider({
        provider: "antigravity",
        accessToken: "test-token"
      });

      expect(info.plan).toBe("Google One AI Plus");
      const { inferAntigravityAccountType } = await import("../../src/lib/antigravity/accountType");
      expect(inferAntigravityAccountType(info)).toBe("Plus");
    });
  });

  describe("getAntigravityUsage", () => {
    it("should retry without project ID on 403 Forbidden with project", async () => {
      let callCount = 0;
      mockFetchFn = vi.fn().mockImplementation((url, options) => {
        callCount++;
        const body = options?.body ? JSON.parse(options.body) : {};
        if (callCount === 1) {
          // loadCodeAssist mock response
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              cloudaicompanionProject: "mock-project-123",
              paidTier: { name: "Google One AI Premium" }
            })
          });
        }
        if (callCount === 2) {
          // First fetchAvailableModels call returns 403 because project is passed
          expect(body.project).toBe("mock-project-123");
          return Promise.resolve({
            ok: false,
            status: 403,
            text: () => Promise.resolve("Access Forbidden")
          });
        }
        if (callCount === 3) {
          // Second retry call strips project ID
          expect(body.project).toBeUndefined();
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              models: {
                "gemini-3.5-flash-low": {
                  quotaInfo: { remainingFraction: 0.85, resetTime: "2026-05-28T09:00:00Z" },
                  displayName: "Gemini 3.5 Flash Low"
                }
              }
            })
          });
        }
      });

      const usageModule = await import("../../open-sse/services/usage.js");
      const result = await usageModule.getUsageForProvider({
        provider: "antigravity",
        accessToken: "test-token"
      });

      expect(callCount).toBe(3);
      expect(result.plan).toBe("Google One AI Premium");
      expect(result.quotas["gemini-3.5-flash-low"]).toBeDefined();
      expect(result.quotas["gemini-3.5-flash-low"].remainingPercentage).toBe(85);
    });

    it("should return isForbidden true if retry without project still returns 403", async () => {
      let callCount = 0;
      mockFetchFn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              cloudaicompanionProject: "mock-project-123"
            })
          });
        }
        return Promise.resolve({
          ok: false,
          status: 403,
          text: () => Promise.resolve("Access Forbidden")
        });
      });

      const usageModule = await import("../../open-sse/services/usage.js");
      const result = await usageModule.getUsageForProvider({
        provider: "antigravity",
        accessToken: "test-token"
      });

      expect(result.isForbidden).toBe(true);
    });

    it("should filter and keep only the requested models quotas", async () => {
      let callCount = 0;
      mockFetchFn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              cloudaicompanionProject: "mock-project-123"
            })
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            models: {
              "gpt-oss-120b-medium": { quotaInfo: { remainingFraction: 1.0 } },
              "gemini-3.1-flash-image": { quotaInfo: { remainingFraction: 1.0 } },
              "claude-opus-4-6-thinking": { quotaInfo: { remainingFraction: 1.0 } },
              "claude-sonnet-4-6": { quotaInfo: { remainingFraction: 1.0 } },
              "gemini-3.1-pro-high": { quotaInfo: { remainingFraction: 1.0 } },
              "gemini-3.5-flash-low": { quotaInfo: { remainingFraction: 1.0 } },
              "gemini-2.5-pro": { quotaInfo: { remainingFraction: 1.0 } },
              "gemini-pro-agent": { quotaInfo: { remainingFraction: 1.0 } }
            }
          })
        });
      });

      const usageModule = await import("../../open-sse/services/usage.js");
      const result = await usageModule.getUsageForProvider({
        provider: "antigravity",
        accessToken: "test-token"
      });

      expect(result.quotas).toBeDefined();
      const keys = Object.keys(result.quotas);
      expect(keys).toContain("claude-opus-4-6-thinking");
      expect(keys).toContain("claude-sonnet-4-6");
      expect(keys).toContain("gemini-3.1-pro-high");
      expect(keys).toContain("gemini-3.5-flash-low");
      
      expect(keys).not.toContain("gpt-oss-120b-medium");
      expect(keys).not.toContain("gemini-3.1-flash-image");
      expect(keys).not.toContain("gemini-2.5-pro");
      expect(keys).not.toContain("gemini-pro-agent");
    });
  });
});
