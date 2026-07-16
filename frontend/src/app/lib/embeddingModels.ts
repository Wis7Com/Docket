export const OLLAMA_EMBEDDING_MODEL_OPTIONS = [
  {
    value: "batiai/qwen3-embedding:0.6b",
    label: "Qwen3 Embedding 0.6B — fast indexing (default)",
  },
  {
    value: "batiai/qwen3-embedding:4b",
    label: "Qwen3 Embedding 4B — higher retrieval quality (~4–5× slower indexing)",
  },
] as const;

export function isOllamaEmbeddingPreset(model: string): boolean {
  return OLLAMA_EMBEDDING_MODEL_OPTIONS.some(
    (option) => option.value === model,
  );
}
