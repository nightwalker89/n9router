import { describe, it, expect } from "vitest";
import {
  appendMappingEntry,
  commitMappingEntryInput,
  normalizeMappingList,
  normalizeMappingState,
  normalizeStrategyValue,
  removeMappingEntry,
  reorderMappingEntry,
  updateMappingEntry,
} from "../../src/app/(dashboard)/dashboard/cli-tools/components/mitmMappingState.js";

describe("mitmMappingState", () => {
  it("normalizes strings and arrays into trimmed lists", () => {
    expect(normalizeMappingList(" cx/gpt-5.4 ")).toEqual(["cx/gpt-5.4"]);
    expect(normalizeMappingList([" a ", "", "b"])) .toEqual(["a", "b"]);
  });

  it("normalizes state into alias arrays", () => {
    expect(normalizeMappingState({
      a: "x",
      b: [" y ", "z"],
      c: "",
    })).toEqual({
      a: ["x"],
      b: ["y", "z"],
    });
  });

  it("appends values until the max cap", () => {
    let state = {};
    for (let index = 0; index < 6; index += 1) {
      state = appendMappingEntry(state, "a", `m${index}`);
    }
    expect(state.a).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  it("updates and removes list entries", () => {
    const updated = updateMappingEntry({ a: ["m1", "m2"] }, "a", 1, "m3");
    expect(updated.a).toEqual(["m1", "m3"]);

    const removed = removeMappingEntry(updated, "a", 0);
    expect(removed.a).toEqual(["m3"]);

    const emptied = removeMappingEntry(removed, "a", 0);
    expect(emptied).toEqual({});
  });

  it("reorders entries and ignores invalid moves", () => {
    expect(reorderMappingEntry({ a: ["m1", "m2", "m3"] }, "a", 0, 2).a).toEqual(["m2", "m3", "m1"]);
    expect(reorderMappingEntry({ a: ["m1", "m2"] }, "a", 2, 0)).toEqual({ a: ["m1", "m2"] });
  });

  it("normalizes strategy values", () => {
    expect(normalizeStrategyValue("fallback")).toBe("fallback");
    expect(normalizeStrategyValue("weird")).toBe("round-robin");
  });

  it("expands comma-separated blur input and enforces cap", () => {
    expect(commitMappingEntryInput({ a: ["seed"] }, "a", 0, "m1, m2, m3")).toEqual({
      a: ["m1", "m2", "m3"],
    });

    expect(commitMappingEntryInput({ a: ["x1", "x2", "x3", "x4", "x5"] }, "a", 4, "y1, y2")).toEqual({
      a: ["x1", "x2", "x3", "x4", "y1"],
    });
  });
});
