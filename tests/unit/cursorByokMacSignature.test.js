import { describe, expect, it } from "vitest";
import {
  compareMacRestoreBackupHashes,
  extractCodeResourcesSha256,
} from "../../src/lib/cursorByok/macSignature.js";

function makeCodeResources(relativePath, hashHex) {
  const hashBase64 = Buffer.from(hashHex, "hex").toString("base64");
  return `<?xml version="1.0" encoding="UTF-8"?>
  <plist version="1.0">
    <dict>
      <key>files2</key>
      <dict>
        <key>${relativePath}</key>
        <dict>
          <key>hash2</key>
          <data>${hashBase64}</data>
        </dict>
      </dict>
    </dict>
  </plist>`;
}

describe("Cursor BYOK macOS signature validation", () => {
  it("extracts the signed SHA-256 hash for a sealed resource", () => {
    const relativePath = "Resources/app/out/vs/workbench/workbench.desktop.main.js";
    const expectedHash = "2541dd152a9facf5ae708a0b5d8a90d3074d7432b92901cdb8d50926979746af";
    const xml = makeCodeResources(relativePath, expectedHash);

    expect(extractCodeResourcesSha256(xml, relativePath)).toBe(expectedHash);
  });

  it("rejects stale backups before restoring them into Cursor.app", () => {
    const result = compareMacRestoreBackupHashes([
      {
        targetPath: "/Applications/Cursor.app/Contents/Resources/app/workbench.js",
        backupPath: "/tmp/workbench.orig",
        expectedHash: "aaaa",
        backupHash: "bbbb",
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0].expectedHash).toBe("aaaa");
  });
});
