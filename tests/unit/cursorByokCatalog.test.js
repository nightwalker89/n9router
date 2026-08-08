import { describe, expect, it } from "vitest";
import { CLI_TOOLS } from "../../src/shared/constants/cliTools.js";

describe("Cursor BYOK CLI-tools catalog", () => {
  it("keeps the guided installer visible in the CLI-tools dashboard", () => {
    expect(CLI_TOOLS["cursor-byok"]).toMatchObject({
      id: "cursor-byok",
      name: "Cursor BYOK",
      configType: "custom",
    });
  });
});
