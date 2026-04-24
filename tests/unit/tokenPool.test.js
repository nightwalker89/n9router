/**
 * Unit tests for src/mitm/tokenPool.js
 *
 * Tests cover all plan requirements:
 *  - Cooldown management (set, check, auto-expire)
 *  - Quota cooldown parser (Antigravity error format)
 *  - getActiveConnections filtering (isActive, accessToken, expiry, cooldown)
 *  - isTokenSwapEnabled
 *  - getNextConnection / LRU round-robin
 *  - getAllActiveConnections
 *  - triggerRefreshIfNeeded (awaits refresh and reloads persisted token)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import { createRequire } from "module";
import os from "os";
import path from "path";
import fs from "fs";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal db.json providerConnections entry */
function makeConn(overrides = {}) {
  return {
    id: overrides.id || "conn-" + Math.random().toString(36).slice(2, 8),
    provider: "antigravity",
    accessToken: "tok-abc",
    isActive: true,
    priority: 1,
    expiresAt: null,
    refreshToken: null,
    name: "Test Account",
    ...overrides,
  };
}

/** Write a db.json to a temp dir and return {DATA_DIR, dbPath, cleanup} */
function createTempDb(conns = []) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-test-"));
  const dbPath = path.join(tmpDir, "db.json");
  fs.writeFileSync(dbPath, JSON.stringify({ providerConnections: conns }));
  return {
    DATA_DIR: tmpDir,
    dbPath,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

/** Load a fresh (isolated) copy of tokenPool.js for each test */
function loadTokenPool(DATA_DIR) {
  // tokenPool.js uses require("./paths") which reads DATA_DIR from env
  process.env.DATA_DIR = DATA_DIR;

  // Purge Node module cache so each test gets a fresh module (clean in-memory state)
  const require = createRequire(import.meta.url);
  const poolPath = path.resolve("../src/mitm/tokenPool.js");
  delete require.cache[require.resolve(poolPath)];
  // Also purge transitive dep paths
  const pathsPath = path.resolve("../src/mitm/paths.js");
  delete require.cache[require.resolve(pathsPath)];
  const loggerPath = path.resolve("../src/mitm/logger.js");
  delete require.cache[require.resolve(loggerPath)];

  return require(poolPath);
}

// ── Cooldown Management ──────────────────────────────────────────────────────

describe("setCooldown / isInCooldown", () => {
  let tmp, pool;
  beforeEach(() => {
    tmp = createTempDb();
    pool = loadTokenPool(tmp.DATA_DIR);
  });
  afterEach(() => tmp.cleanup());

  it("returns false when no cooldown set", () => {
    // Access isInCooldown indirectly via getActiveConnections
    const conn = makeConn();
    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [conn] }));
    // Should be returned (not in cooldown)
    expect(pool.getAllActiveConnections("antigravity")).toHaveLength(1);
  });

  it("marks a connection in cooldown → filtered from active list", () => {
    const conn = makeConn();
    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [conn] }));
    pool.setCooldown(conn.id, 60_000); // 1 minute
    expect(pool.getAllActiveConnections("antigravity")).toHaveLength(0);
  });

  it("auto-expires cooldown after duration", () => {
    vi.useFakeTimers();
    const conn = makeConn();
    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [conn] }));
    pool.setCooldown(conn.id, 60_000);
    expect(pool.getAllActiveConnections("antigravity")).toHaveLength(0);

    vi.advanceTimersByTime(61_000);
    expect(pool.getAllActiveConnections("antigravity")).toHaveLength(1);
    vi.useRealTimers();
  });

  it("uses DEFAULT_COOLDOWN_MS (2min) when durationMs is null/undefined", () => {
    vi.useFakeTimers();
    const conn = makeConn();
    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [conn] }));
    pool.setCooldown(conn.id, null); // triggers default
    expect(pool.getAllActiveConnections("antigravity")).toHaveLength(0);

    vi.advanceTimersByTime(60 * 1000); // 1 min — still in cooldown
    expect(pool.getAllActiveConnections("antigravity")).toHaveLength(0);

    vi.advanceTimersByTime(2 * 60 * 1000); // total 3 min — expired
    expect(pool.getAllActiveConnections("antigravity")).toHaveLength(1);
    vi.useRealTimers();
  });
});

// ── parseQuotaCooldown ───────────────────────────────────────────────────────

describe("parseQuotaCooldown", () => {
  let tmp, pool;
  beforeEach(() => {
    tmp = createTempDb();
    pool = loadTokenPool(tmp.DATA_DIR);
  });
  afterEach(() => tmp.cleanup());

  it("parses full h+m+s format", () => {
    const body = JSON.stringify({ error: { message: "Your quota will reset after 2h7m23s" } });
    const ms = pool.parseQuotaCooldown(body);
    expect(ms).toBe(2 * 3600_000 + 7 * 60_000 + 23 * 1000);
  });

  it("parses hours only", () => {
    const body = JSON.stringify({ error: { message: "reset after 1h" } });
    expect(pool.parseQuotaCooldown(body)).toBe(3600_000);
  });

  it("parses minutes only", () => {
    const body = JSON.stringify({ message: "reset after 30m" });
    expect(pool.parseQuotaCooldown(body)).toBe(30 * 60_000);
  });

  it("parses seconds only", () => {
    const body = JSON.stringify({ error: { message: "reset after 45s" } });
    expect(pool.parseQuotaCooldown(body)).toBe(45_000);
  });

  it("returns null when no reset pattern found", () => {
    const body = JSON.stringify({ error: { message: "Quota exceeded" } });
    expect(pool.parseQuotaCooldown(body)).toBeNull();
  });

  it("maps MODEL_CAPACITY_EXHAUSTED to a 1 minute cooldown", () => {
    const body = JSON.stringify({
      error: {
        code: 503,
        message: "No capacity available for model claude-sonnet-4-6 on the server",
        details: [
          { reason: "MODEL_CAPACITY_EXHAUSTED" }
        ]
      }
    });
    expect(pool.parseQuotaCooldown(body)).toBe(60_000);
    expect(pool.shouldImmediateQuotaCooldown(503, body)).toBe(true);
  });

  it("does not force immediate cooldown for 429 without an explicit reset window", () => {
    const body = JSON.stringify({ error: { message: "Quota exceeded" } });
    expect(pool.shouldImmediateQuotaCooldown(429, body)).toBe(false);
  });

  it("returns null for invalid JSON", () => {
    expect(pool.parseQuotaCooldown("not json")).toBeNull();
  });

  it("returns null for empty error body", () => {
    expect(pool.parseQuotaCooldown("{}")).toBeNull();
  });

  it("is case-insensitive", () => {
    const body = JSON.stringify({ error: { message: "RESET AFTER 10M" } });
    expect(pool.parseQuotaCooldown(body)).toBe(10 * 60_000);
  });
});

// ── getActiveConnections filtering ──────────────────────────────────────────

describe("getActiveConnections — filtering", () => {
  let tmp, pool;
  beforeEach(() => {
    tmp = createTempDb();
    pool = loadTokenPool(tmp.DATA_DIR);
  });
  afterEach(() => tmp.cleanup());

  it("returns empty array when db.json does not exist", () => {
    fs.rmSync(tmp.dbPath);
    expect(pool.getAllActiveConnections("antigravity")).toEqual([]);
  });

  it("returns empty array when db.json has no providerConnections key", () => {
    fs.writeFileSync(tmp.dbPath, JSON.stringify({}));
    expect(pool.getAllActiveConnections("antigravity")).toEqual([]);
  });

  it("filters out connections for different providers", () => {
    const other = makeConn({ provider: "copilot" });
    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [other] }));
    expect(pool.getAllActiveConnections("antigravity")).toHaveLength(0);
  });

  it("filters out isActive:false connections", () => {
    const conn = makeConn({ isActive: false });
    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [conn] }));
    expect(pool.getAllActiveConnections("antigravity")).toHaveLength(0);
  });

  it("filters out connections without accessToken", () => {
    const conn = makeConn({ accessToken: "" });
    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [conn] }));
    expect(pool.getAllActiveConnections("antigravity")).toHaveLength(0);
  });

  it("filters out expired tokens that have no refreshToken", () => {
    const pastDate = new Date(Date.now() - 1000).toISOString();
    const conn = makeConn({ expiresAt: pastDate, refreshToken: null });
    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [conn] }));
    expect(pool.getAllActiveConnections("antigravity")).toHaveLength(0);
  });

  it("keeps expired token if it has a refreshToken (can be refreshed)", () => {
    const pastDate = new Date(Date.now() - 1000).toISOString();
    const conn = makeConn({ expiresAt: pastDate, refreshToken: "reftok" });
    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [conn] }));
    expect(pool.getAllActiveConnections("antigravity")).toHaveLength(1);
  });

  it("keeps non-expired token regardless of refreshToken presence", () => {
    const futureDate = new Date(Date.now() + 3600_000).toISOString();
    const conn = makeConn({ expiresAt: futureDate, refreshToken: null });
    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [conn] }));
    expect(pool.getAllActiveConnections("antigravity")).toHaveLength(1);
  });

  it("sorts by priority ascending", () => {
    const low = makeConn({ id: "low", priority: 10 });
    const high = makeConn({ id: "high", priority: 1 });
    const mid = makeConn({ id: "mid", priority: 5 });
    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [low, mid, high] }));
    const result = pool.getAllActiveConnections("antigravity");
    expect(result.map(c => c.id)).toEqual(["high", "mid", "low"]);
  });

  it("treats missing priority as 999 (lowest priority)", () => {
    const noPriority = makeConn({ id: "no-prio", priority: undefined });
    const withPriority = makeConn({ id: "with-prio", priority: 1 });
    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [noPriority, withPriority] }));
    const result = pool.getAllActiveConnections("antigravity");
    expect(result[0].id).toBe("with-prio");
    expect(result[1].id).toBe("no-prio");
  });

  it("handles malformed db.json gracefully", () => {
    fs.writeFileSync(tmp.dbPath, "{ INVALID JSON");
    expect(pool.getAllActiveConnections("antigravity")).toEqual([]);
  });
});

describe("getAllActiveConnections — stored model quota exhaustion", () => {
  let tmp, pool;
  beforeEach(() => {
    tmp = createTempDb();
    pool = loadTokenPool(tmp.DATA_DIR);
  });
  afterEach(() => tmp.cleanup());

  it("skips accounts whose stored quota for the requested model is zero", () => {
    const exhausted = makeConn({
      id: "exhausted",
      priority: 1,
      modelQuotaStatus: {
        "claude-sonnet-4-6": {
          remainingPercentage: 0,
          exhausted: true,
        },
      },
    });
    const healthy = makeConn({
      id: "healthy",
      priority: 2,
      modelQuotaStatus: {
        "claude-sonnet-4-6": {
          remainingPercentage: 42,
          exhausted: false,
        },
      },
    });

    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [exhausted, healthy] }));

    const result = pool.getAllActiveConnections("antigravity", "claude-sonnet-4-6");
    expect(result.map(c => c.id)).toEqual(["healthy"]);
  });

  it("returns no accounts when all stored quotas for the requested model are zero", () => {
    const c1 = makeConn({
      id: "c1",
      priority: 1,
      modelQuotaStatus: {
        "claude-sonnet-4-6": {
          remainingPercentage: 0,
          exhausted: true,
        },
      },
    });
    const c2 = makeConn({
      id: "c2",
      priority: 2,
      modelQuotaStatus: {
        "claude-sonnet-4-6": {
          remainingPercentage: 0,
          exhausted: true,
        },
      },
    });

    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [c1, c2] }));

    expect(pool.getAllActiveConnections("antigravity", "claude-sonnet-4-6")).toEqual([]);
  });
});

describe("autoDisableAccountIfSonnetQuotaZero", () => {
  let tmp, pool;
  beforeEach(() => {
    tmp = createTempDb();
    pool = loadTokenPool(tmp.DATA_DIR);
  });
  afterEach(() => tmp.cleanup());

  it("disables an active Antigravity account when Sonnet 4.6 quota is zero", () => {
    const conn = makeConn({
      id: "sonnet-zero",
      modelQuotaStatus: {
        "claude-sonnet-4-6": {
          remainingPercentage: 0,
          exhausted: true,
        },
      },
    });

    fs.writeFileSync(tmp.dbPath, JSON.stringify({
      providerConnections: [conn],
      settings: { mitmAntigravityAutoDisableOnSonnetZero: true },
    }));

    expect(pool.autoDisableAccountIfSonnetQuotaZero(conn, { statusCode: 429 })).toBe(true);

    const db = JSON.parse(fs.readFileSync(tmp.dbPath, "utf8"));
    expect(db.providerConnections[0].isActive).toBe(false);
    expect(db.providerConnections[0].autoDisabledReason).toBe("sonnet_4_6_quota_zero");
    expect(db.providerConnections[0].lastError).toContain("Claude Sonnet 4.6 quota is 0%");
  });

  it("does not disable when the setting is off", () => {
    const conn = makeConn({
      id: "setting-off",
      modelQuotaStatus: {
        "claude-sonnet-4-6": {
          remainingPercentage: 0,
          exhausted: true,
        },
      },
    });

    fs.writeFileSync(tmp.dbPath, JSON.stringify({
      providerConnections: [conn],
      settings: { mitmAntigravityAutoDisableOnSonnetZero: false },
    }));

    expect(pool.autoDisableAccountIfSonnetQuotaZero(conn, { statusCode: 503 })).toBe(false);

    const db = JSON.parse(fs.readFileSync(tmp.dbPath, "utf8"));
    expect(db.providerConnections[0].isActive).toBe(true);
  });

  it("does not disable when Sonnet 4.6 quota is still available", () => {
    const conn = makeConn({
      id: "sonnet-available",
      modelQuotaStatus: {
        "claude-sonnet-4-6": {
          remainingPercentage: 12,
          exhausted: false,
        },
      },
    });

    fs.writeFileSync(tmp.dbPath, JSON.stringify({
      providerConnections: [conn],
      settings: { mitmAntigravityAutoDisableOnSonnetZero: true },
    }));

    expect(pool.autoDisableAccountIfSonnetQuotaZero(conn, { statusCode: 429 })).toBe(false);

    const db = JSON.parse(fs.readFileSync(tmp.dbPath, "utf8"));
    expect(db.providerConnections[0].isActive).toBe(true);
  });
});

// ── isTokenSwapEnabled ───────────────────────────────────────────────────────

describe("isTokenSwapEnabled", () => {
  let tmp, pool;
  beforeEach(() => {
    tmp = createTempDb();
    pool = loadTokenPool(tmp.DATA_DIR);
  });
  afterEach(() => tmp.cleanup());

  it("returns true when settings.tokenSwapEnabled=true AND active connections exist", () => {
    fs.writeFileSync(tmp.dbPath, JSON.stringify({
      providerConnections: [makeConn()],
      settings: { tokenSwapEnabled: true },
    }));
    expect(pool.isTokenSwapEnabled("antigravity")).toBe(true);
  });

  it("returns false when settings.tokenSwapEnabled=true but no active connections", () => {
    fs.writeFileSync(tmp.dbPath, JSON.stringify({
      providerConnections: [],
      settings: { tokenSwapEnabled: true },
    }));
    expect(pool.isTokenSwapEnabled("antigravity")).toBe(false);
  });

  it("returns false when active connections exist but tokenSwapEnabled not set", () => {
    fs.writeFileSync(tmp.dbPath, JSON.stringify({
      providerConnections: [makeConn()],
    }));
    expect(pool.isTokenSwapEnabled("antigravity")).toBe(false);
  });

  it("returns false when tokenSwapEnabled=false even with active connections", () => {
    fs.writeFileSync(tmp.dbPath, JSON.stringify({
      providerConnections: [makeConn()],
      settings: { tokenSwapEnabled: false },
    }));
    expect(pool.isTokenSwapEnabled("antigravity")).toBe(false);
  });

  it("returns false for unknown provider even when enabled", () => {
    fs.writeFileSync(tmp.dbPath, JSON.stringify({
      providerConnections: [makeConn()],
      settings: { tokenSwapEnabled: true },
    }));
    expect(pool.isTokenSwapEnabled("github-copilot")).toBe(false);
  });

  it("returns false when db.json does not exist", () => {
    fs.rmSync(tmp.dbPath);
    expect(pool.isTokenSwapEnabled("antigravity")).toBe(false);
  });
});

// ── getNextConnection (least-recently-used round-robin) ─────────────────────

describe("getNextConnection — least-recently-used round-robin", () => {
  let tmp, pool;
  beforeEach(() => {
    tmp = createTempDb();
    pool = loadTokenPool(tmp.DATA_DIR);
  });
  afterEach(() => tmp.cleanup());

  it("returns null when no active connections", () => {
    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [] }));
    expect(pool.getNextConnection("antigravity")).toBeNull();
  });

  it("always returns same connection when only one exists (no RR needed)", () => {
    const conn = makeConn({ id: "only" });
    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [conn] }));
    expect(pool.getNextConnection("antigravity").id).toBe("only");
    expect(pool.getNextConnection("antigravity").id).toBe("only");
    expect(pool.getNextConnection("antigravity").id).toBe("only");
  });

  it("selects the least recently used connection first", () => {
    const c1 = makeConn({ id: "c1", priority: 1, lastUsedAt: "2026-04-11T09:00:00.000Z" });
    const c2 = makeConn({ id: "c2", priority: 2, lastUsedAt: "2026-04-11T08:00:00.000Z" });
    const c3 = makeConn({ id: "c3", priority: 3, lastUsedAt: "2026-04-11T07:00:00.000Z" });
    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [c1, c2, c3] }));

    expect(pool.getNextConnection("antigravity").id).toBe("c3");
  });

  it("prefers never-used accounts before previously used ones", () => {
    const fresh = makeConn({ id: "fresh", priority: 3, lastUsedAt: null });
    const older = makeConn({ id: "older", priority: 2, lastUsedAt: "2026-04-11T08:00:00.000Z" });
    const newer = makeConn({ id: "newer", priority: 1, lastUsedAt: "2026-04-11T09:00:00.000Z" });
    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [newer, older, fresh] }));

    expect(pool.getNextConnection("antigravity").id).toBe("fresh");
  });

  it("advances naturally after markAccountUsed updates lastUsedAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-11T10:00:00.000Z"));

    const c1 = makeConn({ id: "c1", priority: 1, lastUsedAt: "2026-04-11T07:00:00.000Z" });
    const c2 = makeConn({ id: "c2", priority: 2, lastUsedAt: "2026-04-11T08:00:00.000Z" });
    const c3 = makeConn({ id: "c3", priority: 3, lastUsedAt: "2026-04-11T09:00:00.000Z" });
    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [c1, c2, c3] }));

    expect(pool.getNextConnection("antigravity").id).toBe("c1");

    pool.markAccountUsed("c1");

    const db = JSON.parse(fs.readFileSync(tmp.dbPath, "utf-8"));
    const updated = db.providerConnections.find((conn) => conn.id === "c1");
    expect(updated.lastUsedAt).toBeTruthy();
    expect(updated.consecutiveUseCount).toBeUndefined();

    expect(pool.getNextConnection("antigravity").id).toBe("c2");
    vi.useRealTimers();
  });

  it("skips cooldown accounts in round-robin", () => {
    const c1 = makeConn({ id: "c1", priority: 1 });
    const c2 = makeConn({ id: "c2", priority: 2 });
    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [c1, c2] }));

    pool.setCooldown("c1", 60_000);
    // Only c2 available
    const next = pool.getNextConnection("antigravity");
    expect(next.id).toBe("c2");
  });
});

// ── triggerRefreshIfNeeded ───────────────────────────────────────────────────
// Note: tokenPool.js uses CJS require("http") internally — it captures the module
// reference at require-time. We spy on http.request before loading the pool module.

describe("triggerRefreshIfNeeded", () => {
  let tmp, pool, httpSpy;

  beforeEach(() => {
    tmp = createTempDb();
    vi.clearAllMocks();
  });
  afterEach(() => {
    httpSpy?.mockRestore();
    tmp.cleanup();
  });

  it("does not make HTTP request when no expiresAt set", async () => {
    httpSpy = vi.spyOn(http, "request").mockReturnValue({ on: vi.fn(), end: vi.fn() });
    pool = loadTokenPool(tmp.DATA_DIR);
    const conn = makeConn({ expiresAt: null });
    const result = await pool.triggerRefreshIfNeeded(conn);
    expect(httpSpy).not.toHaveBeenCalled();
    expect(result).toEqual(conn);
  });

  it("does not make HTTP request when token expires far in future (>5min)", async () => {
    httpSpy = vi.spyOn(http, "request").mockReturnValue({ on: vi.fn(), end: vi.fn() });
    pool = loadTokenPool(tmp.DATA_DIR);
    const futureDate = new Date(Date.now() + 10 * 60_000).toISOString(); // 10 min
    const conn = makeConn({ expiresAt: futureDate, refreshToken: "reftok" });
    const result = await pool.triggerRefreshIfNeeded(conn);
    expect(httpSpy).not.toHaveBeenCalled();
    expect(result).toEqual(conn);
  });

  it("does not make HTTP request when no refreshToken exists", async () => {
    httpSpy = vi.spyOn(http, "request").mockReturnValue({ on: vi.fn(), end: vi.fn() });
    pool = loadTokenPool(tmp.DATA_DIR);
    const nearExpiry = new Date(Date.now() + 3 * 60_000).toISOString();
    const conn = makeConn({ expiresAt: nearExpiry, refreshToken: null });
    const result = await pool.triggerRefreshIfNeeded(conn);
    expect(httpSpy).not.toHaveBeenCalled();
    expect(result).toEqual(conn);
  });

  it("fires HTTP request when token expires within 5min (near expiry)", async () => {
    const mockRes = {
      on: vi.fn((event, handler) => {
        if (event === "end") handler();
        return mockRes;
      }),
    };
    const mockReq = {
      on: vi.fn(),
      end: vi.fn(() => {
        const db = JSON.parse(fs.readFileSync(tmp.dbPath, "utf-8"));
        db.providerConnections[0].accessToken = "tok-new";
        fs.writeFileSync(tmp.dbPath, JSON.stringify(db));
        httpSpy.mock.calls[0][1](mockRes);
      }),
    };
    httpSpy = vi.spyOn(http, "request").mockReturnValue(mockReq);
    pool = loadTokenPool(tmp.DATA_DIR);

    const nearExpiry = new Date(Date.now() + 3 * 60_000).toISOString(); // 3 min
    const conn = makeConn({ id: "refresh-me", expiresAt: nearExpiry, refreshToken: "reftok" });
    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [conn] }));
    const result = await pool.triggerRefreshIfNeeded(conn);

    expect(httpSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: `/api/providers/refresh-me/test`,
      }),
      expect.any(Function)
    );
    expect(mockReq.end).toHaveBeenCalled();
    expect(result.accessToken).toBe("tok-new");
  });

  it("fires HTTP request when token is already expired", async () => {
    const mockRes = {
      on: vi.fn((event, handler) => {
        if (event === "end") handler();
        return mockRes;
      }),
    };
    const mockReq = {
      on: vi.fn(),
      end: vi.fn(() => {
        httpSpy.mock.calls[0][1](mockRes);
      }),
    };
    httpSpy = vi.spyOn(http, "request").mockReturnValue(mockReq);
    pool = loadTokenPool(tmp.DATA_DIR);

    const pastDate = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    const conn = makeConn({ id: "expired-conn", expiresAt: pastDate, refreshToken: "reftok" });
    fs.writeFileSync(tmp.dbPath, JSON.stringify({ providerConnections: [conn] }));
    const result = await pool.triggerRefreshIfNeeded(conn);

    expect(httpSpy).toHaveBeenCalled();
    expect(result.id).toBe("expired-conn");
  });
});

// ── Module exports contract ──────────────────────────────────────────────────

describe("module exports", () => {
  let tmp, pool;
  beforeEach(() => {
    tmp = createTempDb();
    pool = loadTokenPool(tmp.DATA_DIR);
  });
  afterEach(() => tmp.cleanup());

  it("exports all required functions from the plan", () => {
    expect(typeof pool.isTokenSwapEnabled).toBe("function");
    expect(typeof pool.getNextConnection).toBe("function");
    expect(typeof pool.getAllActiveConnections).toBe("function");
    expect(typeof pool.triggerRefreshIfNeeded).toBe("function");
    expect(typeof pool.setCooldown).toBe("function");
    expect(typeof pool.parseQuotaCooldown).toBe("function");
  });
});
