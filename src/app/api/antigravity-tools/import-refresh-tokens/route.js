import { createProviderConnection, getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { testSingleConnection } from "@/app/api/providers/[id]/test/testUtils";
import { ANTIGRAVITY_CONFIG } from "@/lib/oauth/constants/oauth";
import { refreshGoogleToken } from "open-sse/services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";

const noopLog = {
  warn: () => {},
  error: () => {},
  info: () => {},
};

function maskToken(t) {
  if (!t || typeof t !== "string") return "";
  if (t.length <= 16) return `${t.slice(0, 6)}…`;
  return `${t.slice(0, 10)}…${t.slice(-4)}`;
}

/**
 * Extract Google OAuth refresh tokens from pasted text:
 * - JSON array of objects with refresh_token or raw strings
 * - Single JSON object with refresh_token
 * - "refresh_token": "..." patterns (e.g. from config dumps)
 * - Lines starting with 1// (typical Google refresh token prefix)
 * - Any 1//… token embedded in free text
 */
function extractRefreshTokensFromText(text) {
  if (!text || typeof text !== "string") return [];
  const trimmed = text.trim();
  const out = new Set();

  const add = (raw) => {
    if (raw == null) return;
    const s = String(raw).trim();
    if (!s) return;
    out.add(s);
  };

  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item === "string") add(item);
          else if (item && typeof item === "object" && item.refresh_token) add(item.refresh_token);
        }
        if (out.size) return [...out];
      }
    } catch {
      /* fall through */
    }
  }

  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && obj.refresh_token) add(obj.refresh_token);
      if (out.size) return [...out];
    } catch {
      /* fall through */
    }
  }

  const keyPat = /"refresh_token"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = keyPat.exec(text)) !== null) {
    add(m[1]);
  }
  if (out.size) return [...out];

  for (const line of text.split(/\r?\n/)) {
    const lt = line.trim();
    if (/^1\/\//.test(lt)) {
      const mm = lt.match(/^(1\/\/[^\s"']+)/);
      if (mm) add(mm[1]);
    }
  }
  if (out.size) return [...out];

  const anyPat = /\b(1\/\/[A-Za-z0-9_\-+/=]+)/g;
  while ((m = anyPat.exec(text)) !== null) {
    add(m[1]);
  }

  return [...out];
}

async function fetchGoogleUserEmail(accessToken) {
  const url = `${ANTIGRAVITY_CONFIG.userInfoUrl}?alt=json`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`userinfo failed: HTTP ${res.status} ${errText.slice(0, 120)}`);
  }
  return res.json();
}

/**
 * POST /api/antigravity-tools/import-refresh-tokens
 * Body: { text: string }
 */
export async function POST(request) {
  try {
    let body = {};
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const text = typeof body.text === "string" ? body.text : "";
    const tokens = extractRefreshTokensFromText(text);

    if (tokens.length === 0) {
      return Response.json(
        { error: "No refresh tokens found. Paste one token per line, a JSON array, or text containing \"refresh_token\": \"…\"." },
        { status: 400 }
      );
    }

    const existingConnections = await getProviderConnections({ provider: "antigravity" });
    const existingEmails = new Set(existingConnections.map((c) => c.email).filter(Boolean));

    let imported = 0;
    let updated = 0;
    const errors = [];

    for (const refreshToken of tokens) {
      try {
        const refreshed = await refreshGoogleToken(
          refreshToken,
          ANTIGRAVITY_CONFIG.clientId,
          ANTIGRAVITY_CONFIG.clientSecret,
          noopLog
        );

        if (!refreshed?.accessToken) {
          errors.push({ token: maskToken(refreshToken), error: "Token refresh failed (invalid or revoked refresh token)" });
          continue;
        }

        const { accessToken, refreshToken: newRefresh, expiresIn } = refreshed;
        const effectiveRefresh = newRefresh || refreshToken;

        let expiresAt = null;
        if (expiresIn) {
          expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
        }

        const userInfo = await fetchGoogleUserEmail(accessToken);
        const email =
          userInfo.email ||
          (userInfo.id ? `google-${userInfo.id}@google.local` : null);

        if (!email) {
          errors.push({ token: maskToken(refreshToken), error: "Could not determine account email from Google userinfo" });
          continue;
        }

        const isExisting = existingEmails.has(email);

        const connectionData = {
          provider: "antigravity",
          authType: "oauth",
          email,
          name: userInfo.name || email,
          accessToken,
          refreshToken: effectiveRefresh,
          expiresAt,
          projectId: null,
          isActive: true,
        };

        const connection = await createProviderConnection(connectionData);

        const projectId = await getProjectIdForConnection(connection.id, accessToken);
        if (projectId) {
          await updateProviderConnection(connection.id, { projectId });
        }

        try {
          await testSingleConnection(connection.id);
        } catch (testErr) {
          console.log(`[antigravity-tools/import-refresh-tokens] Test failed for ${email}: ${testErr.message}`);
        }

        if (isExisting) {
          updated++;
        } else {
          imported++;
          existingEmails.add(email);
        }
      } catch (err) {
        errors.push({ token: maskToken(refreshToken), error: err.message || String(err) });
      }
    }

    const failed = errors.length;

    console.log(
      `[antigravity-tools/import-refresh-tokens] Done: imported=${imported}, updated=${updated}, failed=${failed}, total=${tokens.length}`
    );

    return Response.json({
      imported,
      updated,
      skipped: 0,
      failed,
      errors,
      total: tokens.length,
    });
  } catch (error) {
    console.error("[antigravity-tools/import-refresh-tokens] Error:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
