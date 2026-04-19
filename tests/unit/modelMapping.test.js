import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.resolve(__dirname, "../../src/mitm/modelMapping.js");

function loadHelpers() {
  delete require.cache[require.resolve(helperPath)];
  return require(helperPath);
}

function createTempDb(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n9router-mitm-map-"));
  const dbFile = path.join(dir, "db.json");
  fs.writeFileSync(dbFile, JSON.stringify(payload ?? {}, null, 2));
  return {
    dbFile,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe("modelMapping helpers", () => {
  let helpers;

  beforeEach(() => {
    helpers = loadHelpers();
  });

  describe("getMappedModels", () => {
    it("normalizes string aliases into one-item arrays", () => {
      const tmp = createTempDb({ mitmAlias: { antigravity: { opus: "cx/gpt-5.4" } } });
      expect(helpers.getMappedModels({ dbFile: tmp.dbFile, tool: "antigravity", model: "opus" })).toEqual(["cx/gpt-5.4"]);
      tmp.cleanup();
    });

    it("returns trimmed arrays and enforces the max cap", () => {
      const tmp = createTempDb({
        mitmAlias: {
          antigravity: {
            opus: [" a ", "", "b", "c", "d", "e", "f"],
          },
        },
      });
      expect(helpers.getMappedModels({ dbFile: tmp.dbFile, tool: "antigravity", model: "opus" })).toEqual(["a", "b", "c", "d", "e"]);
      tmp.cleanup();
    });

    it("supports prefix matching for model aliases", () => {
      const tmp = createTempDb({ mitmAlias: { antigravity: { "claude-opus": ["cx/gpt-5.4"] } } });
      expect(helpers.getMappedModels({ dbFile: tmp.dbFile, tool: "antigravity", model: "claude-opus-4-6" })).toEqual(["cx/gpt-5.4"]);
      tmp.cleanup();
    });

    it("returns null for missing aliases or malformed db", () => {
      const tmp = createTempDb({ mitmAlias: {} });
      expect(helpers.getMappedModels({ dbFile: tmp.dbFile, tool: "antigravity", model: "opus" })).toBeNull();
      fs.writeFileSync(tmp.dbFile, "{bad json");
      expect(helpers.getMappedModels({ dbFile: tmp.dbFile, tool: "antigravity", model: "opus" })).toBeNull();
      tmp.cleanup();
    });

    it("forces passthrough for gemini-3.1-flash-lite in antigravity mode", () => {
      const tmp = createTempDb({
        mitmAlias: {
          antigravity: {
            "gemini-3.1-flash-lite": ["cx/gpt-5.4"],
          },
        },
      });
      expect(helpers.getMappedModels({
        dbFile: tmp.dbFile,
        tool: "antigravity",
        model: "gemini-3.1-flash-lite",
      })).toBeNull();
      tmp.cleanup();
    });
  });

  describe("shouldPassthroughModel", () => {
    it("matches the antigravity flash-lite passthrough target", () => {
      expect(helpers.shouldPassthroughModel({
        tool: "antigravity",
        model: "gemini-3.1-flash-lite",
      })).toBe(true);
      expect(helpers.shouldPassthroughModel({
        tool: "antigravity",
        model: "gemini-2.5-flash-lite",
      })).toBe(false);
      expect(helpers.shouldPassthroughModel({
        tool: "cursor",
        model: "gemini-3.1-flash-lite",
      })).toBe(false);
    });
  });

  describe("getMitmAliasStrategy", () => {
    it("defaults to round-robin and accepts fallback", () => {
      const missing = createTempDb({});
      expect(helpers.getMitmAliasStrategy({ dbFile: missing.dbFile })).toBe("round-robin");
      missing.cleanup();

      const tmp = createTempDb({ mitmAliasStrategy: "fallback" });
      expect(helpers.getMitmAliasStrategy({ dbFile: tmp.dbFile })).toBe("fallback");
      tmp.cleanup();
    });
  });

  describe("orderMappedModels", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("keeps fallback order intact", () => {
      expect(helpers.orderMappedModels(["a", "b", "c"], "fallback")).toEqual(["a", "b", "c"]);
    });

    it("rotates round-robin order from a random starting index", () => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      expect(helpers.orderMappedModels(["a", "b", "c", "d"], "round-robin")).toEqual(["c", "d", "a", "b"]);
    });
  });

  describe("tryMappedModels", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("retries the next model after a pre-stream failure", async () => {
      const intercept = vi.fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce(undefined);
      const log = vi.fn();
      const errorLog = vi.fn();
      const res = { headersSent: false };
      const interceptOptions = { debugContext: { requestId: "req_123" } };

      const handled = await helpers.tryMappedModels({
        req: {},
        res,
        bodyBuffer: Buffer.from("{}"),
        models: ["m1", "m2"],
        tool: "antigravity",
        strategy: "fallback",
        handlers: { antigravity: { intercept } },
        interceptOptions,
        log,
        err: errorLog,
      });

      expect(handled).toBe(true);
      expect(intercept).toHaveBeenCalledTimes(2);
      expect(intercept.mock.calls[0][3]).toBe("m1");
      expect(intercept.mock.calls[1][3]).toBe("m2");
      expect(intercept.mock.calls[0][4]).toBe(interceptOptions);
      expect(errorLog).toHaveBeenCalledWith("[antigravity] m1 failed: boom");
      expect(log).toHaveBeenCalledWith("⚡ [antigravity] fb [1/2]: trying m1");
      expect(log).toHaveBeenCalledWith("↪️ [antigravity] falling back to next mapped model");
      expect(log).toHaveBeenCalledWith("✅ [antigravity] routed via m2");
    });

    it("stops retrying after headers are sent", async () => {
      const res = { headersSent: false };
      const intercept = vi.fn().mockImplementation(async () => {
        res.headersSent = true;
        throw new Error("stream started");
      });

      const handled = await helpers.tryMappedModels({
        req: {},
        res,
        bodyBuffer: Buffer.from("{}"),
        models: ["m1", "m2"],
        tool: "antigravity",
        strategy: "fallback",
        handlers: { antigravity: { intercept } },
        interceptOptions: { debugContext: null },
        log: vi.fn(),
        err: vi.fn(),
      });

      expect(handled).toBe(true);
      expect(intercept).toHaveBeenCalledTimes(1);
    });

    it("returns false when all mapped models fail before streaming", async () => {
      const intercept = vi.fn().mockRejectedValue(new Error("fail"));

      const handled = await helpers.tryMappedModels({
        req: {},
        res: { headersSent: false },
        bodyBuffer: Buffer.from("{}"),
        models: ["m1", "m2"],
        tool: "antigravity",
        strategy: "fallback",
        handlers: { antigravity: { intercept } },
        interceptOptions: { debugContext: null },
        log: vi.fn(),
        err: vi.fn(),
      });

      expect(handled).toBe(false);
    });
  });
});
