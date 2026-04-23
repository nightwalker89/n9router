import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const helperPath = path.resolve("../src/mitm/antigravityDebugLog.js");
const pathsPath = path.resolve("../src/mitm/paths.js");

function createTempDb(payload = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "n9router-aglog-"));
  fs.writeFileSync(path.join(tmpDir, "db.json"), JSON.stringify(payload, null, 2));
  return {
    DATA_DIR: tmpDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function loadHelper(DATA_DIR) {
  process.env.DATA_DIR = DATA_DIR;
  delete require.cache[require.resolve(helperPath)];
  delete require.cache[require.resolve(pathsPath)];
  return require(helperPath);
}

describe("antigravityDebugLog", () => {
  let tmp;
  let helper;

  beforeEach(() => {
    tmp = createTempDb({
      providerConnections: [
        {
          id: "conn-1",
          provider: "antigravity",
          accessToken: "token-abcdef123456",
          email: "debug@example.com",
          name: "Debug Account",
        },
      ],
      settings: {
        mitmAntigravityDebugLogsEnabled: true,
      },
    });
    helper = loadHelper(tmp.DATA_DIR);
  });

  afterEach(() => {
    tmp.cleanup();
    delete process.env.DATA_DIR;
  });

  it("writes structured request logs with masked tokens and matched account details", () => {
    const context = helper.createAntigravityDebugContext({
      req: {
        method: "POST",
        url: "/v1beta/models/gemini-2.5-pro:streamGenerateContent",
        headers: {
          host: "cloudcode-pa.googleapis.com",
          authorization: "Bearer token-abcdef123456",
          "content-type": "application/json",
        },
      },
      bodyBuffer: Buffer.from(JSON.stringify({ model: "gemini-2.5-pro", contents: [{ role: "user" }] })),
      model: "gemini-2.5-pro",
    });

    expect(context).not.toBeNull();
    context.logRequest({ tool: "antigravity", mode: "passthrough" });

    const logFile = helper.getAntigravityDebugLogFilePath();
    expect(fs.existsSync(logFile)).toBe(true);

    const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe("request.received");
    expect(lines[0].incomingTokenMasked).toBe("token-...3456");
    expect(lines[0].accountEmail).toBe("debug@example.com");
    expect(lines[0].requestHeaders.authorization).toBe("Bearer token-...3456");
    expect(lines[0].requestBody.model).toBe("gemini-2.5-pro");
  });

  it("captures and decodes response payloads", () => {
    const context = helper.createAntigravityDebugContext({
      req: {
        method: "POST",
        url: "/v1beta/models/gemini-2.5-pro:generateContent",
        headers: {
          host: "cloudcode-pa.googleapis.com",
          authorization: "Bearer token-abcdef123456",
        },
      },
      bodyBuffer: Buffer.from("{}"),
      model: "gemini-2.5-pro",
    });

    context.logResponse({
      statusCode: 200,
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      bodyBuffer: zlib.gzipSync(Buffer.from(JSON.stringify({ ok: true, text: "hello" }))),
      streamed: false,
      note: "test response",
    });

    const lines = fs.readFileSync(helper.getAntigravityDebugLogFilePath(), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0].event).toBe("response.completed");
    expect(lines[0].responseBody).toEqual({ ok: true, text: "hello" });
    expect(lines[0].note).toBe("test response");
  });

  it("returns null when debug logging is disabled", () => {
    fs.writeFileSync(path.join(tmp.DATA_DIR, "db.json"), JSON.stringify({
      settings: { mitmAntigravityDebugLogsEnabled: false },
      providerConnections: [],
    }));
    helper = loadHelper(tmp.DATA_DIR);

    expect(helper.createAntigravityDebugContext({
      req: { headers: {} },
      bodyBuffer: Buffer.from("{}"),
      model: "gemini-2.5-pro",
    })).toBeNull();
  });
});
