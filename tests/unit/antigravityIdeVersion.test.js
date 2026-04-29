import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const helperPath = path.resolve("../src/mitm/antigravityIdeVersion.js");
const helper = require(helperPath);

const tempDirs = [];

function createTempDb(settings) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "n9router-ag-version-"));
  tempDirs.push(tmpDir);
  const dbFile = path.join(tmpDir, "db.json");
  fs.writeFileSync(dbFile, JSON.stringify({ settings }, null, 2));
  return dbFile;
}

describe("antigravityIdeVersion", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it("keeps requests unchanged when the override is disabled", () => {
    const dbFile = createTempDb({
      mitmAntigravityIdeVersionOverrideEnabled: false,
      mitmAntigravityIdeVersion: "1.23.2",
    });
    const body = Buffer.from(JSON.stringify({
      metadata: {
        ideName: "antigravity",
        ideVersion: "1.22.2",
      },
    }));
    const headers = { "user-agent": "antigravity/1.22.2 darwin/arm64" };

    const result = helper.applyAntigravityIdeVersionOverride(body, headers, dbFile);

    expect(result.applied).toBe(false);
    expect(result.bodyBuffer).toBe(body);
    expect(result.headers).toBe(headers);
  });

  it("rewrites Antigravity metadata and user-agent to the configured version", () => {
    const dbFile = createTempDb({
      mitmAntigravityIdeVersionOverrideEnabled: true,
      mitmAntigravityIdeVersion: "1.24.0",
    });
    const body = Buffer.from(JSON.stringify({
      metadata: {
        ideName: "antigravity",
        ideType: "ANTIGRAVITY",
        ideVersion: "1.22.2",
        platform: "DARWIN_ARM64",
      },
      mode: "FULL_ELIGIBILITY_CHECK",
    }));
    const headers = { "user-agent": "antigravity/1.22.2 darwin/arm64" };

    const result = helper.applyAntigravityIdeVersionOverride(body, headers, dbFile);
    const parsed = JSON.parse(result.bodyBuffer.toString());

    expect(result.applied).toBe(true);
    expect(parsed.metadata.ideVersion).toBe("1.24.0");
    expect(result.headers["user-agent"]).toBe("antigravity/1.24.0 darwin/arm64");
    expect(headers["user-agent"]).toBe("antigravity/1.22.2 darwin/arm64");
  });

  it("defaults the configured version to 1.23.2", () => {
    const dbFile = createTempDb({
      mitmAntigravityIdeVersionOverrideEnabled: true,
      mitmAntigravityIdeVersion: "",
    });
    const body = Buffer.from(JSON.stringify({
      metadata: {
        ideType: "ANTIGRAVITY",
        ideVersion: "1.22.2",
      },
    }));
    const headers = { "user-agent": "antigravity/1.22.2 darwin/arm64" };

    const result = helper.applyAntigravityIdeVersionOverride(body, headers, dbFile);
    const parsed = JSON.parse(result.bodyBuffer.toString());

    expect(parsed.metadata.ideVersion).toBe("1.23.2");
    expect(result.headers["user-agent"]).toBe("antigravity/1.23.2 darwin/arm64");
  });

  it("rewrites user-agent even when the body has no metadata", () => {
    const dbFile = createTempDb({
      mitmAntigravityIdeVersionOverrideEnabled: true,
      mitmAntigravityIdeVersion: "1.24.0",
    });
    const body = Buffer.from(JSON.stringify({ contents: [{ role: "user" }] }));
    const headers = { "user-agent": "antigravity/1.22.2 darwin/arm64" };

    const result = helper.applyAntigravityIdeVersionOverride(body, headers, dbFile);

    expect(result.applied).toBe(true);
    expect(result.bodyBuffer).toBe(body);
    expect(result.headers["user-agent"]).toBe("antigravity/1.24.0 darwin/arm64");
  });

  it("rewrites user-agent for non-JSON request bodies", () => {
    const dbFile = createTempDb({
      mitmAntigravityIdeVersionOverrideEnabled: true,
      mitmAntigravityIdeVersion: "1.24.0",
    });
    const body = Buffer.from("not json");
    const headers = { "user-agent": "antigravity/1.22.2 darwin/arm64" };

    const result = helper.applyAntigravityIdeVersionOverride(body, headers, dbFile);

    expect(result.applied).toBe(true);
    expect(result.bodyBuffer).toBe(body);
    expect(result.headers["user-agent"]).toBe("antigravity/1.24.0 darwin/arm64");
  });
});
