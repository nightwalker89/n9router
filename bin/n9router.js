#!/usr/bin/env node

/**
 * n9router CLI entry point.
 * Starts the pre-built Next.js standalone server bundled inside the package.
 *
 * Usage:
 *   n9router                  # start on default port 20128
 *   PORT=3000 n9router        # start on custom port
 */

const path = require("path");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");

const pkgRoot = path.join(__dirname, "..");
const standaloneServer = path.join(pkgRoot, ".next", "standalone", "server.js");

if (!fs.existsSync(standaloneServer)) {
  console.error(
    "[n9router] ERROR: The pre-built server was not found at:\n  " +
      standaloneServer +
      "\n\n" +
      "This usually means the package was published without running `npm run build` first,\n" +
      "or the .next/standalone directory was excluded from the package.\n\n" +
      "If you cloned the repo, run:\n  npm install && npm run build && node bin/n9router.js"
  );
  process.exit(1);
}

const port = process.env.PORT || "20128";
const hostname = process.env.HOSTNAME || "0.0.0.0";
const baseUrl =
  process.env.NEXT_PUBLIC_BASE_URL || `http://localhost:${port}`;

// The MITM server is a child process spawned at runtime — it is NOT bundled
// by Next.js. We copy it to .next/standalone/mitm/ during publish so it
// survives npm's src/ exclusion rules. Point manager.js straight at it.
const mitmServerPath = path.join(pkgRoot, ".next", "standalone", "mitm", "server.js");

console.log(`[n9router] Starting on ${baseUrl}`);

const child = spawn(
  process.execPath, // node
  [standaloneServer],
  {
    env: {
      ...process.env,
      PORT: port,
      HOSTNAME: hostname,
      NEXT_PUBLIC_BASE_URL: baseUrl,
      NODE_ENV: "production",
      ...(fs.existsSync(mitmServerPath) && { MITM_SERVER_PATH: mitmServerPath }),
    },
    stdio: "inherit",
    cwd: path.join(pkgRoot, ".next", "standalone"),
  }
);

child.on("exit", (code) => process.exit(code ?? 0));

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
