import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { DATA_DIR } from "@/lib/dataDir";
import { DATA_FILE } from "@/lib/db/paths.js";
import { patchMitmSettingsCache } from "@/lib/mitmSettingsCache";
import { createRequire } from "node:module";
import { setRtkEnabled } from "open-sse/rtk/index.js";
import { resetComboRotation } from "open-sse/services/combo.js";
import bcrypt from "bcryptjs";
import path from "path";

const require = createRequire(import.meta.url);
const { configureDbPeriodicBackups } = require("../../../lib/dbPeriodicBackup.js");
const MITM_ANTIGRAVITY_DEBUG_LOG_DIR = path.join(DATA_DIR, "mitm", "logs", "antigravity");

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    return NextResponse.json({ 
      ...safeSettings, 
      enableRequestLogs,
      enableTranslator,
      mitmAntigravityDebugLogDir: MITM_ANTIGRAVITY_DEBUG_LOG_DIR,
      hasPassword: !!password
    });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();

    // If updating password, hash it
    if (body.newPassword) {
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting password, no current password needed
        // Allow empty currentPassword or default "123456"
        if (body.currentPassword && body.currentPassword !== "123456") {
           return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
    }

    if (Object.prototype.hasOwnProperty.call(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

    const settings = await updateSettings(body);

    // Sync MITM-relevant settings to mitm/settings.json so the standalone
    // MITM process picks up the change immediately (no restart needed).
    patchMitmSettingsCache(body);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    // Sync RTK toggle immediately (sync cache for MITM request hot path)
    if (Object.prototype.hasOwnProperty.call(body, "rtkEnabled")) {
      setRtkEnabled(settings.rtkEnabled);
    }

    if (Object.prototype.hasOwnProperty.call(body, "periodicDbBackupsEnabled")) {
      // Pass the SQLite file path — SQLite is the source of truth; db.json is a compat sync artifact.
      configureDbPeriodicBackups(DATA_FILE, settings.periodicDbBackupsEnabled !== false);
    }

    const { password, oidcClientSecret: _oidcSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && _oidcSecret);
    return NextResponse.json({
      ...safeSettings,
      mitmAntigravityDebugLogDir: MITM_ANTIGRAVITY_DEBUG_LOG_DIR,
    });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
