#!/usr/bin/env node

/**
 * n9router CLI entry point.
 * Starts the pre-built Next.js standalone server bundled inside the package.
 *
 * Usage:
 *   n9router                  # start on default port 20128
 *   PORT=3000 n9router        # start on custom port
 *   n9router --version        # show current version
 *   n9router --update         # check for updates and install if available
 */

const path = require("path");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const https = require("https");

const pkgRoot = path.join(__dirname, "..");
const pkg = require(path.join(pkgRoot, "package.json"));
const PACKAGE_NAME = pkg.name; // "n9router"
const CURRENT_VERSION = pkg.version;

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Fetch the latest version from the npm registry.
 * Returns a promise that resolves to the version string.
 */
function fetchLatestVersion() {
  return new Promise((resolve, reject) => {
    const url = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
    https
      .get(url, { headers: { Accept: "application/json" } }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json.version || null);
          } catch {
            reject(new Error("Failed to parse registry response"));
          }
        });
      })
      .on("error", reject);
  });
}

/**
 * Compare two semver strings. Returns:
 *   1  if a > b
 *  -1  if a < b
 *   0  if equal
 */
function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function resolveAppRoot() {
  const candidates = [
    path.join(pkgRoot, "app"),
    path.join(pkgRoot, ".next", "standalone"),
  ];

  return candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "server.js"))
  );
}

// ── --version ────────────────────────────────────────────────────────

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`n9router v${CURRENT_VERSION}`);
  process.exit(0);
}

// ── --update ─────────────────────────────────────────────────────────

if (process.argv.includes("--update")) {
  (async () => {
    console.log(`[n9router] Current version: v${CURRENT_VERSION}`);
    console.log("[n9router] Checking for updates...");

    try {
      const latest = await fetchLatestVersion();
      if (!latest) {
        console.log("[n9router] Could not determine latest version.");
        process.exit(1);
      }

      if (compareSemver(latest, CURRENT_VERSION) > 0) {
        console.log(`[n9router] New version available: v${latest}`);
        console.log(`[n9router] Updating via: npm i -g ${PACKAGE_NAME}@${latest}`);
        try {
          execFileSync("npm", ["i", "-g", `${PACKAGE_NAME}@${latest}`], {
            stdio: "inherit",
          });
          console.log(`[n9router] ✅ Successfully updated to v${latest}`);
        } catch {
          console.error("[n9router] ❌ Update failed. Try manually:");
          console.error(`  npm i -g ${PACKAGE_NAME}@${latest}`);
          process.exit(1);
        }
      } else {
        console.log(`[n9router] Already on the latest version (v${CURRENT_VERSION}).`);
      }
    } catch (err) {
      console.error("[n9router] Failed to check for updates:", err.message);
      process.exit(1);
    }
  })();

  // prevent fall-through to server start
  return;
}

// ── Start server ─────────────────────────────────────────────────────

const appRoot = resolveAppRoot();
const standaloneServer = appRoot && path.join(appRoot, "server.js");

if (!standaloneServer || !fs.existsSync(standaloneServer)) {
  console.error(
    "[n9router] ERROR: The pre-built server was not found in:\n" +
      "  " + path.join(pkgRoot, "app", "server.js") + "\n" +
      "  " + path.join(pkgRoot, ".next", "standalone", "server.js") +
      "\n\n" +
      "This usually means the package was published without running `npm run build` first,\n" +
      "or the standalone app directory was excluded from the package.\n\n" +
      "If you cloned the repo, run:\n  npm install && npm run build && node bin/n9router.js"
  );
  process.exit(1);
}

const port = process.env.PORT || "20128";
const hostname = process.env.HOSTNAME || "0.0.0.0";
const baseUrl =
  process.env.NEXT_PUBLIC_BASE_URL || `http://localhost:${port}`;

// The MITM server is a child process spawned at runtime — it is NOT bundled
// by Next.js. We copy it into the standalone app during publish so it
// survives npm's src/ exclusion rules. Point manager.js straight at it.
const mitmServerPath = [
  path.join(appRoot, "src", "mitm", "server.js"),
  path.join(appRoot, "mitm", "server.js"),
].find((candidate) => fs.existsSync(candidate));

console.log(`[n9router] Starting v${CURRENT_VERSION} on ${baseUrl}`);

// Non-blocking update check on startup
fetchLatestVersion()
  .then((latest) => {
    if (latest && compareSemver(latest, CURRENT_VERSION) > 0) {
      console.log("");
      console.log("  ╔══════════════════════════════════════════════════╗");
      console.log(`  ║  🚀 New version available: v${latest.padEnd(22)}║`);
      console.log(`  ║     Current version:  v${CURRENT_VERSION.padEnd(25)}║`);
      console.log("  ║                                                  ║");
      console.log("  ║  Run: n9router --update                          ║");
      console.log("  ╚══════════════════════════════════════════════════╝");
      console.log("");
    }
  })
  .catch(() => {
    // silently ignore — don't disrupt startup
  });

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
      ...(mitmServerPath && { MITM_SERVER_PATH: mitmServerPath }),
    },
    stdio: "inherit",
    cwd: appRoot,
  }
);

child.on("exit", (code) => process.exit(code ?? 0));

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
