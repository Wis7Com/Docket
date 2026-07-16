"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Check, ChevronDown, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { MODELS } from "@/app/components/assistant/ModelToggle";
import {
  isModelAvailable,
  modelGroupToProvider,
} from "@/app/lib/modelAvailability";
import {
  OLLAMA_EMBEDDING_MODEL_OPTIONS,
  isOllamaEmbeddingPreset,
} from "@/app/lib/embeddingModels";

export default function ModelsAndApiKeysPage() {
  const {
    profile,
    updateModelPreference,
    updateApiKey,
    updateOpenAICompatibleBaseUrl,
    updateEmbeddingSettings,
  } = useUserProfile();

  return (
    <div className="space-y-4">
      {/* Model Preferences */}
      <div className="pb-6">
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-2xl font-medium font-serif">Model Preferences</h2>
        </div>
        <div className="space-y-4 max-w-md">
          <div>
            <label className="text-sm text-gray-600 block mb-2">
              Tabular review model
            </label>
            <TabularModelDropdown
              value={profile?.tabularModel ?? "gemini-3-flash-preview"}
              apiKeys={{
                claudeApiKey: profile?.claudeApiKey ?? null,
                geminiApiKey: profile?.geminiApiKey ?? null,
                openaiApiKey: profile?.openaiApiKey ?? null,
                openrouterApiKey: profile?.openrouterApiKey ?? null,
                nvidiaApiKey: profile?.nvidiaApiKey ?? null,
                openaiCompatibleApiKey: profile?.openaiCompatibleApiKey ?? null,
                openaiCompatibleBaseUrl:
                  profile?.openaiCompatibleBaseUrl ?? null,
              }}
              onChange={(id) => updateModelPreference("tabularModel", id)}
            />
          </div>
        </div>
      </div>

      <SemanticSearchSettings
        profile={profile}
        onSave={updateEmbeddingSettings}
      />

      {/* API Keys */}
      <div className="py-6">
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-2xl font-medium font-serif">API Keys</h2>
        </div>
        <p className="text-sm text-gray-500 mb-4 max-w-xl">
          Local Ollama, MLX, and Free Router proxy models work without API keys
          in Docket. Optional API keys stay in local app data and are only used to
          call the provider you choose.
        </p>
        <p className="text-xs text-gray-400 mb-4 max-w-xl">
          You can also keep keys in backend/.env. Free Router proxy listens at
          http://127.0.0.1:43110/v1 and selects the currently best responding
          free hosted model through its own local service configuration.
        </p>
        <div className="space-y-4 max-w-xl">
          <ApiKeyField
            label="OpenRouter API Key"
            placeholder="sk-or-..."
            helpHref="https://openrouter.ai/settings/keys"
            helpLabel="Where do I get an OpenRouter key?"
            initialValue={profile?.openrouterApiKey ?? ""}
            onSave={(value) => updateApiKey("openrouter", value.trim() || null)}
          />
          <ApiKeyField
            label="NVIDIA NIM API Key"
            placeholder="nvapi-..."
            helpHref="https://build.nvidia.com/"
            helpLabel="Where do I get an NVIDIA key?"
            initialValue={profile?.nvidiaApiKey ?? ""}
            onSave={(value) => updateApiKey("nvidia", value.trim() || null)}
          />
          <ApiKeyField
            label="OpenAI API Key"
            placeholder="sk-..."
            helpHref="https://platform.openai.com/api-keys"
            helpLabel="Where do I get an OpenAI key?"
            initialValue={profile?.openaiApiKey ?? ""}
            onSave={(value) => updateApiKey("openai", value.trim() || null)}
          />
          <ApiKeyField
            label="OpenAI-compatible Base URL"
            placeholder="http://127.0.0.1:8080/v1"
            initialValue={
              profile?.openaiCompatibleBaseUrl ?? "http://127.0.0.1:8080/v1"
            }
            onSave={(value) =>
              updateOpenAICompatibleBaseUrl(value.trim() || null)
            }
            secret={false}
          />
          <ApiKeyField
            label="OpenAI-compatible API Key"
            placeholder="local"
            initialValue={profile?.openaiCompatibleApiKey ?? ""}
            onSave={(value) =>
              updateApiKey("openaiCompatible", value.trim() || null)
            }
          />
          <ApiKeyField
            label="Anthropic (Claude) API Key"
            placeholder="sk-ant-…"
            helpHref="https://console.anthropic.com/settings/keys"
            helpLabel="Where do I get a Claude key?"
            initialValue={profile?.claudeApiKey ?? ""}
            onSave={(value) => updateApiKey("claude", value.trim() || null)}
          />
          <ApiKeyField
            label="Google (Gemini) API Key"
            placeholder="AI…"
            helpHref="https://aistudio.google.com/app/apikey"
            helpLabel="Where do I get a Gemini key?"
            initialValue={profile?.geminiApiKey ?? ""}
            onSave={(value) => updateApiKey("gemini", value.trim() || null)}
          />
        </div>
      </div>
    </div>
  );
}

function SemanticSearchSettings({
  profile,
  onSave,
}: {
  profile: ReturnType<typeof useUserProfile>["profile"];
  onSave: Parameters<
    ReturnType<typeof useUserProfile>["updateEmbeddingSettings"]
  >[0] extends infer Update
    ? (update: Update) => Promise<boolean>
    : never;
}) {
  const [provider, setProvider] = useState(
    profile?.embeddingProvider ?? "ollama",
  );
  const [model, setModel] = useState(
    profile?.embeddingModel ?? "batiai/qwen3-embedding:0.6b",
  );
  const [baseUrl, setBaseUrl] = useState(profile?.embeddingBaseUrl ?? "");
  const [apiKey, setApiKey] = useState(profile?.embeddingApiKey ?? "");
  const [dimensionsPolicy, setDimensionsPolicy] = useState(
    profile?.embeddingDimensionsPolicy ?? "truncate-to-256",
  );
  const [memoryProfile, setMemoryProfile] = useState(
    profile?.embeddingMemoryProfile ?? "lightweight",
  );
  const [enabled, setEnabled] = useState(profile?.embeddingEnabled ?? true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setProvider(profile?.embeddingProvider ?? "ollama");
    setModel(profile?.embeddingModel ?? "batiai/qwen3-embedding:0.6b");
    setBaseUrl(profile?.embeddingBaseUrl ?? "");
    setApiKey(profile?.embeddingApiKey ?? "");
    setDimensionsPolicy(profile?.embeddingDimensionsPolicy ?? "truncate-to-256");
    setMemoryProfile(profile?.embeddingMemoryProfile ?? "lightweight");
    setEnabled(profile?.embeddingEnabled ?? true);
  }, [profile]);

  async function save() {
    setSaving(true);
    setSaved(false);
    const ok = await onSave({
      embeddingProvider: provider,
      embeddingModel: model.trim() || "batiai/qwen3-embedding:0.6b",
      embeddingBaseUrl: baseUrl.trim() || null,
      embeddingApiKey: apiKey.trim() || null,
      embeddingDimensionsPolicy: dimensionsPolicy,
      embeddingMemoryProfile: memoryProfile,
      embeddingEnabled: enabled,
    });
    setSaving(false);
    if (ok) {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
    }
  }

  return (
    <div className="border-t border-gray-100 py-6">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-2xl font-medium font-serif">Semantic Search</h2>
      </div>
      <p className="text-sm text-gray-500 mb-4 max-w-xl">
        The default is a lightweight local Ollama embedding model. You can use
        another Ollama model, a local MLX OpenAI-compatible server, or a
        configured external compatible endpoint.
      </p>
      <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
        <label className="text-sm text-gray-600">
          <span className="mb-1 block">Provider</span>
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            className="h-9 w-full rounded-md border border-gray-300 bg-white px-3 text-sm"
          >
            <option value="ollama">Ollama</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
        </label>
        {provider === "ollama" ? (
          <div className="space-y-1">
            <label className="block text-sm text-gray-600">
              <span className="mb-1 block">Model</span>
              <select
                value={isOllamaEmbeddingPreset(model) ? model : "custom"}
                onChange={(event) =>
                  setModel(
                    event.target.value === "custom" ? "" : event.target.value,
                  )
                }
                className="h-9 w-full rounded-md border border-gray-300 bg-white px-3 text-sm"
              >
                {OLLAMA_EMBEDDING_MODEL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
            </label>
            {!isOllamaEmbeddingPreset(model) && (
              <Input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="Ollama model name"
              />
            )}
            <p className="text-xs text-gray-500">
              Changing the model rebuilds the semantic index with the new model.
              Existing indexes are preserved, so switching back restores them
              immediately; rebuilding may take several minutes for large document
              sets.
            </p>
          </div>
        ) : (
          <label className="text-sm text-gray-600">
            <span className="mb-1 block">Model</span>
            <Input
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </label>
        )}
        <label className="text-sm text-gray-600">
          <span className="mb-1 block">Base URL</span>
          <Input
            placeholder={
              provider === "ollama"
                ? "http://127.0.0.1:11434"
                : "http://127.0.0.1:8080/v1"
            }
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <label className="text-sm text-gray-600">
          <span className="mb-1 block">API Key</span>
          <Input
            placeholder={provider === "ollama" ? "optional" : "local or sk-..."}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <label className="text-sm text-gray-600">
          <span className="mb-1 block">Dimensions</span>
          <select
            value={dimensionsPolicy}
            onChange={(event) => setDimensionsPolicy(event.target.value)}
            className="h-9 w-full rounded-md border border-gray-300 bg-white px-3 text-sm"
          >
            <option value="truncate-to-256">Truncate to 256</option>
            <option value="truncate-to-512">Truncate to 512</option>
            <option value="native">Native</option>
            <option value="provider">Provider override</option>
          </select>
        </label>
        <label className="text-sm text-gray-600">
          <span className="mb-1 block">Memory Profile</span>
          <select
            value={memoryProfile}
            onChange={(event) => setMemoryProfile(event.target.value)}
            className="h-9 w-full rounded-md border border-gray-300 bg-white px-3 text-sm"
          >
            <option value="lightweight">Lightweight</option>
            <option value="balanced">Balanced</option>
            <option value="performance">Performance</option>
          </select>
        </label>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enable semantic search
        </label>
        <Button type="button" size="sm" disabled={saving} onClick={save}>
          {saving ? "Saving..." : saved ? "Saved" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function TabularModelDropdown({
  value,
  onChange,
  apiKeys,
}: {
  value: string;
  onChange: (id: string) => void;
  apiKeys: {
    claudeApiKey: string | null;
    geminiApiKey: string | null;
    openaiApiKey?: string | null;
    openrouterApiKey?: string | null;
    nvidiaApiKey?: string | null;
    openaiCompatibleApiKey?: string | null;
    openaiCompatibleBaseUrl?: string | null;
  };
}) {
  const [isOpen, setIsOpen] = useState(false);
  const selected = MODELS.find((m) => m.id === value);
  const selectedAvailable = isModelAvailable(value, apiKeys);
  const groups = [
    "Local",
    "Router",
    "OpenAI",
    "OpenAI-compatible",
    "Anthropic",
    "Google",
  ] as const;

  return (
    <DropdownMenu onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="w-full h-9 rounded-md border border-gray-300 bg-white px-3 text-sm shadow-sm flex items-center justify-between gap-2 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-black/10"
        >
          <span className="flex items-center gap-2 min-w-0">
            {!selectedAvailable && (
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
            )}
            <span className="truncate text-gray-900">
              {selected?.label ?? "Select a model"}
            </span>
          </span>
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="z-50"
        style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
        align="start"
      >
        {groups.map((group, gi) => {
          const items = MODELS.filter((m) => m.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group}>
              {gi > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                {group}
              </DropdownMenuLabel>
              {items.map((m) => {
                const provider = modelGroupToProvider(m.group);
                const available = isModelAvailable(m.id, apiKeys);
                return (
                  <DropdownMenuItem
                    key={m.id}
                    className="cursor-pointer"
                    onSelect={() => onChange(m.id)}
                    title={
                      !available
                        ? `Add credentials for ${provider} to use this model`
                        : undefined
                    }
                  >
                    <span
                      className={`flex-1 ${available ? "" : "text-gray-400"}`}
                    >
                      {m.label}
                    </span>
                    {!available && (
                      <AlertCircle className="h-3.5 w-3.5 text-red-500 ml-1" />
                    )}
                    {m.id === value && available && (
                      <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />
                    )}
                  </DropdownMenuItem>
                );
              })}
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ApiKeyField({
  label,
  placeholder,
  initialValue,
  onSave,
  helpHref,
  helpLabel,
  secret = true,
}: {
  label: string;
  placeholder: string;
  initialValue: string;
  onSave: (value: string) => Promise<boolean>;
  helpHref?: string;
  helpLabel?: string;
  secret?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  const [reveal, setReveal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  const dirty = value !== initialValue;

  const handleSave = async () => {
    setIsSaving(true);
    const ok = await onSave(value);
    setIsSaving(false);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      alert(`Failed to save ${label}.`);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-sm text-gray-600">{label}</label>
        {helpHref ? (
          <a
            href={helpHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-gray-400 hover:text-gray-700 underline-offset-2 hover:underline"
          >
            {helpLabel ?? "Where do I get this?"}
          </a>
        ) : null}
      </div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            type={!secret || reveal ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            className="pr-10"
            autoComplete="off"
            spellCheck={false}
          />
          {secret ? (
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              className="absolute inset-y-0 right-2 flex items-center text-gray-400 hover:text-gray-600"
              aria-label={reveal ? "Hide key" : "Show key"}
            >
              {reveal ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          ) : null}
        </div>
        <Button
          onClick={handleSave}
          disabled={isSaving || !dirty || saved}
          className="min-w-[80px] transition-all bg-black hover:bg-gray-900 text-white"
        >
          {isSaving ? (
            "Saving..."
          ) : saved ? (
            <>
              <Check className="h-4 w-3" />
              Saved
            </>
          ) : (
            "Save"
          )}
        </Button>
      </div>
    </div>
  );
}
