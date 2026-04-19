const MAX_MITM_MODEL_NAME_LENGTH = 80;

function normalizeAllowedModelIds(allowedModelIds) {
  if (!allowedModelIds) return null;
  const values = Array.isArray(allowedModelIds)
    ? allowedModelIds
    : Array.from(allowedModelIds);
  const normalized = values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  return normalized.length > 0 ? new Set(normalized) : null;
}

export function normalizeMitmModelNameOverrides(overrides, allowedModelIds = null) {
  const allowed = normalizeAllowedModelIds(allowedModelIds);
  const normalized = {};

  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return normalized;
  }

  for (const [rawModelId, rawName] of Object.entries(overrides)) {
    const modelId = typeof rawModelId === "string" ? rawModelId.trim() : "";
    if (!modelId) continue;
    if (allowed && !allowed.has(modelId)) continue;

    const name = typeof rawName === "string"
      ? rawName.trim().slice(0, MAX_MITM_MODEL_NAME_LENGTH)
      : "";
    if (!name) continue;

    normalized[modelId] = name;
  }

  return normalized;
}

export function normalizeMitmModelNameSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return {};
  }

  const source = settings.mitmModelNameOverrides;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(source)
      .filter(([tool, overrides]) => tool && overrides && typeof overrides === "object" && !Array.isArray(overrides))
      .map(([tool, overrides]) => [tool, normalizeMitmModelNameOverrides(overrides)])
  );
}

export { MAX_MITM_MODEL_NAME_LENGTH };
