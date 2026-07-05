const CACHE_KEY = "__n9routerCursorByokSudoPassword";

export function getCursorByokCachedPassword() {
  return globalThis[CACHE_KEY] || null;
}

export function setCursorByokCachedPassword(password) {
  globalThis[CACHE_KEY] = password || null;
}

export function clearCursorByokCachedPassword() {
  globalThis[CACHE_KEY] = null;
}
