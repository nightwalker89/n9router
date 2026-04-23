import { describe, it, expect } from "vitest";
import {
  DEFAULT_MITM_ALIAS_STRATEGY,
  MAX_MITM_ALIAS_MODELS,
  normalizeMitmAliasMappings,
  normalizeMitmAliasStrategy,
} from "../../src/lib/mitmAlias.js";

describe("mitmAlias helpers", () => {
  it("normalizes string mappings into arrays", () => {
    expect(normalizeMitmAliasMappings({ opus: "cx/gpt-5.4" })).toEqual({
      opus: ["cx/gpt-5.4"],
    });
  });

  it("trims array values and enforces the max model cap", () => {
    const result = normalizeMitmAliasMappings({
      opus: [" a ", "", "b", "c", "d", "e", "f"],
    });

    expect(result).toEqual({
      opus: ["a", "b", "c", "d", "e"],
    });
    expect(result.opus).toHaveLength(MAX_MITM_ALIAS_MODELS);
  });

  it("drops empty aliases and unsupported value types", () => {
    expect(normalizeMitmAliasMappings({
      empty: "   ",
      bad: 123,
      ok: ["model-1"],
    })).toEqual({
      ok: ["model-1"],
    });
  });

  it("defaults strategy to round-robin", () => {
    expect(normalizeMitmAliasStrategy(undefined)).toBe(DEFAULT_MITM_ALIAS_STRATEGY);
    expect(normalizeMitmAliasStrategy("weird")).toBe(DEFAULT_MITM_ALIAS_STRATEGY);
  });

  it("preserves fallback strategy", () => {
    expect(normalizeMitmAliasStrategy("fallback")).toBe("fallback");
  });
});
