"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { getRerankerStatus, type RerankerStatus } from "@/app/lib/docketApi";

type Profile = ReturnType<typeof useUserProfile>["profile"];
type SaveReranker = ReturnType<typeof useUserProfile>["updateRerankerSettings"];

const DEFAULT_DEPTH = 30;
const DEFAULT_MODEL_PATH =
  "~/Library/Application Support/docket-desktop/models/qwen3-reranker-0.6b-q8_0.gguf";
const DEPTH_OPTIONS = [
  { value: 20, label: "20 — Fast (~2 s)" },
  { value: 30, label: "30 — Balanced (~3 s, default)" },
  { value: 50, label: "50 — Accurate (~5 s)" },
] as const;

const SERVER_STATE_LABEL: Record<RerankerStatus["server"], string> = {
  running: "Server running",
  starting: "Server starting",
  stopped: "Server idle (starts on the first search)",
  disabled: "Server disabled",
  external: "Using external server",
};

function StatusLine({
  status,
  failed,
}: {
  status: RerankerStatus | null;
  failed: boolean;
}) {
  if (failed) {
    return <p className="text-sm text-gray-500">Status unavailable.</p>;
  }
  if (!status) {
    return <p className="text-sm text-gray-400">Checking status...</p>;
  }

  const problems: string[] = [];
  if (status.binary === "missing") {
    problems.push(
      "llama-server not found — install with `brew install llama.cpp`",
    );
  }
  if (status.model === "missing") {
    problems.push(
      `Model file not found — run \`scripts/prepare-reranker-model.sh\` (expected at ${
        status.model_path ?? DEFAULT_MODEL_PATH
      })`,
    );
  }

  return (
    <div className="space-y-1">
      {problems.length === 0 ? (
        <p className="text-sm text-green-700">Ready</p>
      ) : (
        problems.map((problem) => (
          <p key={problem} className="text-sm text-amber-700">
            {problem}
          </p>
        ))
      )}
      <p className="text-xs text-gray-400">
        {SERVER_STATE_LABEL[status.server]}
      </p>
      {status.server === "disabled" && status.last_error && (
        <p className="text-xs text-red-600">{status.last_error}</p>
      )}
    </div>
  );
}

export function RerankerSection({
  profile,
  onSave,
}: {
  profile: Profile;
  onSave: SaveReranker;
}) {
  const [status, setStatus] = useState<RerankerStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  // null = the user has not chosen, so the toggle mirrors the live default.
  const [enabledChoice, setEnabledChoice] = useState<boolean | null>(
    profile?.rerankerEnabled ?? null,
  );
  const [depth, setDepth] = useState(profile?.rerankerDepth ?? DEFAULT_DEPTH);
  const [baseUrl, setBaseUrl] = useState(profile?.rerankerBaseUrl ?? "");
  const [modelPath, setModelPath] = useState(profile?.rerankerModelPath ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await getRerankerStatus());
      setStatusFailed(false);
    } catch {
      setStatusFailed(true);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    setEnabledChoice(profile?.rerankerEnabled ?? null);
    setDepth(profile?.rerankerDepth ?? DEFAULT_DEPTH);
    setBaseUrl(profile?.rerankerBaseUrl ?? "");
    setModelPath(profile?.rerankerModelPath ?? "");
  }, [profile]);

  const checked = enabledChoice ?? status?.enabled ?? false;

  async function save() {
    setSaving(true);
    setSaved(false);
    setSaveFailed(false);
    const ok = await onSave({
      rerankerEnabled: enabledChoice,
      // Keep the default as null so a future change of the built-in default
      // reaches users who never picked a depth.
      rerankerDepth:
        depth === DEFAULT_DEPTH && profile?.rerankerDepth == null
          ? null
          : depth,
      rerankerBaseUrl: baseUrl.trim() || null,
      rerankerModelPath: modelPath.trim() || null,
    });
    setSaving(false);
    if (ok) {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
      await refreshStatus();
    } else {
      setSaveFailed(true);
    }
  }

  return (
    <div className="border-t border-gray-100 py-6">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-2xl font-medium font-serif">Search Reranking</h2>
      </div>
      <p className="text-sm text-gray-500 mb-4 max-w-xl">
        Re-scores the top search candidates with a small local cross-encoder for
        more precise citations, at the cost of a few seconds per search.
      </p>
      <div className="mb-4 max-w-xl">
        <StatusLine status={status} failed={statusFailed} />
      </div>
      <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
        <label className="text-sm text-gray-600">
          <span className="mb-1 block">Candidates to re-score</span>
          <select
            value={depth}
            onChange={(event) => setDepth(Number(event.target.value))}
            className="h-9 w-full rounded-md border border-gray-300 bg-white px-3 text-sm"
          >
            {DEPTH_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <details className="mt-4 max-w-2xl">
        <summary className="cursor-pointer text-sm text-gray-600">
          Advanced
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-gray-600">
            <span className="mb-1 block">External rerank server URL</span>
            <Input
              placeholder="http://127.0.0.1:8012"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="text-sm text-gray-600">
            <span className="mb-1 block">Model file path</span>
            <Input
              placeholder={DEFAULT_MODEL_PATH}
              value={modelPath}
              onChange={(event) => setModelPath(event.target.value)}
              spellCheck={false}
            />
          </label>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          When a URL is set, Docket does not start its own server.
        </p>
      </details>
      <div className="mt-4 flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => setEnabledChoice(event.target.checked)}
          />
          Enable search reranking
        </label>
        <Button type="button" size="sm" disabled={saving} onClick={save}>
          {saving ? "Saving..." : saved ? "Saved" : "Save"}
        </Button>
        {saveFailed && (
          <span className="text-xs text-red-600">
            Could not save. Check the URL and file path.
          </span>
        )}
      </div>
      {enabledChoice === null && (
        <p className="mt-2 text-xs text-gray-500">
          Default: on when the model is installed
        </p>
      )}
    </div>
  );
}
