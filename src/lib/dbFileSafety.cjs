const fs = require("fs");
const path = require("path");
const lockfile = require("proper-lockfile");

const LOCK_OPTIONS = {
  retries: { retries: 15, minTimeout: 50, maxTimeout: 3000 },
  stale: 10000,
};

const SYNC_LOCK_OPTIONS = {
  stale: LOCK_OPTIONS.stale,
};

function sleepSync(ms) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function lockSyncWithRetries(file) {
  const { retries, minTimeout, maxTimeout } = LOCK_OPTIONS.retries;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return lockfile.lockSync(file, SYNC_LOCK_OPTIONS);
    } catch (error) {
      lastError = error;
      if (error.code !== "ELOCKED" || attempt === retries) throw error;
      sleepSync(Math.min(minTimeout * (attempt + 1), maxTimeout));
    }
  }

  throw lastError;
}

function makeTempPath(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  return path.join(dir, `.${base}.${suffix}.tmp`);
}

function makeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseJsonText(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    error.message = `${label}: ${error.message}`;
    throw error;
  }
}

function writeTextAtomicSync(file, text) {
  const tmp = makeTempPath(file);
  try {
    fs.writeFileSync(tmp, text, "utf-8");
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    } catch { }
    throw error;
  }
}

function writeJsonAtomicSync(file, data) {
  writeTextAtomicSync(file, JSON.stringify(data, null, 2));
}

function createValidBackupSync(file, rawText = null) {
  if (!fs.existsSync(file)) return null;

  const text = rawText ?? fs.readFileSync(file, "utf-8");
  parseJsonText(text, file);

  const backupFile = `${file}.bak`;
  writeTextAtomicSync(backupFile, text);
  return backupFile;
}

function updateJsonFileSync(file, patchFn) {
  if (!fs.existsSync(file)) return { updated: false, data: null };

  let release = null;
  try {
    release = lockSyncWithRetries(file);
    const rawText = fs.readFileSync(file, "utf-8");
    const data = parseJsonText(rawText, file);
    const result = patchFn(data);

    if (result === false) return { updated: false, data };

    createValidBackupSync(file, rawText);
    writeJsonAtomicSync(file, data);
    return { updated: true, data };
  } finally {
    if (release) {
      try { release(); } catch { }
    }
  }
}

function recoverCorruptJsonFileSync(file) {
  let release = null;
  try {
    release = lockSyncWithRetries(file);

    const currentText = fs.readFileSync(file, "utf-8");
    try {
      return {
        data: JSON.parse(currentText),
        restored: false,
        source: file,
        corruptCopy: null,
      };
    } catch { }

    const corruptCopy = `${file}.corrupt-${makeTimestamp()}`;
    fs.writeFileSync(corruptCopy, currentText, "utf-8");

    const backupFile = `${file}.bak`;
    if (fs.existsSync(backupFile)) {
      try {
        const backupText = fs.readFileSync(backupFile, "utf-8");
        const backupData = parseJsonText(backupText, backupFile);
        writeTextAtomicSync(file, backupText);
        return {
          data: backupData,
          restored: true,
          source: backupFile,
          corruptCopy,
        };
      } catch { }
    }

    throw new Error(
      `[DB] Corrupt JSON detected at ${file}. Saved corrupt copy to ${corruptCopy}. ` +
      "No valid backup was available, so the database was not reset."
    );
  } finally {
    if (release) {
      try { release(); } catch { }
    }
  }
}

module.exports = {
  LOCK_OPTIONS,
  createValidBackupSync,
  recoverCorruptJsonFileSync,
  updateJsonFileSync,
  writeJsonAtomicSync,
};
