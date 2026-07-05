import os from "node:os";
import path from "node:path";

export const CURSOR_BYOK_OWNER = "nightwalker89";
export const CURSOR_BYOK_REPO = "cursor-byok";
export const CURSOR_BYOK_REF = "e0dfcf6b7b4c798e5a535d6cd6e131ced5f24d6f";
export const CURSOR_BYOK_TARBALL_URL =
  `https://codeload.github.com/${CURSOR_BYOK_OWNER}/${CURSOR_BYOK_REPO}/tar.gz/${CURSOR_BYOK_REF}`;

export const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), ".n9router");
export const CURSOR_BYOK_ROOT = path.join(DATA_DIR, "tools", "cursor-byok");
export const CURSOR_BYOK_SOURCE_DIR = path.join(CURSOR_BYOK_ROOT, CURSOR_BYOK_REF);
export const CURSOR_BYOK_TARBALL_PATH = path.join(CURSOR_BYOK_ROOT, `${CURSOR_BYOK_REF}.tar.gz`);
export const CURSOR_BYOK_HOME_DIR = path.join(os.homedir(), ".cursor-byok");
export const CURSOR_EXTENSIONS_DIR = path.join(os.homedir(), ".cursor", "extensions");

export const CURSOR_BYOK_ACTIONS = new Set(["prepare", "install", "restore"]);
