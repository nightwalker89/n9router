import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "module";
import os from "os";
import path from "path";
import fs from "fs";

const require = createRequire(import.meta.url);
const {
  recoverCorruptJsonFileSync,
  updateJsonFileSync,
} = require("../../src/lib/dbFileSafety.js");

const tempDirs = [];

function createTempDb(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-db-safety-"));
  tempDirs.push(dir);
  const dbFile = path.join(dir, "db.json");
  fs.writeFileSync(dbFile, JSON.stringify(data, null, 2));
  return dbFile;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("dbFileSafety", () => {
  it("updates JSON atomically and writes a valid backup", () => {
    const dbFile = createTempDb({ providerConnections: [{ id: "c1" }] });

    const result = updateJsonFileSync(dbFile, (db) => {
      db.providerConnections[0].lastUsedAt = "2026-04-24T00:00:00.000Z";
    });

    expect(result.updated).toBe(true);
    expect(JSON.parse(fs.readFileSync(dbFile, "utf-8")).providerConnections[0].lastUsedAt)
      .toBe("2026-04-24T00:00:00.000Z");
    expect(JSON.parse(fs.readFileSync(`${dbFile}.bak`, "utf-8")).providerConnections[0].lastUsedAt)
      .toBeUndefined();
  });

  it("restores corrupt JSON from the last valid backup", () => {
    const dbFile = createTempDb({ providerConnections: [{ id: "c1" }] });
    updateJsonFileSync(dbFile, (db) => {
      db.providerConnections.push({ id: "c2" });
    });
    fs.writeFileSync(dbFile, "{ broken json", "utf-8");

    const recovered = recoverCorruptJsonFileSync(dbFile);

    expect(recovered.restored).toBe(true);
    expect(recovered.corruptCopy).toContain("db.json.corrupt-");
    expect(fs.existsSync(recovered.corruptCopy)).toBe(true);
    expect(JSON.parse(fs.readFileSync(dbFile, "utf-8")).providerConnections)
      .toEqual([{ id: "c1" }]);
  });

  it("does not reset corrupt JSON when no valid backup exists", () => {
    const dbFile = createTempDb({ providerConnections: [{ id: "c1" }] });
    fs.rmSync(`${dbFile}.bak`, { force: true });
    fs.writeFileSync(dbFile, "{ broken json", "utf-8");

    expect(() => recoverCorruptJsonFileSync(dbFile)).toThrow(/No valid backup was available/);
    expect(fs.readFileSync(dbFile, "utf-8")).toBe("{ broken json");
  });
});
