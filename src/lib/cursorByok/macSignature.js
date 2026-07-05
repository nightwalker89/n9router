import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function extractCodeResourcesSha256(xml, relativePath) {
  const keyTag = `<key>${escapeXml(relativePath)}</key>`;
  let offset = 0;
  while (offset < xml.length) {
    const keyIndex = xml.indexOf(keyTag, offset);
    if (keyIndex < 0) return null;
    const section = xml.slice(keyIndex + keyTag.length, keyIndex + keyTag.length + 1200);
    const match = section.match(/<key>hash2<\/key>\s*<data>\s*([^<]+?)\s*<\/data>/);
    if (match) {
      return Buffer.from(match[1].replace(/\s+/g, ""), "base64").toString("hex");
    }
    offset = keyIndex + keyTag.length;
  }
  return null;
}

export function compareMacRestoreBackupHashes(entries) {
  const mismatches = entries.filter((entry) => (
    !entry.expectedHash ||
    !entry.backupHash ||
    entry.expectedHash.toLowerCase() !== entry.backupHash.toLowerCase()
  ));
  return { ok: mismatches.length === 0, mismatches };
}

async function sha256File(targetPath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(targetPath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function readCodeResourcesXml(cursorRoot) {
  const codeResourcesPath = path.join(cursorRoot, "Contents", "_CodeSignature", "CodeResources");
  const result = spawnSync(
    "plutil",
    ["-convert", "xml1", "-o", "-", codeResourcesPath],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0 || !result.stdout) {
    throw new Error(result.stderr?.trim() || "Unable to read Cursor code-signature manifest");
  }
  return result.stdout;
}

function toCodeResourcesPath(cursorRoot, targetPath) {
  const contentsRoot = path.join(cursorRoot, "Contents");
  const relative = path.relative(contentsRoot, targetPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Restore target is outside Cursor.app: ${targetPath}`);
  }
  return relative.split(path.sep).join("/");
}

export async function validateMacRestoreBackups(installation, restoreState) {
  if (process.platform !== "darwin") return;
  const xml = readCodeResourcesXml(installation.cursorRoot);
  const entries = [];
  for (const mapping of restoreState.mappedBackups) {
    if (!mapping.exists) continue;
    const relativePath = toCodeResourcesPath(installation.cursorRoot, mapping.targetPath);
    entries.push({
      targetPath: mapping.targetPath,
      backupPath: mapping.backupPath,
      expectedHash: extractCodeResourcesSha256(xml, relativePath),
      backupHash: await sha256File(mapping.backupPath),
    });
  }
  const comparison = compareMacRestoreBackupHashes(entries);
  if (!comparison.ok) {
    const names = comparison.mismatches
      .map((entry) => path.basename(entry.targetPath))
      .join(", ");
    const error = new Error(
      `Saved backup does not match the current signed Cursor bundle (${names}). Reinstall Cursor ${await getMacCursorVersion(installation.cursorRoot)} instead of restoring this stale backup.`,
    );
    error.code = "STALE_CURSOR_BACKUP";
    throw error;
  }
}

export function verifyMacCursorCodeSignature(installation) {
  if (process.platform !== "darwin") return;
  const result = spawnSync(
    "codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", installation.cursorRoot],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    const error = new Error(
      "Cursor.app code signature is invalid. Reinstall Cursor before installing or restoring Cursor BYOK.",
    );
    error.code = "CURSOR_SIGNATURE_INVALID";
    throw error;
  }
}

async function getMacCursorVersion(cursorRoot) {
  try {
    const plistPath = path.join(cursorRoot, "Contents", "Info.plist");
    const result = spawnSync(
      "defaults",
      ["read", plistPath, "CFBundleShortVersionString"],
      { encoding: "utf8" },
    );
    return result.status === 0 && result.stdout.trim()
      ? `version ${result.stdout.trim()}`
      : "from the official installer";
  } catch {
    return "from the official installer";
  }
}
