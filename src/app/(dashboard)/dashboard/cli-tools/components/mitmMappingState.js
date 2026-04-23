import {
  DEFAULT_MITM_ALIAS_STRATEGY,
  MAX_MITM_ALIAS_MODELS,
  normalizeMitmAliasStrategy,
} from "../../../../../lib/mitmAlias";

export { DEFAULT_MITM_ALIAS_STRATEGY, MAX_MITM_ALIAS_MODELS };

export function normalizeMappingList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
      .slice(0, MAX_MITM_ALIAS_MODELS);
  }

  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }

  return [];
}

export function normalizeMappingState(mappings) {
  return Object.fromEntries(
    Object.entries(mappings || {})
      .map(([alias, value]) => [alias, normalizeMappingList(value)])
      .filter(([, value]) => value.length > 0)
  );
}

export function sanitizeMappingState(mappings) {
  return normalizeMappingState(mappings);
}

export function expandCommaSeparatedModels(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function appendMappingEntry(mappings, alias, value) {
  const nextValue = typeof value === "string" ? value.trim() : "";
  if (!alias || !nextValue) return mappings;

  const current = normalizeMappingList(mappings?.[alias]);
  if (current.length >= MAX_MITM_ALIAS_MODELS) return mappings;

  return {
    ...mappings,
    [alias]: [...current, nextValue],
  };
}

export function updateMappingEntry(mappings, alias, index, value) {
  const current = Array.isArray(mappings?.[alias]) ? [...mappings[alias]] : [];
  if (index < 0 || index >= current.length) return mappings;
  current[index] = value;
  return {
    ...mappings,
    [alias]: current,
  };
}

export function commitMappingEntryInput(mappings, alias, index, value) {
  const current = Array.isArray(mappings?.[alias]) ? [...mappings[alias]] : [];
  if (index < 0 || index >= current.length) return mappings;

  const before = current.slice(0, index);
  const after = current.slice(index + 1);
  const room = Math.max(0, MAX_MITM_ALIAS_MODELS - before.length - after.length);
  const expanded = expandCommaSeparatedModels(value).slice(0, room);
  const next = [...before, ...expanded, ...after].slice(0, MAX_MITM_ALIAS_MODELS);

  if (next.length === 0) {
    const { [alias]: _removed, ...rest } = mappings || {};
    return rest;
  }

  return {
    ...mappings,
    [alias]: next,
  };
}

export function removeMappingEntry(mappings, alias, index) {
  const current = Array.isArray(mappings?.[alias]) ? mappings[alias] : [];
  const next = current.filter((_, itemIndex) => itemIndex !== index);

  if (next.length === 0) {
    const { [alias]: _removed, ...rest } = mappings || {};
    return rest;
  }

  return {
    ...mappings,
    [alias]: next,
  };
}

export function reorderMappingEntry(mappings, alias, fromIndex, toIndex) {
  const current = Array.isArray(mappings?.[alias]) ? [...mappings[alias]] : [];
  if (
    fromIndex < 0
    || toIndex < 0
    || fromIndex >= current.length
    || toIndex >= current.length
    || fromIndex === toIndex
  ) {
    return mappings;
  }

  const [moved] = current.splice(fromIndex, 1);
  current.splice(toIndex, 0, moved);

  return {
    ...mappings,
    [alias]: current,
  };
}

export function normalizeStrategyValue(strategy) {
  return normalizeMitmAliasStrategy(strategy || DEFAULT_MITM_ALIAS_STRATEGY);
}
