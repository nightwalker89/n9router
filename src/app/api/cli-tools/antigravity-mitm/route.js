import { NextResponse } from "next/server";
import {
  getMitmStatus,
  startServer,
  stopServer,
  enableToolDNS,
  disableToolDNS,
  trustCert,
  getCachedPassword,
  setCachedPassword,
  loadEncryptedPassword,
  initDbHooks,
} from "@/mitm/manager";
import { getSettings, updateSettings } from "@/lib/localDb";

initDbHooks(getSettings, updateSettings);

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";

function normalizeMitmRouterBaseUrlInput(input) {
  if (input == null || String(input).trim() === "") {
    return DEFAULT_MITM_ROUTER_BASE;
  }
  const t = String(input).trim().replace(/\/+$/, "");
  let u;
  try {
    u = new URL(t);
  } catch {
    throw new Error("Invalid MITM router URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("MITM router URL must use http or https");
  }
  return t;
}

const isWin = process.platform === "win32";

function getPassword(provided) {
  return provided || getCachedPassword() || null;
}

function checkIsAdmin() {
  if (!isWin) return true;
  try {
    return require("../../../../mitm/dns/dnsConfig").isWindowsAdmin();
  } catch {
    return false;
  }
}

function getErrorMessage(error, fallback) {
  if (error?.message && String(error.message).trim()) return String(error.message).trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") return serialized;
  } catch {
    // ignore
  }
  return fallback;
}

function logRouteError(label, error, context = {}) {
  const payload = {
    context,
    name: error?.name || null,
    message: getErrorMessage(error, `${label} failed`),
    code: error?.code || null,
    statusCode: error?.statusCode || null,
    errno: error?.errno || null,
    syscall: error?.syscall || null,
    path: error?.path || null,
    stack: error?.stack || null,
    cause: error?.cause?.message || null,
  };
  console.error(`[antigravity-mitm] ${label} failed`, payload);
}

function jsonError(label, error, fallback, context = {}) {
  logRouteError(label, error, context);
  const status = Number(error?.statusCode) || Number(error?.status) || 500;
  return NextResponse.json({ error: getErrorMessage(error, fallback) }, { status });
}

// GET - Full MITM status (server + per-tool DNS)
export async function GET() {
  try {
    const status = await getMitmStatus();
    const settings = await getSettings();
    return NextResponse.json({
      running: status.running,
      pid: status.pid || null,
      certExists: status.certExists || false,
      certTrusted: status.certTrusted || false,
      dnsStatus: status.dnsStatus || {},
      hasCachedPassword: !!getCachedPassword() || !!(await loadEncryptedPassword()),
      isAdmin: checkIsAdmin(),
      mitmRouterBaseUrl:
        (settings.mitmRouterBaseUrl && String(settings.mitmRouterBaseUrl).trim()) ||
        DEFAULT_MITM_ROUTER_BASE,
    });
  } catch (error) {
    return jsonError("get status", error, "Failed to get MITM status");
  }
}

// POST - Start MITM server (cert + server, no DNS)
export async function POST(request) {
  try {
    const { apiKey, sudoPassword, mitmRouterBaseUrl } = await request.json();
    const pwd = getPassword(sudoPassword) || await loadEncryptedPassword() || "";

    if (!apiKey || (!isWin && !pwd)) {
      return NextResponse.json(
        { error: isWin ? "Missing apiKey" : "Missing apiKey or sudoPassword" },
        { status: 400 }
      );
    }

    if (mitmRouterBaseUrl !== undefined && mitmRouterBaseUrl !== null) {
      try {
        const normalized = normalizeMitmRouterBaseUrlInput(mitmRouterBaseUrl);
        await updateSettings({ mitmRouterBaseUrl: normalized });
      } catch (e) {
        return NextResponse.json(
          { error: e.message || "Invalid MITM router URL" },
          { status: 400 },
        );
      }
    }

    const result = await startServer(apiKey, pwd);
    if (!isWin) setCachedPassword(pwd);

    return NextResponse.json({ success: true, running: result.running, pid: result.pid });
  } catch (error) {
    return jsonError("start server", error, "Failed to start MITM server");
  }
}

// DELETE - Stop MITM server (removes all DNS first, then kills server)
export async function DELETE(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { sudoPassword } = body;
    const pwd = getPassword(sudoPassword) || await loadEncryptedPassword() || "";

    if (!isWin && !pwd) {
      return NextResponse.json({ error: "Missing sudoPassword" }, { status: 400 });
    }

    await stopServer(pwd);
    if (!isWin && sudoPassword) setCachedPassword(sudoPassword);

    return NextResponse.json({ success: true, running: false });
  } catch (error) {
    return jsonError("stop server", error, "Failed to stop MITM server");
  }
}

// PATCH - Toggle DNS for a specific tool (enable/disable)
export async function PATCH(request) {
  let tool;
  let action;
  try {
    const body = await request.json();
    ({ tool, action } = body);
    const { sudoPassword } = body;
    const pwd = getPassword(sudoPassword) || await loadEncryptedPassword() || "";

    if (!tool || !action) {
      return NextResponse.json({ error: "tool and action required" }, { status: 400 });
    }
    if (!isWin && !pwd) {
      return NextResponse.json({ error: "Missing sudoPassword" }, { status: 400 });
    }
    if (isWin && (action === "enable" || action === "disable") && !checkIsAdmin()) {
      const adminError = new Error(
        "Windows DNS changes require Administrator privileges. Restart 9Router as Administrator and try again."
      );
      adminError.code = "WINDOWS_ADMIN_REQUIRED";
      adminError.statusCode = 403;
      throw adminError;
    }

    if (action === "enable") {
      await enableToolDNS(tool, pwd);
    } else if (action === "disable") {
      await disableToolDNS(tool, pwd);
    } else if (action === "trust-cert") {
      await trustCert(pwd);
      if (!isWin && sudoPassword) setCachedPassword(sudoPassword);
      const status = await getMitmStatus();
      return NextResponse.json({ success: true, certTrusted: status.certTrusted });
    } else {
      return NextResponse.json({ error: "action must be enable, disable, or trust-cert" }, { status: 400 });
    }

    if (!isWin && sudoPassword) setCachedPassword(sudoPassword);

    const status = await getMitmStatus();
    return NextResponse.json({ success: true, dnsStatus: status.dnsStatus });
  } catch (error) {
    return jsonError("toggle dns", error, "Failed to toggle DNS", {
      tool: tool || null,
      action: action || null,
      platform: process.platform,
    });
  }
}
