// Synchronous RTK toggle cache. Updated by /api/settings PATCH handler
// and used by MITM paths that do not pass the setting explicitly.
let enabled = false;

export function setRtkEnabled(value) {
  enabled = Boolean(value);
}

export function isRtkEnabled() {
  return enabled;
}
