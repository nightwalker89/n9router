import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const componentUrl = new URL(
  "../../src/app/(dashboard)/dashboard/usage/components/OverviewCards.js",
  import.meta.url,
);

describe("OverviewCards", () => {
  it("renders cached tokens as one metric card", async () => {
    const source = await readFile(fileURLToPath(componentUrl), "utf8");
    const cachedTokenLabels = source.match(/>Cached Tokens</g) || [];

    expect(cachedTokenLabels).toHaveLength(1);
  });
});
