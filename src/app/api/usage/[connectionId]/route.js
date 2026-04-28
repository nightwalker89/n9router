// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { inferAntigravityAccountType } from "@/lib/antigravity/accountType";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { getExecutor } from "open-sse/executors/index.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

// Detect auth-expired messages returned by usage providers instead of throwing
const AUTH_EXPIRED_PATTERNS = ["expired", "authentication", "unauthorized", "401", "re-authorize"];
function isAuthExpiredMessage(usage) {
  if (!usage?.message) return false;
  const msg = usage.message.toLowerCase();
  return AUTH_EXPIRED_PATTERNS.some((p) => msg.includes(p));
}

function clampPercentage(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getRemainingPercentage(quota) {
  const direct = clampPercentage(quota?.remainingPercentage);
  if (direct != null) return direct;

  const total = typeof quota?.total === "number" ? quota.total : null;
  const used = typeof quota?.used === "number" ? quota.used : null;
  if (total == null || total <= 0 || used == null) return null;

  return clampPercentage(((total - used) / total) * 100);
}

function buildModelQuotaStatus(usage) {
  if (!usage?.quotas || typeof usage.quotas !== "object") return null;

  const status = {};

  for (const [modelKey, quota] of Object.entries(usage.quotas)) {
    if (!quota || typeof quota !== "object") continue;

    const remainingPercentage = getRemainingPercentage(quota);
    status[modelKey] = {
      displayName: quota.displayName || modelKey,
      resetAt: quota.resetAt || null,
      remainingPercentage,
      exhausted: remainingPercentage === 0,
    };
  }

  return Object.keys(status).length > 0 ? status : null;
}

function shouldUseAntigravityLocalFallback(usage) {
  if (!usage || typeof usage !== "object") return true;
  if (usage.quotas && Object.keys(usage.quotas).length > 0) return false;
  return true;
}

function readAntigravityLocalQuota(connection) {
  const email = connection?.email ? String(connection.email).trim().toLowerCase() : "";
  if (!email) return null;

  const accountsDir = path.join(os.homedir(), ".antigravity_tools", "accounts");
  if (!fs.existsSync(accountsDir)) return null;

  const files = fs.readdirSync(accountsDir).filter((file) => file.endsWith(".json"));
  for (const file of files) {
    try {
      const filePath = path.join(accountsDir, file);
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (String(raw?.email || "").trim().toLowerCase() !== email) continue;

      const quotaModels = Array.isArray(raw?.quota?.models) ? raw.quota.models : [];
      const quotas = {};

      quotaModels.forEach((model) => {
        const remainingPercentage = typeof model?.percentage === "number" ? model.percentage : null;
        if (!model?.name || remainingPercentage == null) return;

        const total = 1000;
        const used = total - Math.round((total * remainingPercentage) / 100);

        quotas[model.name] = {
          used,
          total,
          resetAt: model.reset_time || null,
          remainingPercentage,
          unlimited: false,
          displayName: model.display_name || model.name,
        };
      });

      return {
        plan: raw?.quota?.subscription_tier || null,
        quotas,
        source: "local-agt",
      };
    } catch {
      // Ignore malformed local files and continue scanning.
    }
  }

  return null;
}

/**
 * Refresh credentials using executor and update database
 * @param {boolean} force - Skip needsRefresh check and always attempt refresh
 * @returns Promise<{ connection, refreshed: boolean }>
 */
async function refreshAndUpdateCredentials(connection, force = false, proxyOptions = null) {
  const executor = getExecutor(connection.provider);

  // Build credentials object from connection
  const credentials = {
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    expiresAt: connection.expiresAt || connection.tokenExpiresAt,
    providerSpecificData: connection.providerSpecificData,
    // For GitHub
    copilotToken: connection.providerSpecificData?.copilotToken,
    copilotTokenExpiresAt: connection.providerSpecificData?.copilotTokenExpiresAt,
  };

  // Check if refresh is needed (skip when force=true)
  const needsRefresh = force || executor.needsRefresh(credentials);

  if (!needsRefresh) {
    return { connection, refreshed: false };
  }

  // Use executor's refreshCredentials method (with optional proxy)
  const refreshResult = await executor.refreshCredentials(credentials, console, proxyOptions);

  if (!refreshResult) {
    // Refresh failed but we still have an accessToken — try with existing token
    if (connection.accessToken) {
      return { connection, refreshed: false };
    }
    throw new Error("Failed to refresh credentials. Please re-authorize the connection.");
  }

  // Build update object
  const now = new Date().toISOString();
  const updateData = {
    updatedAt: now,
  };

  // Update accessToken if present
  if (refreshResult.accessToken) {
    updateData.accessToken = refreshResult.accessToken;
  }

  // Update refreshToken if present
  if (refreshResult.refreshToken) {
    updateData.refreshToken = refreshResult.refreshToken;
  }

  // Update token expiry
  if (refreshResult.expiresIn) {
    updateData.expiresAt = new Date(Date.now() + refreshResult.expiresIn * 1000).toISOString();
  } else if (refreshResult.expiresAt) {
    updateData.expiresAt = refreshResult.expiresAt;
  }

  // Handle provider-specific data (copilotToken for GitHub, etc.)
  if (refreshResult.copilotToken || refreshResult.copilotTokenExpiresAt) {
    updateData.providerSpecificData = {
      ...connection.providerSpecificData,
      copilotToken: refreshResult.copilotToken,
      copilotTokenExpiresAt: refreshResult.copilotTokenExpiresAt,
    };
  }

  // Update database
  await updateProviderConnection(connection.id, updateData);

  // Return updated connection
  const updatedConnection = {
    ...connection,
    ...updateData,
  };

  return {
    connection: updatedConnection,
    refreshed: true,
  };
}

/**
 * GET /api/usage/[connectionId] - Get usage data for a specific connection
 */
export async function GET(request, { params }) {
  let connection;
  try {
    const { connectionId } = await params;


    // Get connection from database
    connection = await getProviderConnectionById(connectionId);
    if (!connection) {
      return Response.json({ error: "Connection not found" }, { status: 404 });
    }

    // Only OAuth connections have usage APIs
    if (connection.authType !== "oauth") {
      return Response.json({ message: "Usage not available for API key connections" });
    }

    // Resolve connection proxy config; force strictProxy=false so quota/refresh fall back to direct on failure
    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };

    // Refresh credentials if needed using executor
    try {
      const result = await refreshAndUpdateCredentials(connection, false, proxyOptions);
      connection = result.connection;
    } catch (refreshError) {
      console.error("[Usage API] Credential refresh failed:", refreshError);
      return Response.json({
        error: `Credential refresh failed: ${refreshError.message}`
      }, { status: 401 });
    }

    // Fetch usage from provider API
    let usage = await getUsageForProvider(connection, proxyOptions);

    // If provider returned an auth-expired message instead of throwing,
    // force-refresh token and retry once
    if (isAuthExpiredMessage(usage) && connection.refreshToken) {
      try {
        const retryResult = await refreshAndUpdateCredentials(connection, true, proxyOptions);
        connection = retryResult.connection;
        usage = await getUsageForProvider(connection, proxyOptions);
      } catch (retryError) {
        console.warn(`[Usage] ${connection.provider}: force refresh failed: ${retryError.message}`);
      }
    }

    if (connection.provider === "antigravity" && shouldUseAntigravityLocalFallback(usage)) {
      const fallbackUsage = readAntigravityLocalQuota(connection);
      if (fallbackUsage) {
        usage = {
          ...usage,
          ...fallbackUsage,
          message: usage?.message || null,
        };
      }
    }

    if (connection.provider === "antigravity") {
      const accountType = inferAntigravityAccountType(usage);
      const modelQuotaStatus = buildModelQuotaStatus(usage);
      const updates = {};

      if (accountType && accountType !== connection.accountType) {
        updates.accountType = accountType;
      }

      if (modelQuotaStatus) {
        updates.modelQuotaStatus = modelQuotaStatus;
      }

      if (Object.keys(updates).length > 0) {
        await updateProviderConnection(connection.id, updates);
      }
    }

    return Response.json(usage);
  } catch (error) {
    const provider = connection?.provider ?? "unknown";
    console.warn(`[Usage] ${provider}: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
