import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { applyThinking, stripThinkingSuffix } from "../../open-sse/translator/concerns/thinkingUnified.js";
import antigravityRegistry from "../../open-sse/providers/registry/antigravity.js";
import geminiRegistry from "../../open-sse/providers/registry/gemini.js";
import { MODEL_PRICING } from "../../open-sse/providers/pricing.js";

const require = createRequire(import.meta.url);
const mitmConfig = require("../../src/mitm/config.js");

describe("Gemini 3.7 Flash Support & Config (#3286, #3281)", () => {
  it("registers gemini-3.7-flash tiered models in antigravity provider registry", () => {
    const agIds = antigravityRegistry.models.map(m => m.id);
    expect(agIds).toContain("gemini-3.7-flash-high");
    expect(agIds).toContain("gemini-3.7-flash-medium");
    expect(agIds).toContain("gemini-3.7-flash-low");
    expect(agIds).not.toContain("gemini-3.7-flash");
  });

  it("registers gemini-3.7-flash in gemini provider registry", () => {
    const geminiIds = geminiRegistry.models.map(m => m.id);
    expect(geminiIds).toContain("gemini-3.7-flash");
  });

  it("resolves capabilities correctly for gemini-3.7 models with official limits", () => {
    const caps = getCapabilitiesForModel("antigravity", "gemini-3.7-flash-high");
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("gemini-level");
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(65536);
  });

  it("defines pricing matching gemini-3.6-flash baseline", () => {
    expect(MODEL_PRICING["gemini-3.7-flash"]).toEqual(MODEL_PRICING["gemini-3.6-flash"]);
    expect(MODEL_PRICING["gemini-3.7-flash-high"]).toEqual(MODEL_PRICING["gemini-3.6-flash-high"]);
    expect(MODEL_PRICING["gemini-3.7-flash-medium"]).toEqual(MODEL_PRICING["gemini-3.6-flash-medium"]);
    expect(MODEL_PRICING["gemini-3.7-flash-low"]).toEqual(MODEL_PRICING["gemini-3.6-flash-low"]);
  });
});

describe("Gemini 3.7 Antigravity tiers", () => {
  it.each(["high", "medium", "low"])(
    "maps the %s tier to the shared upstream model with matching thinking level",
    (tier) => {
      const publicModel = `gemini-3.7-flash-${tier}`;
      const upstreamModel = getModelUpstreamId("ag", publicModel);
      const body = {
        model: stripThinkingSuffix(upstreamModel),
        request: {
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
          generationConfig: {},
        },
      };

      applyThinking("antigravity", upstreamModel, body, "antigravity");
      const finalBody = new AntigravityExecutor().transformRequest(
        publicModel,
        body,
        true,
        { projectId: "project", connectionId: "connection" }
      );

      expect(upstreamModel).toBe(`gemini-3.7-flash-tiered(${tier})`);
      expect(finalBody.model).toBe("gemini-3.7-flash-tiered");
      expect(finalBody.request.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: tier,
        includeThoughts: true,
      });
    }
  );
});

describe("Gemini 3.7 MITM model extraction", () => {
  it.each(["high", "medium", "low"])("extracts the %s thinking tier", (tier) => {
    const body = Buffer.from(JSON.stringify({
      request: { generationConfig: { thinkingConfig: { thinkingLevel: tier } } },
    }));

    expect(mitmConfig.extractModel(
      "/v1internal/models/gemini-3.7-flash-tiered:streamGenerateContent",
      body
    )).toBe(`gemini-3.7-flash-${tier}`);
  });

  it("defaults invalid or missing thinking levels to medium", () => {
    const body = Buffer.from(JSON.stringify({
      request: { generationConfig: { thinkingConfig: { thinkingLevel: "unknown" } } },
    }));

    expect(mitmConfig.extractModel(
      "/v1internal/models/gemini-3.7-flash-tiered:streamGenerateContent",
      body
    )).toBe("gemini-3.7-flash-medium");
  });
});
