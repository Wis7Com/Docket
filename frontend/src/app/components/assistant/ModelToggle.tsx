"use client";

import { useState } from "react";
import { ChevronDown, Check, AlertCircle } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isModelAvailable } from "@/app/lib/modelAvailability";

export interface ModelOption {
  id: string;
  label: string;
  group:
    | "Local"
    | "Router"
    | "OpenAI"
    | "OpenAI-compatible"
    | "Anthropic"
    | "Google";
}

export const MODELS: ModelOption[] = [
  {
    id: "ollama:gemma4:31b-it-q4_K_M",
    label: "Ollama Gemma 4 31B",
    group: "Local",
  },
  {
    id: "ollama:gemma4:12b-mlx",
    label: "Ollama Gemma 4 12B MLX",
    group: "Local",
  },
  {
    id: "ollama:gemma4:26b-a4b-it-q4_K_M",
    label: "Ollama Gemma 4 26B",
    group: "Local",
  },
  {
    id: "ollama:gemma4:26b-claude-32k",
    label: "Ollama Gemma 4 26B 32K",
    group: "Local",
  },
  {
    id: "ollama:gemma4:26b-claude-64k",
    label: "Ollama Gemma 4 26B 64K",
    group: "Local",
  },
  {
    id: "mlx:mlx-community/gemma-4-26b-a4b-it-4bit",
    label: "MLX Gemma 4 26B",
    group: "Local",
  },
  {
    id: "mlx:mlx-community/Qwen3.6-35B-A3B-4bit",
    label: "MLX Qwen3.6 35B MoE",
    group: "Local",
  },
  {
    id: "free-router:free-router/best",
    label: "Free Router Best (local proxy)",
    group: "Router",
  },
  { id: "free-router:auto", label: "Free Router Best (CLI)", group: "Router" },
  {
    id: "openrouter:openai/gpt-oss-120b",
    label: "OpenRouter GPT OSS 120B",
    group: "Router",
  },
  {
    id: "nvidia:deepseek-ai/deepseek-v4-pro",
    label: "NVIDIA NIM DeepSeek V4 Pro",
    group: "Router",
  },
  { id: "openai:gpt-4o-mini", label: "GPT-4o mini", group: "OpenAI" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", group: "Anthropic" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", group: "Google" },
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", group: "Google" },
];

export const DEFAULT_MODEL_ID = "gemini-3-flash-preview";

export const ALLOWED_MODEL_IDS = new Set(MODELS.map((m) => m.id));

const GROUP_ORDER: ModelOption["group"][] = [
  "Local",
  "Router",
  "OpenAI",
  "OpenAI-compatible",
  "Anthropic",
  "Google",
];

interface Props {
  value: string;
  onChange: (id: string) => void;
  apiKeys?: {
    claudeApiKey: string | null;
    geminiApiKey: string | null;
    openaiApiKey?: string | null;
    openrouterApiKey?: string | null;
    nvidiaApiKey?: string | null;
    openaiCompatibleApiKey?: string | null;
    openaiCompatibleBaseUrl?: string | null;
  };
}

export function ModelToggle({ value, onChange, apiKeys }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const selected = MODELS.find((m) => m.id === value);
  const selectedLabel = selected?.label ?? "Model";
  const selectedAvailable = apiKeys ? isModelAvailable(value, apiKeys) : true;

  return (
    <DropdownMenu onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-session-check="model-toggle"
          className={`flex items-center gap-1.5 rounded-lg px-2 h-8 text-sm transition-colors cursor-pointer text-gray-400 hover:bg-gray-100 hover:text-gray-700 ${isOpen ? "bg-gray-100 text-gray-700" : ""}`}
          title={
            !selectedAvailable
              ? "API key missing for selected model"
              : "Choose model"
          }
        >
          {!selectedAvailable && (
            <AlertCircle className="h-3 w-3 shrink-0 text-red-500" />
          )}
          <span className="max-w-[140px] truncate">{selectedLabel}</span>
          <ChevronDown
            className={`h-3 w-3 shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56 z-50" side="top" align="start">
        {GROUP_ORDER.map((group, gi) => {
          const items = MODELS.filter((m) => m.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group}>
              {gi > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                {group}
              </DropdownMenuLabel>
              {items.map((m) => {
                const available = apiKeys
                  ? isModelAvailable(m.id, apiKeys)
                  : true;
                return (
                  <DropdownMenuItem
                    key={m.id}
                    data-session-check="model-option"
                    data-model-id={m.id}
                    className="cursor-pointer"
                    onSelect={() => onChange(m.id)}
                  >
                    <span
                      className={`flex-1 ${available ? "" : "text-gray-400"}`}
                    >
                      {m.label}
                    </span>
                    {!available && (
                      <AlertCircle
                        className="h-3.5 w-3.5 text-red-500 ml-1"
                        aria-label="API key missing"
                      />
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
