import { syncLegacyMainJson } from "./compatJson.js";

const INTERVAL_MS = 5 * 60 * 1000;
let timer = null;

export function startPeriodicJsonSync(adapter) {
  if (timer) return;
  timer = setInterval(() => {
    try {
      syncLegacyMainJson(adapter);
    } catch {}
  }, INTERVAL_MS);
  if (timer.unref) timer.unref();
}
