import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import {
  CURSOR_BYOK_BRANCH,
  CURSOR_BYOK_COMMITS_URL,
  CURSOR_BYOK_METADATA_PATH,
  getCursorByokTarballUrl,
} from "./constants";

const GITHUB_ACCEPT = "application/vnd.github+json";
const USER_AGENT = "n9router-cursor-byok-installer";
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Accept: GITHUB_ACCEPT,
        "User-Agent": USER_AGENT,
      },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("error", reject);
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Latest Cursor BYOK lookup failed with HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("Latest Cursor BYOK lookup returned invalid JSON"));
        }
      });
    });
    request.on("error", reject);
  });
}

export async function getLatestCursorByokSource({ request = requestJson } = {}) {
  const result = await request(CURSOR_BYOK_COMMITS_URL);
  const ref = String(result?.sha || "").toLowerCase();
  if (!SHA_PATTERN.test(ref)) {
    throw new Error("Latest Cursor BYOK lookup did not return a valid commit SHA");
  }
  return {
    branch: CURSOR_BYOK_BRANCH,
    ref,
    tarballUrl: getCursorByokTarballUrl(ref),
  };
}

export async function readCursorByokSourceMetadata({ metadataPath = CURSOR_BYOK_METADATA_PATH } = {}) {
  try {
    const value = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    return SHA_PATTERN.test(value?.ref || "") ? value : null;
  } catch {
    return null;
  }
}

export async function writeCursorByokSourceMetadata(source, {
  metadataPath = CURSOR_BYOK_METADATA_PATH,
} = {}) {
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  const temporaryPath = `${metadataPath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify({ ...source, resolvedAt: new Date().toISOString() }, null, 2)}\n`);
  await fs.rename(temporaryPath, metadataPath);
}
