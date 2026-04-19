"use client";

import { useCallback, useState } from "react";

function normalizeOverrides(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return {};
  return Object.fromEntries(
    Object.entries(overrides)
      .map(([modelId, name]) => [
        typeof modelId === "string" ? modelId.trim() : "",
        typeof name === "string" ? name.trim() : "",
      ])
      .filter(([modelId, name]) => modelId && name)
  );
}

export function useMitmModelNameOverrides(toolId) {
  const [nameOverrides, setNameOverrides] = useState({});
  const [editingModelNameId, setEditingModelNameId] = useState(null);
  const [modelNameDraft, setModelNameDraft] = useState("");
  const [modelNameFeedback, setModelNameFeedback] = useState(null);

  const loadNameOverrides = useCallback(async () => {
    try {
      const res = await fetch(`/api/cli-tools/antigravity-mitm/model-names?tool=${toolId}`);
      if (!res.ok) return;
      const data = await res.json();
      setNameOverrides(normalizeOverrides(data.overrides));
    } catch {
      // ignore
    }
  }, [toolId]);

  const saveNameOverrides = useCallback(async (overrides) => {
    const normalized = normalizeOverrides(overrides);
    const res = await fetch("/api/cli-tools/antigravity-mitm/model-names", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: toolId, overrides: normalized }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || "Failed to save model name");
    }

    return normalizeOverrides(data.overrides);
  }, [toolId]);

  const startModelNameEdit = useCallback((modelId, originalName) => {
    setEditingModelNameId(modelId);
    setModelNameDraft(nameOverrides[modelId] || originalName || modelId);
    setModelNameFeedback(null);
  }, [nameOverrides]);

  const cancelModelNameEdit = useCallback(() => {
    setEditingModelNameId(null);
    setModelNameDraft("");
  }, []);

  const commitModelName = useCallback(async (modelId, value = modelNameDraft) => {
    const name = typeof value === "string" ? value.trim() : "";
    const next = { ...nameOverrides };

    if (name) {
      next[modelId] = name;
    } else {
      delete next[modelId];
    }

    try {
      const saved = await saveNameOverrides(next);
      setNameOverrides(saved);
      setEditingModelNameId(null);
      setModelNameDraft("");
      setModelNameFeedback(name ? "Model name saved. Restart Antigravity if the picker is already open." : "Model name reset.");
    } catch (error) {
      setModelNameFeedback(error.message || "Failed to save model name");
    }
  }, [modelNameDraft, nameOverrides, saveNameOverrides]);

  const resetModelName = useCallback(async (modelId) => {
    const next = { ...nameOverrides };
    delete next[modelId];

    try {
      const saved = await saveNameOverrides(next);
      setNameOverrides(saved);
      if (editingModelNameId === modelId) {
        setEditingModelNameId(null);
        setModelNameDraft("");
      }
      setModelNameFeedback("Model name reset.");
    } catch (error) {
      setModelNameFeedback(error.message || "Failed to reset model name");
    }
  }, [editingModelNameId, nameOverrides, saveNameOverrides]);

  return {
    cancelModelNameEdit,
    commitModelName,
    editingModelNameId,
    loadNameOverrides,
    modelNameDraft,
    modelNameFeedback,
    nameOverrides,
    resetModelName,
    setModelNameDraft,
    startModelNameEdit,
  };
}
