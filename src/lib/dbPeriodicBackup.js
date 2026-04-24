const fs = require("fs");
const path = require("path");
const lockfile = require("proper-lockfile");
const { LOCK_OPTIONS } = require("./dbFileSafety.js");

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const BACKUP_GLOBAL_KEY = "__n9routerDbPeriodicBackup";

function toSafeTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function getBackupDir(dbFile) {
  return path.join(path.dirname(dbFile), "backups", "db");
}

function getBackupFile(dbFile, now = new Date()) {
  const hour = new Date(now);
  hour.setMinutes(0, 0, 0);
  return path.join(getBackupDir(dbFile), `db-${toSafeTimestamp(hour)}.json`);
}

async function writeTextAtomic(file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );

  try {
    await fs.promises.writeFile(tmp, text, "utf-8");
    await fs.promises.rename(tmp, file);
  } catch (error) {
    try {
      await fs.promises.rm(tmp, { force: true });
    } catch { }
    throw error;
  }
}

async function pruneExpiredBackups(dbFile, options = {}) {
  const nowMs = options.now ? options.now.getTime() : Date.now();
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const backupDir = options.backupDir || getBackupDir(dbFile);

  let entries = [];
  try {
    entries = await fs.promises.readdir(backupDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }

  let deleted = 0;
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !/^db-.+\.json$/.test(entry.name)) return;

    const file = path.join(backupDir, entry.name);
    const stat = await fs.promises.stat(file);
    if (nowMs - stat.mtimeMs <= retentionMs) return;

    await fs.promises.rm(file, { force: true });
    deleted += 1;
  }));

  return deleted;
}

async function performDbBackup(dbFile, options = {}) {
  if (!dbFile || !fs.existsSync(dbFile)) {
    return { backedUp: false, reason: "missing-db" };
  }

  const now = options.now || new Date();
  const backupDir = options.backupDir || getBackupDir(dbFile);
  const backupFile = options.backupFile || getBackupFile(dbFile, now);

  await fs.promises.mkdir(backupDir, { recursive: true });

  let release = null;
  try {
    release = await lockfile.lock(dbFile, LOCK_OPTIONS);

    if (fs.existsSync(backupFile)) {
      await pruneExpiredBackups(dbFile, { ...options, backupDir });
      return { backedUp: false, reason: "already-backed-up", backupFile };
    }

    const text = await fs.promises.readFile(dbFile, "utf-8");
    try {
      JSON.parse(text);
    } catch {
      return { backedUp: false, reason: "invalid-json" };
    }
    await writeTextAtomic(backupFile, text);
  } finally {
    if (release) {
      try { await release(); } catch { }
    }
  }

  await pruneExpiredBackups(dbFile, { ...options, backupDir });
  return { backedUp: true, backupFile };
}

function startDbPeriodicBackups(dbFile, options = {}) {
  if (!dbFile || typeof globalThis === "undefined" || options.enabled === false) return null;

  const state = globalThis[BACKUP_GLOBAL_KEY];
  if (state?.dbFile === dbFile && state?.timer) return state.timer;
  if (state?.timer) clearInterval(state.timer);

  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const run = () => {
    performDbBackup(dbFile, options).catch((error) => {
      console.warn(`[DB] Periodic backup failed: ${error.message}`);
    });
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();

  globalThis[BACKUP_GLOBAL_KEY] = { dbFile, timer };
  return timer;
}

function stopDbPeriodicBackups() {
  if (typeof globalThis === "undefined") return false;

  const state = globalThis[BACKUP_GLOBAL_KEY];
  if (!state?.timer) return false;

  clearInterval(state.timer);
  globalThis[BACKUP_GLOBAL_KEY] = null;
  return true;
}

function isPeriodicBackupEnabledInFile(dbFile) {
  try {
    if (!dbFile || !fs.existsSync(dbFile)) return true;
    const db = JSON.parse(fs.readFileSync(dbFile, "utf-8"));
    return db.settings?.periodicDbBackupsEnabled !== false;
  } catch {
    return false;
  }
}

function configureDbPeriodicBackups(dbFile, enabled, options = {}) {
  if (enabled === false) {
    stopDbPeriodicBackups();
    return null;
  }

  return startDbPeriodicBackups(dbFile, options);
}

function startConfiguredDbPeriodicBackups(dbFile, options = {}) {
  return configureDbPeriodicBackups(dbFile, isPeriodicBackupEnabledInFile(dbFile), options);
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  DEFAULT_RETENTION_MS,
  configureDbPeriodicBackups,
  getBackupDir,
  getBackupFile,
  isPeriodicBackupEnabledInFile,
  performDbBackup,
  pruneExpiredBackups,
  startConfiguredDbPeriodicBackups,
  startDbPeriodicBackups,
  stopDbPeriodicBackups,
};
