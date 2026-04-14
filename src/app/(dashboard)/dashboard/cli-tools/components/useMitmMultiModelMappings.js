"use client";

import { useCallback, useState } from "react";
import {
  appendMappingEntry,
  commitMappingEntryInput,
  normalizeMappingState,
  normalizeStrategyValue,
  removeMappingEntry,
  reorderMappingEntry,
  sanitizeMappingState,
  updateMappingEntry,
} from "./mitmMappingState";

export function useMitmMultiModelMappings(toolId) {
  const [modelMappings, setModelMappings] = useState({});
  const [selectedStrategy, setSelectedStrategy] = useState("round-robin");
  const [modalOpen, setModalOpen] = useState(false);
  const [currentEditingAlias, setCurrentEditingAlias] = useState(null);
  const [mappingFeedback, setMappingFeedback] = useState(null);

  const loadSavedMappings = useCallback(async () => {
    try {
      const res = await fetch(`/api/cli-tools/antigravity-mitm/alias?tool=${toolId}`);
      if (!res.ok) return;
      const data = await res.json();
      setModelMappings(normalizeMappingState(data.aliases));
      setSelectedStrategy(normalizeStrategyValue(data.strategy));
    } catch {
      // ignore
    }
  }, [toolId]);

  const saveMappings = useCallback(async (mappings, strategy) => {
    try {
      await fetch("/api/cli-tools/antigravity-mitm/alias", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: toolId,
          mappings: sanitizeMappingState(mappings),
          strategy: normalizeStrategyValue(strategy),
        }),
      });
    } catch {
      // ignore
    }
  }, [toolId]);

  const openModelSelector = useCallback((alias) => {
    setCurrentEditingAlias(alias);
    setModalOpen(true);
  }, []);

  const handleAddMapping = useCallback((alias, value = "") => {
    setModelMappings((prev) => appendMappingEntry(prev, alias, value));
  }, []);

  const handleModelMappingChange = useCallback((alias, index, value) => {
    setModelMappings((prev) => updateMappingEntry(prev, alias, index, value));
  }, []);

  const handleMappingBlur = useCallback((alias, index, value) => {
    setModelMappings((prev) => {
      const beforeCount = Array.isArray(prev?.[alias]) ? prev[alias].length : 0;
      const next = commitMappingEntryInput(prev, alias, index, value);
      const afterCount = Array.isArray(next?.[alias]) ? next[alias].length : 0;
      const expandedCount = String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean).length;

      if (expandedCount > 1 || afterCount < beforeCount) {
        setMappingFeedback(
          afterCount < beforeCount
            ? `Max 5 targets per alias. Extra models were ignored for ${alias}.`
            : `Expanded ${expandedCount} targets for ${alias}.`
        );
      } else {
        setMappingFeedback(null);
      }

      saveMappings(next, selectedStrategy);
      return next;
    });
  }, [saveMappings, selectedStrategy]);

  const handleRemoveMapping = useCallback((alias, index) => {
    setModelMappings((prev) => {
      const next = removeMappingEntry(prev, alias, index);
      saveMappings(next, selectedStrategy);
      return next;
    });
  }, [saveMappings, selectedStrategy]);

  const handleReorderMapping = useCallback((alias, fromIndex, toIndex) => {
    setModelMappings((prev) => {
      const next = reorderMappingEntry(prev, alias, fromIndex, toIndex);
      saveMappings(next, selectedStrategy);
      return next;
    });
  }, [saveMappings, selectedStrategy]);

  const handleModelSelect = useCallback((model) => {
    if (!currentEditingAlias || model.isPlaceholder) return;
    setModelMappings((prev) => {
      const next = appendMappingEntry(prev, currentEditingAlias, model.value);
      const beforeCount = Array.isArray(prev?.[currentEditingAlias]) ? prev[currentEditingAlias].length : 0;
      const afterCount = Array.isArray(next?.[currentEditingAlias]) ? next[currentEditingAlias].length : 0;
      setMappingFeedback(
        afterCount === beforeCount
          ? `Max 5 targets per alias. Remove one before adding another for ${currentEditingAlias}.`
          : null
      );
      saveMappings(next, selectedStrategy);
      return next;
    });
  }, [currentEditingAlias, saveMappings, selectedStrategy]);

  const handleStrategyChange = useCallback((strategy) => {
    const normalized = normalizeStrategyValue(strategy);
    setSelectedStrategy(normalized);
    setModelMappings((prev) => {
      saveMappings(prev, normalized);
      return prev;
    });
  }, [saveMappings]);

  return {
    currentEditingAlias,
    handleAddMapping,
    handleMappingBlur,
    handleModelMappingChange,
    handleModelSelect,
    handleRemoveMapping,
    handleReorderMapping,
    handleStrategyChange,
    loadSavedMappings,
    mappingFeedback,
    modalOpen,
    modelMappings,
    openModelSelector,
    selectedStrategy,
    setMappingFeedback,
    setModalOpen,
  };
}
