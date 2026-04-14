const MAX_MITM_ALIAS_MODELS = 5;
const DEFAULT_MITM_ALIAS_STRATEGY = "round-robin";

export function normalizeMitmAliasStrategy(strategy) {
  return strategy === "fallback" ? "fallback" : DEFAULT_MITM_ALIAS_STRATEGY;
}

export function normalizeMitmAliasMappings(mappings) {
  const normalized = {};

  for (const [alias, value] of Object.entries(mappings || {})) {
    if (!alias) continue;

    if (Array.isArray(value)) {
      const models = value
        .map((model) => (typeof model === "string" ? model.trim() : ""))
        .filter(Boolean)
        .slice(0, MAX_MITM_ALIAS_MODELS);

      if (models.length > 0) {
        normalized[alias] = models;
      }
      continue;
    }

    if (typeof value === "string" && value.trim()) {
      normalized[alias] = [value.trim()];
    }
  }

  return normalized;
}

export { DEFAULT_MITM_ALIAS_STRATEGY, MAX_MITM_ALIAS_MODELS };
