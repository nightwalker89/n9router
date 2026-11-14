import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nextConfig from "../../next.config.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("MITM package dependencies", () => {
  it("retains MITM tracing includes alongside the upstream undici include", () => {
    const includes = Object.values(nextConfig.outputFileTracingIncludes).flat();
    expect(includes).toContain("src/mitm/**/*");
    expect(includes).toContain("src/shared/constants/**/*");
    expect(includes).toContain("src/lib/dbFileSafety.js");
    expect(includes).toContain("open-sse/rtk/**/*");
    expect(includes).toContain("./node_modules/undici/**/*");
  });

  it("loads the published token pool outside the source tree", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "n9router-mitm-package-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "src/lib"), { recursive: true });
    fs.cpSync(path.join(projectRoot, "src/mitm"), path.join(root, "src/mitm"), { recursive: true });
    fs.copyFileSync(path.join(projectRoot, "src/lib/dbFileSafety.js"), path.join(root, "src/lib/dbFileSafety.js"));
    // Only dependency resolution at build time can see the source node_modules.
    fs.symlinkSync(path.join(projectRoot, "node_modules"), path.join(root, "node_modules"), "dir");
    const script = fs.readFileSync(path.join(projectRoot, "scripts/publish-npm.sh"), "utf8");
    const copyFiles = script.slice(
      script.indexOf('mkdir -p .next/standalone/src/mitm'),
      script.indexOf('info "Cleaning standalone'),
    );
    const copyDependencies = script.slice(
      script.indexOf("node <<'NODE'", script.indexOf('info "Copying MITM-only runtime dependencies')),
      script.indexOf('ok "Build complete"'),
    );
    execFileSync("bash", ["-eu", "-c", copyFiles + copyDependencies], { cwd: root });
    fs.unlinkSync(path.join(root, "node_modules"));
    const app = path.join(root, ".next/standalone");
    const output = execFileSync(process.execPath, ["-e", `
      const pool = require('./src/mitm/tokenPool.js');
      if (typeof pool.getAllActiveConnections !== 'function') throw new Error('Token pool failed to load');
      console.log('loaded');
    `], { cwd: app, env: { ...process.env, NODE_PATH: "", DATA_DIR: path.join(root, "data") }, encoding: "utf8" });
    expect(output.trim()).toBe("loaded");
  });
});
