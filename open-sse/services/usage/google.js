/**
 * Google usage handlers (Gemini CLI + Antigravity)
 */

import { CLIENT_METADATA } from "../../config/appConstants.js";
import { ANTIGRAVITY_IDE_USER_AGENT, ANTIGRAVITY_IDE_VERSION, ANTIGRAVITY_OAUTH_CLIENT } from "../../providers/shared.js";
import { U, parseResetTime, normalizeCloudCodeProjectId, fetchWithTimeout } from "./shared.js";
import { fetchAntigravityWeeklyQuota } from "./antigravity-weekly.js";

// Antigravity API config (from Quotio) — urls from registry, oauth client + dynamic UA kept here
const ANTIGRAVITY_CONFIG = {
  ...U("antigravity"),
  ...ANTIGRAVITY_OAUTH_CLIENT,
  userAgent: ANTIGRAVITY_IDE_USER_AGENT,
};

/**
 * Gemini CLI Usage — fetch per-model quota via Cloud Code Assist API.
 * Uses retrieveUserQuota (same endpoint as `gemini /stats`) returning
 * per-model buckets with remainingFraction + resetTime.
 */
export async function getGeminiUsage(accessToken, providerSpecificData, proxyOptions = null) {
  if (!accessToken) {
    return { plan: "Free", message: "Gemini CLI access token not available." };
  }

  try {
    // Resolve project id: prefer connection-stored id, else loadCodeAssist lookup.
    // #1271: OAuth save stores projectId on the connection, not providerSpecificData.
    let projectId = normalizeCloudCodeProjectId(providerSpecificData?.projectId);
    let plan = "Free";

    if (!projectId) {
      const subInfo = await getGeminiSubscriptionInfo(accessToken, proxyOptions);
      projectId = normalizeCloudCodeProjectId(subInfo?.cloudaicompanionProject);
      plan = subInfo?.currentTier?.name || plan;
    }

    if (!projectId) {
      return {
        plan,
        message: "Gemini CLI project ID not available. Reconnect Gemini CLI, or configure a Google Cloud project with Gemini Code Assist access before checking quota.",
      };
    }

    const response = await fetchWithTimeout(
      U("gemini-cli").quotaUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ project: projectId }),
      },
      10000,
      proxyOptions
    );

    if (!response.ok) {
      return { plan, message: `Gemini CLI quota error (${response.status}).` };
    }

    const data = await response.json();
    const quotas = {};

    if (Array.isArray(data.buckets)) {
      for (const bucket of data.buckets) {
        if (!bucket.modelId || bucket.remainingFraction == null) continue;

        const remainingFraction = Number(bucket.remainingFraction) || 0;
        const total = 1000; // Normalized base, matches antigravity convention
        const remaining = Math.round(total * remainingFraction);
        const used = Math.max(0, total - remaining);

        quotas[bucket.modelId] = {
          used,
          total,
          resetAt: parseResetTime(bucket.resetTime),
          remainingPercentage: remainingFraction * 100,
          unlimited: false,
        };
      }
    }

    return { plan, quotas };
  } catch (error) {
    return { message: `Gemini CLI error: ${error.message}` };
  }
}

/**
 * Get Gemini CLI subscription info via loadCodeAssist
 */
async function getGeminiSubscriptionInfo(accessToken, proxyOptions = null) {
  try {
    const response = await fetchWithTimeout(
      U("gemini-cli").loadCodeAssistUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ metadata: CLIENT_METADATA }),
      },
      10000,
      proxyOptions
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Antigravity Usage - Fetch quota from Google Cloud Code API
 */
export async function getAntigravityUsage(accessToken, providerSpecificData, proxyOptions = null) {
  try {
    // Fetch subscription info once — reuse for both projectId and plan
    const subscriptionInfo = await getAntigravitySubscriptionInfo(accessToken, proxyOptions);
    const projectId = subscriptionInfo?.cloudaicompanionProject || null;

    const response = await fetchWithTimeout(ANTIGRAVITY_CONFIG.quotaApiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": ANTIGRAVITY_CONFIG.userAgent,
        "Content-Type": "application/json",
        "X-Client-Name": "antigravity",
        "X-Client-Version": ANTIGRAVITY_IDE_VERSION,
      },
      body: JSON.stringify({
        ...(projectId ? { project: projectId } : {})
      }),
    }, 10000, proxyOptions);

    if (response.status === 403) {
      return {
        message: "Antigravity quota API access forbidden. Chat may still work.",
        quotas: {}
      };
    }

    if (response.status === 401) {
      return {
        message: "Antigravity quota API authentication expired. Chat may still work.",
        quotas: {}
      };
    }

    if (!response.ok) {
      throw new Error(`Antigravity API error: ${response.status}`);
    }

    const data = await response.json();
    // Production can lag behind the IDE daily endpoint when new model buckets
    // roll out. Merge only missing models so production values stay authoritative.
    if (data.models && !Object.keys(data.models).some((modelKey) => modelKey.includes("gemini-3.8-flash"))) {
      try {
        const dailyResponse = await fetchWithTimeout(
          "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "User-Agent": ANTIGRAVITY_CONFIG.userAgent,
              "Content-Type": "application/json",
              "X-Client-Name": "antigravity",
              "X-Client-Version": ANTIGRAVITY_IDE_VERSION,
            },
            body: JSON.stringify({ ...(projectId ? { project: projectId } : {}) }),
          },
          10000,
          proxyOptions
        );
        if (dailyResponse.ok) {
          const dailyData = await dailyResponse.json();
          data.models = { ...dailyData.models, ...data.models };
        }
      } catch {
        // Production quota data is still usable if the daily endpoint is unavailable.
      }
    }
    const quotas = {};

    // Detect tier: free-tier accounts only have weekly quotas (no separate 5h window).
    // On free-tier, fetchAvailableModels returns misleading per-model quota info
    // (missing remainingFraction defaults to 0, or reflects the weekly limit not a 5h window).
    const paidTierId = subscriptionInfo?.paidTier?.id;
    const isFreeTier = !paidTierId || paidTierId === "free-tier";

    // Parse model quotas only for paid-tier accounts.
    // Free-tier accounts skip this — their only meaningful quota is the weekly limit.
    if (!isFreeTier && data.models) {
      // Filter only recommended/important models (must match PROVIDER_MODELS ag ids,
      // plus live fetchAvailableModels keys that have not been split into tiers yet).
      const importantModels = {
        "gemini-4-carbon-high": "Gemini 4 Carbon (High)",
        "gemini-4-carbon-medium": "Gemini 4 Carbon (Medium)",
        "gemini-4-carbon-low": "Gemini 4 Carbon (Low)",
        "gemini-4-argon-high": "Gemini 4 Argon (High)",
        "gemini-4-argon-medium": "Gemini 4 Argon (Medium)",
        "gemini-4-argon-low": "Gemini 4 Argon (Low)",
        // Live API may ship base or `*-tiered` buckets instead of split tiers.
        "gemini-3.8-flash": "Gemini 3.8 Flash",
        "gemini-3.8-flash-tiered": "Gemini 3.8 Flash",
        "gemini-3.8-flash-high": "Gemini 3.8 Flash (High)",
        "gemini-3.8-flash-medium": "Gemini 3.8 Flash (Medium)",
        "gemini-3.8-flash-low": "Gemini 3.8 Flash (Low)",
        "gemini-3.7-flash-tiered": "Gemini 3.7 Flash",
        "gemini-3.7-flash-high": "Gemini 3.7 Flash (High)",
        "gemini-3.7-flash-medium": "Gemini 3.7 Flash (Medium)",
        "gemini-3.7-flash-low": "Gemini 3.7 Flash (Low)",
        "gemini-3.6-flash-high": "Gemini 3.6 Flash (High)",
        "gemini-3.6-flash-medium": "Gemini 3.6 Flash (Medium)",
        "gemini-3.6-flash-low": "Gemini 3.6 Flash (Low)",
        "gemini-3.1-pro-high": "Gemini 3.1 Pro (High)",
        "gemini-pro-agent": "Gemini 3.1 Pro (High)",
        "gemini-3.1-pro-low": "Gemini 3.1 Pro (Low)",
        "claude-sonnet-5-5-high": "Claude Sonnet 5.5 (High)",
        "claude-sonnet-5-5-medium": "Claude Sonnet 5.5 (Medium)",
        "claude-sonnet-5-5-low": "Claude Sonnet 5.5 (Low)",
        "claude-sonnet-5-5": "Claude Sonnet 5.5 (Thinking)",
        "claude-opus-5-5-high": "Claude Opus 5.5 (High)",
        "claude-opus-5-5-medium": "Claude Opus 5.5 (Medium)",
        "claude-opus-5-5-low": "Claude Opus 5.5 (Low)",
        "claude-opus-5-5": "Claude Opus 5.5 (Thinking)",
        "claude-sonnet-4-6": "Claude Sonnet 4.6 (Thinking)",
        "claude-opus-4-6-thinking": "Claude Opus 4.6 (Thinking)",
        "gpt-oss-120b-medium": "GPT-OSS 120B (Medium)",
        // Image generation models
        "gemini-3.1-flash-image": "Gemini 3.1 Flash Image",
      };

      for (const [modelKey, info] of Object.entries(data.models)) {
        // Skip models without quota info
        if (!info.quotaInfo) {
          continue;
        }

        // Skip internal models and non-important models
        if (info.isInternal || !Object.hasOwn(importantModels, modelKey)) {
          continue;
        }

        const remainingFraction = info.quotaInfo.remainingFraction || 0;
        const remainingPercentage = remainingFraction * 100;

        // Convert percentage to used/total for UI compatibility
        const total = 1000; // Normalized base
        const remaining = Math.round(total * remainingFraction);
        const used = total - remaining;

        // Use modelKey as key (matches PROVIDER_MODELS id)
        quotas[modelKey] = {
          used,
          total,
          resetAt: parseResetTime(info.quotaInfo.resetTime),
          remainingPercentage,
          unlimited: false,
          displayName: info.displayName || importantModels[modelKey] || modelKey,
        };
      }
    }

    // Best-effort weekly quota overlay — never blocks or breaks per-model results
    try {
      const weeklyQuotas = await fetchAntigravityWeeklyQuota(
        accessToken,
        projectId,
        proxyOptions
      );

      // Reconcile short-window session quota if models are exhausted:
      // If every model in a family is locked/exhausted (remainingPercentage === 0)
      // until a future reset time, update the 5h session row (not the weekly row).
      const entries = Object.entries(quotas);
      const argonModels = entries.filter(([k]) => k.startsWith("gemini-") && k.includes("argon"));
      const geminiModels = entries.filter(([k]) => k.startsWith("gemini-") && !k.includes("image") && !k.includes("argon"));
      const claudeModels = entries.filter(([k]) => k.startsWith("claude-"));

      if (weeklyQuotas.gemini_argon_session && argonModels.length > 0) {
        const allArgonExhausted = argonModels.every(([, q]) => (q.remainingPercentage ?? 0) === 0);
        if (allArgonExhausted && weeklyQuotas.gemini_argon_session.remainingPercentage > 0) {
          const maxResetAt = argonModels.reduce((max, [, q]) =>
            !max || (q.resetAt && new Date(q.resetAt) > new Date(max)) ? q.resetAt : max, null
          );
          weeklyQuotas.gemini_argon_session.used = weeklyQuotas.gemini_argon_session.total;
          weeklyQuotas.gemini_argon_session.remainingPercentage = 0;
          if (maxResetAt) {
            weeklyQuotas.gemini_argon_session.resetAt = maxResetAt;
          }
        }
      }

      if (weeklyQuotas.gemini_session && geminiModels.length > 0) {
        const allGeminiExhausted = geminiModels.every(([, q]) => (q.remainingPercentage ?? 0) === 0);
        if (allGeminiExhausted && weeklyQuotas.gemini_session.remainingPercentage > 0) {
          const maxResetAt = geminiModels.reduce((max, [, q]) =>
            !max || (q.resetAt && new Date(q.resetAt) > new Date(max)) ? q.resetAt : max, null
          );
          weeklyQuotas.gemini_session.used = weeklyQuotas.gemini_session.total;
          weeklyQuotas.gemini_session.remainingPercentage = 0;
          if (maxResetAt) {
            weeklyQuotas.gemini_session.resetAt = maxResetAt;
          }
        }
      }

      if (weeklyQuotas.claude_gpt_session && claudeModels.length > 0) {
        const allClaudeExhausted = claudeModels.every(([, q]) => (q.remainingPercentage ?? 0) === 0);
        if (allClaudeExhausted && weeklyQuotas.claude_gpt_session.remainingPercentage > 0) {
          const maxResetAt = claudeModels.reduce((max, [, q]) =>
            !max || (q.resetAt && new Date(q.resetAt) > new Date(max)) ? q.resetAt : max, null
          );
          weeklyQuotas.claude_gpt_session.used = weeklyQuotas.claude_gpt_session.total;
          weeklyQuotas.claude_gpt_session.remainingPercentage = 0;
          if (maxResetAt) {
            weeklyQuotas.claude_gpt_session.resetAt = maxResetAt;
          }
        }
      }

      Object.assign(quotas, weeklyQuotas);
    } catch {
      // Silently ignore — weekly is best-effort
    }

    return {
      plan: subscriptionInfo?.currentTier?.name || "Unknown",
      quotas,
      subscriptionInfo,
    };
  } catch (error) {
    console.error("[Antigravity Usage] Error:", error.message, error.cause);
    return { message: `Antigravity error: ${error.message}` };
  }
}

/**
 * Get Antigravity subscription info
 */
async function getAntigravitySubscriptionInfo(accessToken, proxyOptions = null) {
  try {
    const response = await fetchWithTimeout(ANTIGRAVITY_CONFIG.loadProjectApiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": ANTIGRAVITY_CONFIG.userAgent,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ metadata: CLIENT_METADATA, mode: 1 }),
    }, 10000, proxyOptions);

    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error("[Antigravity Subscription] Error:", error.message);
    return null;
  }
}
