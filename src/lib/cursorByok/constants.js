import os from "node:os";
import path from "node:path";

export const CURSOR_BYOK_OWNER = "nightwalker89";
export const CURSOR_BYOK_REPO = "cursor-byok";
export const CURSOR_BYOK_BRANCH = "main";
export const CURSOR_BYOK_COMMITS_URL =
  `https://api.github.com/repos/${CURSOR_BYOK_OWNER}/${CURSOR_BYOK_REPO}/commits/${CURSOR_BYOK_BRANCH}`;

export function getCursorByokTarballUrl(ref) {
  return `https://codeload.github.com/${CURSOR_BYOK_OWNER}/${CURSOR_BYOK_REPO}/tar.gz/${ref}`;
}

export const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), ".n9router");
export const CURSOR_BYOK_ROOT = path.join(DATA_DIR, "tools", "cursor-byok");
export const CURSOR_BYOK_SOURCE_DIR = path.join(CURSOR_BYOK_ROOT, "current");
export const CURSOR_BYOK_METADATA_PATH = path.join(CURSOR_BYOK_ROOT, "source.json");
export const CURSOR_BYOK_HOME_DIR = path.join(os.homedir(), ".cursor-byok");
export const CURSOR_EXTENSIONS_DIR = path.join(os.homedir(), ".cursor", "extensions");

export const CURSOR_BYOK_ACTIONS = new Set(["prepare", "install", "restore"]);
