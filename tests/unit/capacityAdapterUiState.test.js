import { describe, expect, it } from "vitest";
import { removeCapacityAdapterModel, enableCapacityAdapter } from "@/shared/utils/capacityAdapterState";

describe("capacity adapter model controls", () => {
  it("removes the final model and disables its adapter", () => {
    expect(removeCapacityAdapterModel({ enabled: true, roundRobin: true, models: ["oc/mimo-v2.5-free"] }, 0))
      .toEqual({ enabled: false, roundRobin: false, models: [] });
  });

  it("restores the default fallback only when the user re-enables an empty adapter", () => {
    expect(enableCapacityAdapter({ enabled: false, roundRobin: false, models: [] }, "oc/mimo-v2.5-free"))
      .toEqual({ enabled: true, roundRobin: false, models: ["oc/mimo-v2.5-free"] });
  });
});
