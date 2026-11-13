import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractNpmErrorReason } from "../../open-sse/services/lazyRuntime.js";

const createdDirs = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop(), { recursive: true, force: true });
  }
});

describe("writableDataDir & lazyRuntime branding/error parsing", () => {
  it("falls back to ~/.n9router when DATA_DIR is unset", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "n9r-home-"));
    createdDirs.push(fakeHome);

    const moduleUrl = pathToFileURL(
      path.resolve(__dirname, "../../open-sse/utils/writableDataDir.js")
    ).href;
    const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
    delete env.DATA_DIR;

    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `import(${JSON.stringify(moduleUrl)}).then(({ getWritableDataDir }) => console.log(getWritableDataDir()));`,
      ],
      { env, encoding: "utf8" }
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(path.join(fakeHome, ".n9router"));
  });

  it("extracts the actionable npm v10+ error line instead of the debug log path", () => {
    const stderr = [
      "npm error code ENOTEMPTY",
      "npm error syscall rename",
      "npm error path /tmp/.n9router/runtime/node_modules/debug",
      "npm error dest /tmp/.n9router/runtime/node_modules/.debug-123",
      "npm error errno -66",
      "npm error ENOTEMPTY: directory not empty, rename '/tmp/.n9router/runtime/node_modules/debug'",
      "npm error A complete log of this run can be found in: /tmp/.npm/_logs/debug-0.log",
    ].join("\n");

    expect(extractNpmErrorReason(stderr)).toBe(
      "ENOTEMPTY: directory not empty, rename '/tmp/.n9router/runtime/node_modules/debug'"
    );
  });

  it("still parses legacy npm ERR! lines cleanly", () => {
    const stderr = "npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/missing\n";
    expect(extractNpmErrorReason(stderr)).toBe(
      "404 Not Found - GET https://registry.npmjs.org/missing"
    );
  });
});

