// TLS-impersonating HTTP client for grok.com.
//
// Grok sits behind Cloudflare Enterprise, which rejects Node's native TLS
// fingerprint even with valid sso+sso-rw+cf_clearance cookies. wreq-js sends
// a Chrome-like handshake instead (browser profile chrome_146). The session's
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadRuntimeDep } from "./lazyRuntime.js";
import { resolveSystemChromeExecutable } from "../executors/browserExecutableCheck.js";
// User-Agent must match the browser that earned the cf_clearance cookie —
// callers send GROK_TLS_USER_AGENT with the pasted cookie header.
//
// wreq-js is an optional dependency: when it is not installed, requests fail
// fast with GrokTlsUnavailableError so callers can surface an actionable 503.

const DEFAULT_CHROME_MAJOR = "155";
const GROK_TLS_BROWSER = "chrome_146";
const GROK_TLS_OS = process.platform === "linux" ? "linux" : process.platform === "win32" ? "windows" : "macos";

function detectLocalChromeMajorVersion() {
  try {
    const executablePath = resolveSystemChromeExecutable();
    if (!executablePath) return DEFAULT_CHROME_MAJOR;

    if (process.platform === "darwin") {
      try {
        const plistPath = path.resolve(executablePath, "../../Info.plist");
        const plist = readFileSync(plistPath, "utf8");
        const match = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>(\d+)\./);
        if (match?.[1]) return match[1];
      } catch {
        // Fall through to --version check
      }
    }

    const versionOut = execFileSync(executablePath, ["--version"], {
      timeout: 1500,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = String(versionOut || "").match(/\b(\d+)\.\d+\.\d+/);
    return match?.[1] || DEFAULT_CHROME_MAJOR;
  } catch {
    return DEFAULT_CHROME_MAJOR;
  }
}

function buildChromeUserAgent(majorVersion) {
  if (process.platform === "win32") {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`;
  }
  if (process.platform === "linux") {
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`;
  }
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`;
}

const LOCAL_CHROME_MAJOR = detectLocalChromeMajorVersion();

/** Must match the UA of the browser the pasted cf_clearance was issued to. */
export const GROK_TLS_USER_AGENT =
  process.env.GROK_TLS_USER_AGENT?.trim() || buildChromeUserAgent(LOCAL_CHROME_MAJOR);

function selectBestChromeProfile(wreq, targetMajor) {
  const profiles = typeof wreq.getProfiles === "function" ? wreq.getProfiles() : [];
  if (!Array.isArray(profiles) || profiles.length === 0) return GROK_TLS_BROWSER;
  const exact = `chrome_${targetMajor}`;
  if (profiles.includes(exact)) return exact;
  const chromeVersions = profiles
    .map((p) => {
      const m = String(p).match(/^chrome_(\d+)$/);
      return m ? { name: p, major: Number(m[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.major - a.major);
  return chromeVersions[0]?.name || GROK_TLS_BROWSER;
}

let sessionPromise = null;

async function loadSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const wreq = await loadRuntimeDep("wreq-js");
      if (typeof wreq.createSession !== "function") {
        throw new Error("wreq-js runtime is missing createSession");
      }
      const targetMajor = String(GROK_TLS_USER_AGENT).match(/Chrome\/(\d+)/)?.[1] || LOCAL_CHROME_MAJOR;
      const browser = selectBestChromeProfile(wreq, targetMajor);
      return wreq.createSession({ browser, os: GROK_TLS_OS });
    })().catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

export class GrokTlsUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "GrokTlsUnavailableError";
  }
}

/** Cloudflare interstitial pages arrive with 403 + this marker in the body. */
export function isCloudflareChallenge(text) {
  return typeof text === "string" && /just a moment|attention required|cf-mitigated/i.test(text);
}

/**
 * Fetch through the Chrome-TLS session. Returns a native Response — the body
 * is buffered (Grok's NDJSON replies are small), so downstream `.body` /
 * `.text()` consumers keep working unchanged.
 */
export async function grokTlsFetch(url, { method = "GET", headers = {}, body, timeoutMs = 120000, signal } = {}) {
  let session;
  try {
    session = await loadSession();
  } catch (error) {
    throw new GrokTlsUnavailableError(
      `wreq-js unavailable (${error instanceof Error ? error.message : "unknown"}) — install the optional wreq-js dependency to use Grok Web`
    );
  }

  const options = {
    method: method.toUpperCase(),
    headers,
    redirect: "follow",
    timeout: timeoutMs,
  };
  if (body !== undefined) options.body = body;
  if (signal) options.signal = signal;

  const res = await session.fetch(url, options);
  // Buffer as ArrayBuffer, never text(): asset downloads are binary JPEGs and
  // UTF-8 decoding would mangle every non-ASCII byte into U+FFFD.
  const buffer = await res.arrayBuffer();
  const responseHeaders = {};
  try {
    if (res.headers && typeof res.headers.forEach === "function") {
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
    }
  } catch {
    // Header iteration is best-effort.
  }
  return new Response(buffer, { status: res.status, headers: responseHeaders });
}
