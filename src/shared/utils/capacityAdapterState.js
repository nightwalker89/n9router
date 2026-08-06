// Keep the visible capacity-adapter pool aligned with its runtime state.
// Removing the final model disables the adapter, preventing the routing layer
// from restoring its implicit fallback for an enabled-but-empty pool.
export function removeCapacityAdapterModel(entry, index) {
  const models = Array.isArray(entry.models) ? entry.models : [];
  const nextModels = models.filter((_, modelIndex) => modelIndex !== index);
  if (nextModels.length > 0) return { ...entry, models: nextModels };
  return { ...entry, enabled: false, roundRobin: false, models: [] };
}

// The capacity adapter's documented default is restored only when a user
// explicitly re-enables an empty adapter.
export function enableCapacityAdapter(entry, defaultModel) {
  const models = Array.isArray(entry.models) ? entry.models : [];
  return {
    ...entry,
    enabled: true,
    models: models.length > 0 ? models : [defaultModel],
  };
}
