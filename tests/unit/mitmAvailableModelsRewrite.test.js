import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const {
  applyAntigravityModelNameOverrides,
  buildJsonResponseHeaders,
  rewriteAvailableModelsResponse,
} = require("../../src/mitm/modelNameOverrides.js");

describe("Antigravity available models rewrite", () => {
  it("rewrites object-shaped model display names", () => {
    const data = {
      models: {
        "gemini-3.1-pro-high": {
          displayName: "Gemini 3.1 Pro High",
          quotaInfo: { remainingFraction: 1 },
          isInternal: false,
        },
        "gemini-3-flash": {
          displayName: "Gemini 3 Flash",
        },
      },
    };

    const result = applyAntigravityModelNameOverrides(data, {
      "gemini-3.1-pro-high": "Custom Pro",
    });

    expect(result.changed).toBe(true);
    expect(result.changedModelIds).toEqual(["gemini-3.1-pro-high"]);
    expect(data.models["gemini-3.1-pro-high"].displayName).toBe("Custom Pro");
    expect(data.models["gemini-3.1-pro-high"].quotaInfo).toEqual({ remainingFraction: 1 });
    expect(data.models["gemini-3-flash"].displayName).toBe("Gemini 3 Flash");
  });

  it("rewrites array-shaped model display names", () => {
    const data = {
      models: [
        { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
        { id: "gpt-oss-120b-medium", displayName: "GPT OSS 120B Medium" },
      ],
    };

    const result = applyAntigravityModelNameOverrides(data, {
      "claude-sonnet-4-6": "Custom Sonnet",
    });

    expect(result.changed).toBe(true);
    expect(data.models[0].displayName).toBe("Custom Sonnet");
    expect(data.models[0].id).toBe("claude-sonnet-4-6");
    expect(data.models[1].displayName).toBe("GPT OSS 120B Medium");
  });

  it("returns unchanged when no override matches", () => {
    const data = { models: { known: { displayName: "Known" } } };
    const result = applyAntigravityModelNameOverrides(data, { other: "Other" });

    expect(result.changed).toBe(false);
    expect(data.models.known.displayName).toBe("Known");
  });

  it("rewrites compressed JSON and removes stale response headers", () => {
    const rawBuffer = zlib.gzipSync(Buffer.from(JSON.stringify({
      models: {
        "gemini-3.1-pro-high": { displayName: "Gemini 3.1 Pro High" },
      },
    })));
    const result = rewriteAvailableModelsResponse({
      rawBuffer,
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(rawBuffer.length),
      },
      overrides: {
        "gemini-3.1-pro-high": "Custom Pro",
      },
    });

    expect(result.changed).toBe(true);
    expect(result.headers["content-encoding"]).toBeUndefined();
    expect(result.headers["content-length"]).toBeUndefined();
    expect(result.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(result.bodyBuffer.toString("utf-8")).models["gemini-3.1-pro-high"].displayName).toBe("Custom Pro");
  });

  it("returns raw response when JSON parsing fails", () => {
    const rawBuffer = Buffer.from("not json");
    const result = rewriteAvailableModelsResponse({
      rawBuffer,
      headers: { "content-type": "text/plain" },
      overrides: { known: "Known" },
    });

    expect(result.changed).toBe(false);
    expect(result.reason).toBe("parse_failed");
    expect(result.rawBuffer).toBe(rawBuffer);
  });

  it("builds rewritten JSON headers without transfer metadata", () => {
    const headers = buildJsonResponseHeaders({
      "content-type": "application/json",
      "content-encoding": "br",
      "content-length": "10",
      "transfer-encoding": "chunked",
      "x-custom": "yes",
    });

    expect(headers).toEqual({
      "content-type": "application/json; charset=utf-8",
      "x-custom": "yes",
    });
  });
});
