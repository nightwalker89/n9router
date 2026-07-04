#!/usr/bin/env node

// Postinstall: warm up the native usage-limiter dependency in
// ~/.n9router/runtime. Failure here is non-fatal —
// cli.js will retry at runtime if anything is missing.
const { ensureSqliteRuntime } = require("./sqliteRuntime");
const { ensureTrayRuntime } = require("./trayRuntime");

try {
  ensureSqliteRuntime({ silent: false });
  console.log("[n9router] native runtime dependency ready");
} catch (e) {
  console.warn(`[n9router] runtime warm-up skipped: ${e.message}`);
}

try {
  ensureTrayRuntime({ silent: false });
} catch (e) {
  console.warn(`[n9router] tray runtime skipped: ${e.message}`);
}

process.exit(0);
