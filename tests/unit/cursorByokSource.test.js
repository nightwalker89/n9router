import { describe, expect, it } from "vitest";
import { getLatestCursorByokSource } from "../../src/lib/cursorByok/source.js";

describe("Cursor BYOK source resolution", () => {
  it("resolves the current main commit and uses its immutable tarball URL", async () => {
    const sha = "a".repeat(40);
    const source = await getLatestCursorByokSource({
      request: async (url) => {
        expect(url).toBe("https://api.github.com/repos/nightwalker89/cursor-byok/commits/main");
        return { sha };
      },
    });

    expect(source).toEqual({
      branch: "main",
      ref: sha,
      tarballUrl: `https://codeload.github.com/nightwalker89/cursor-byok/tar.gz/${sha}`,
    });
  });

  it("rejects an invalid commit response rather than installing an unverified ref", async () => {
    await expect(getLatestCursorByokSource({
      request: async () => ({ sha: "main" }),
    })).rejects.toThrow("valid commit SHA");
  });
});
