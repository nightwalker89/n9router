import { describe, expect, it } from "vitest";
import {
  MAX_MITM_MODEL_NAME_LENGTH,
  normalizeMitmModelNameOverrides,
  normalizeMitmModelNameSettings,
} from "../../src/lib/mitmModelNames.js";

describe("mitmModelNames helpers", () => {
  it("trims ids and names", () => {
    expect(normalizeMitmModelNameOverrides({
      " gemini-3.1-pro-high ": " Custom Pro ",
    })).toEqual({
      "gemini-3.1-pro-high": "Custom Pro",
    });
  });

  it("drops empty names and unsupported value types", () => {
    expect(normalizeMitmModelNameOverrides({
      ok: "Shown",
      empty: "   ",
      bad: 123,
    })).toEqual({
      ok: "Shown",
    });
  });

  it("filters by allowed model ids", () => {
    expect(normalizeMitmModelNameOverrides({
      known: "Known",
      unknown: "Unknown",
    }, ["known"])).toEqual({
      known: "Known",
    });
  });

  it("caps display names", () => {
    const longName = "x".repeat(MAX_MITM_MODEL_NAME_LENGTH + 10);
    const result = normalizeMitmModelNameOverrides({ known: longName });

    expect(result.known).toHaveLength(MAX_MITM_MODEL_NAME_LENGTH);
  });

  it("normalizes settings by tool", () => {
    expect(normalizeMitmModelNameSettings({
      mitmModelNameOverrides: {
        antigravity: { model: " Name " },
        bad: null,
      },
    })).toEqual({
      antigravity: { model: "Name" },
    });
  });
});
