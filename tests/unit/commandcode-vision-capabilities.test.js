/**
 * CommandCode vision capability resolution.
 *
 * Every expectation below was verified live against api.commandcode.ai
 * (2026-09-04) by sending a two-colour test image and checking whether the
 * model described it or replied "I don't see an image attached".
 *
 * getCapabilitiesForModel drives stripUnsupportedModalities, so a false
 * negative here silently replaces the user's image with a text placeholder.
 */
import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

const VISION_MODELS = [
  "deepseek/deepseek-v4-flash-vision-exp",
  "z-ai/glm-5.3-flash",
  "Qwen/Qwen3.8-Flash",
  "Qwen/Qwen3.8-Max",
  "moonshotai/Kimi-K2.6",
  "moonshotai/Kimi-K2.5",
  "Qwen/Qwen3.6-Plus",
];

const TEXT_ONLY_MODELS = [
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "zai-org/GLM-5.1",
  "zai-org/GLM-5",
  "MiniMaxAI/MiniMax-M2.5",
  "Qwen/Qwen3.6-Max-Preview",
  "stepfun/Step-3.5-Flash",
];

describe("CommandCode model vision capabilities", () => {
  it.each(VISION_MODELS)("reports vision support for %s", (model) => {
    expect(getCapabilitiesForModel("commandcode", model).vision).toBe(true);
  });

  it.each(TEXT_ONLY_MODELS)("reports no vision support for %s", (model) => {
    expect(getCapabilitiesForModel("commandcode", model).vision).toBe(false);
  });
});

describe("vision pattern ordering is not over-broad", () => {
  it("keeps plain GLM 5.x text-only (only the 5.3 flash variant reads images)", () => {
    for (const model of ["glm-5.3", "glm-5.2", "glm-5.1", "glm-5"]) {
      expect(getCapabilitiesForModel(null, model).vision).toBe(false);
    }
  });

  it("keeps Qwen coder and older max variants text-only", () => {
    for (const model of ["qwen3.8-coder-plus", "qwen-max", "qwen3.6-max-preview"]) {
      expect(getCapabilitiesForModel(null, model).vision).toBe(false);
    }
  });

  it("preserves the existing GLM and Qwen vision variants", () => {
    expect(getCapabilitiesForModel(null, "glm-4.6v").vision).toBe(true);
    expect(getCapabilitiesForModel(null, "qwen3.6-vl-72b").vision).toBe(true);
    expect(getCapabilitiesForModel(null, "qwen3.5-plus").vision).toBe(true);
  });

  it("does not change thinking format or limits when lifting the vision flag", () => {
    const glm = getCapabilitiesForModel("commandcode", "z-ai/glm-5.3-flash");
    expect(glm.thinkingFormat).toBe("zai");
    expect(glm.contextWindow).toBe(200000);

    const max = getCapabilitiesForModel("commandcode", "Qwen/Qwen3.8-Max");
    expect(max.thinkingFormat).toBe("qwen");
    expect(max.contextWindow).toBe(1000000);
    expect(max.maxOutput).toBe(65536);
  });
});

describe("CommandCode registry lists the vision models", () => {
  it("exposes every verified vision model as a selectable model id", async () => {
    const { default: registry } = await import("../../open-sse/providers/registry/commandcode.js");
    const ids = registry.models.map((m) => m.id);
    for (const model of ["deepseek/deepseek-v4-flash-vision-exp", "z-ai/glm-5.3-flash",
                         "Qwen/Qwen3.8-Flash", "Qwen/Qwen3.8-Max"]) {
      expect(ids).toContain(model);
    }
  });
});
