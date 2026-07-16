import {
  OLLAMA_EMBEDDING_MODEL_OPTIONS,
  isOllamaEmbeddingPreset,
} from "./embeddingModels";

export type ProjectEmbeddingModelStatus = {
  model: string;
  dimensions: number;
  ready: number;
  total: number;
};

export type ProjectEmbeddingSelection = {
  value: string | null;
  label: string;
  readiness: string | null;
};

export function projectEmbeddingSelections(
  models: ProjectEmbeddingModelStatus[],
): ProjectEmbeddingSelection[] {
  const selections: ProjectEmbeddingSelection[] = [
    { value: null, label: "Default — global model", readiness: null },
    ...OLLAMA_EMBEDDING_MODEL_OPTIONS.map((option) => ({
      value: option.value,
      label: option.label,
      readiness: null,
    })),
  ];
  const known = new Set(selections.map((selection) => selection.value));
  for (const model of models) {
    if (isOllamaEmbeddingPreset(model.model) || known.has(model.model)) continue;
    known.add(model.model);
    selections.push({
      value: model.model,
      label: model.model,
      readiness: null,
    });
  }
  return selections.map((selection) => {
    if (selection.value === null) return selection;
    const status = models.find((model) => model.model === selection.value);
    return {
      ...selection,
      readiness: status
        ? `${status.ready}/${status.total}`
        : "not embedded",
    };
  });
}

export function shouldShowProjectEmbeddingWarning(semantic: {
  enabled: boolean;
  override: string | null;
  ready_vectors: number;
  total_vectors: number;
}): boolean {
  return (
    semantic.enabled &&
    semantic.override !== null &&
    semantic.ready_vectors < semantic.total_vectors
  );
}
