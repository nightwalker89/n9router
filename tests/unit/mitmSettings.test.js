import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const settingsPath = path.resolve("../src/mitm/mitmSettings.js");

const tempDirs = [];

function loadMitmSettings() {
  delete require.cache[require.resolve(settingsPath)];
  return require(settingsPath);
}

function createTempDb(settings) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "n9router-mitm-settings-"));
  tempDirs.push(tmpDir);
  const dbFile = path.join(tmpDir, "db.json");
  fs.writeFileSync(dbFile, JSON.stringify({ settings }, null, 2));
  return dbFile;
}

describe("mitmSettings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it("shares one cached db read across IDE version and host rewrite settings", () => {
    const helper = loadMitmSettings();
    const dbFile = createTempDb({
      mitmAntigravityIdeVersionOverrideEnabled: true,
      mitmAntigravityIdeVersion: "1.24.0",
      mitmAntigravityHostRewriteEnabled: true,
    });
    const readSpy = vi.spyOn(fs, "readFileSync");

    expect(helper.getAntigravityIdeVersionSettings(dbFile)).toEqual({
      enabled: true,
      version: "1.24.0",
    });
    expect(helper.getAntigravityHostRewriteTarget("cloudcode-pa.googleapis.com", dbFile))
      .toBe("daily-cloudcode-pa.googleapis.com");

    const dbReads = readSpy.mock.calls.filter(([file]) => file === dbFile);
    expect(dbReads).toHaveLength(1);
  });

  it("keeps host rewrite enabled by default and honors explicit disable", () => {
    const helper = loadMitmSettings();
    const defaultDb = createTempDb({});
    const disabledDb = createTempDb({
      mitmAntigravityHostRewriteEnabled: false,
    });

    expect(helper.getAntigravityHostRewriteTarget("cloudcode-pa.googleapis.com", defaultDb))
      .toBe("daily-cloudcode-pa.googleapis.com");
    expect(helper.getAntigravityHostRewriteTarget("cloudcode-pa.googleapis.com", disabledDb))
      .toBe("cloudcode-pa.googleapis.com");
    expect(helper.getAntigravityHostRewriteTarget("example.com", defaultDb))
      .toBe("example.com");
  });

  it("reloads settings after cache reset", () => {
    const helper = loadMitmSettings();
    const dbFile = createTempDb({
      mitmAntigravityIdeVersionOverrideEnabled: false,
      mitmAntigravityIdeVersion: "1.23.2",
    });

    expect(helper.getAntigravityIdeVersionSettings(dbFile).enabled).toBe(false);

    fs.writeFileSync(dbFile, JSON.stringify({
      settings: {
        mitmAntigravityIdeVersionOverrideEnabled: true,
        mitmAntigravityIdeVersion: "1.25.0",
      },
    }));
    helper.resetMitmSettingsCache(dbFile);

    expect(helper.getAntigravityIdeVersionSettings(dbFile)).toEqual({
      enabled: true,
      version: "1.25.0",
    });
  });
});
