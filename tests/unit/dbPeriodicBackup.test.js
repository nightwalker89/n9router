import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "module";
import os from "os";
import path from "path";
import fs from "fs";

const require = createRequire(import.meta.url);
const {
  DEFAULT_RETENTION_MS,
  configureDbPeriodicBackups,
  getBackupFile,
  isPeriodicBackupEnabledInFile,
  performDbBackup,
  pruneExpiredBackups,
  stopDbPeriodicBackups,
} = require("../../src/lib/dbPeriodicBackup.js");

const tempDirs = [];

function createTempDb(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-db-backup-"));
  tempDirs.push(dir);
  const dbFile = path.join(dir, "db.json");
  fs.writeFileSync(dbFile, JSON.stringify(data, null, 2));
  return dbFile;
}

afterEach(() => {
  stopDbPeriodicBackups();
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("dbPeriodicBackup", () => {
  it("creates one backup for the current hour", async () => {
    const dbFile = createTempDb({ providerConnections: [{ id: "c1" }] });
    const now = new Date("2026-04-24T15:35:12.000Z");

    const result = await performDbBackup(dbFile, { now });

    expect(result.backedUp).toBe(true);
    expect(result.backupFile).toBe(getBackupFile(dbFile, now));
    expect(JSON.parse(fs.readFileSync(result.backupFile, "utf-8")).providerConnections)
      .toEqual([{ id: "c1" }]);
  });

  it("skips duplicate backups in the same hour", async () => {
    const dbFile = createTempDb({ providerConnections: [{ id: "c1" }] });
    const first = await performDbBackup(dbFile, { now: new Date("2026-04-24T15:05:00.000Z") });
    const second = await performDbBackup(dbFile, { now: new Date("2026-04-24T15:55:00.000Z") });

    expect(first.backedUp).toBe(true);
    expect(second).toMatchObject({
      backedUp: false,
      reason: "already-backed-up",
      backupFile: first.backupFile,
    });
  });

  it("prunes backups older than the retention window", async () => {
    const dbFile = createTempDb({ providerConnections: [{ id: "c1" }] });
    const backupDir = path.dirname(getBackupFile(dbFile, new Date("2026-04-24T15:00:00.000Z")));
    fs.mkdirSync(backupDir, { recursive: true });

    const expired = path.join(backupDir, "db-expired.json");
    const fresh = path.join(backupDir, "db-fresh.json");
    fs.writeFileSync(expired, "{}");
    fs.writeFileSync(fresh, "{}");

    const now = new Date("2026-04-24T15:00:00.000Z");
    fs.utimesSync(expired, now.getTime() / 1000, (now.getTime() - DEFAULT_RETENTION_MS - 1000) / 1000);
    fs.utimesSync(fresh, now.getTime() / 1000, (now.getTime() - DEFAULT_RETENTION_MS + 1000) / 1000);

    const deleted = await pruneExpiredBackups(dbFile, { now });

    expect(deleted).toBe(1);
    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("does not back up invalid JSON", async () => {
    const dbFile = createTempDb({ providerConnections: [{ id: "c1" }] });
    fs.writeFileSync(dbFile, "{ broken json", "utf-8");

    const result = await performDbBackup(dbFile, { now: new Date("2026-04-24T15:00:00.000Z") });

    expect(result).toEqual({ backedUp: false, reason: "invalid-json" });
    expect(fs.existsSync(getBackupFile(dbFile, new Date("2026-04-24T15:00:00.000Z")))).toBe(false);
  });

  it("reads periodic backup enabled flag from db settings", () => {
    const dbFile = createTempDb({
      providerConnections: [],
      settings: { periodicDbBackupsEnabled: false },
    });

    expect(isPeriodicBackupEnabledInFile(dbFile)).toBe(false);

    fs.writeFileSync(dbFile, JSON.stringify({ settings: { periodicDbBackupsEnabled: true } }));
    expect(isPeriodicBackupEnabledInFile(dbFile)).toBe(true);
  });

  it("does not start a timer when periodic backups are disabled", () => {
    const dbFile = createTempDb({ providerConnections: [] });

    expect(configureDbPeriodicBackups(dbFile, false)).toBeNull();
  });
});
