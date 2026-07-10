"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
  useCallback,
} from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { getApiBase } from "@/app/lib/docketApi";

interface UserProfile {
  displayName: string | null;
  organisation: string | null;
  messageCreditsUsed: number;
  creditsResetDate: string;
  creditsRemaining: number;
  tier: string;
  tabularModel: string;
  claudeApiKey: string | null;
  geminiApiKey: string | null;
  openaiApiKey: string | null;
  openrouterApiKey: string | null;
  nvidiaApiKey: string | null;
  openaiCompatibleApiKey: string | null;
  openaiCompatibleBaseUrl: string | null;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingBaseUrl: string | null;
  embeddingApiKey: string | null;
  embeddingDimensionsPolicy: string;
  embeddingEnabled: boolean;
  embeddingMemoryProfile: string;
  chatFullReadMaxDocs: number;
  chatFullReadMaxTextBytes: number;
  chatFetchMaxDocs: number;
  chatFetchMaxTextBytes: number;
}

interface UserProfileContextType {
  profile: UserProfile | null;
  loading: boolean;
  updateDisplayName: (name: string) => Promise<boolean>;
  updateOrganisation: (organisation: string) => Promise<boolean>;
  updateModelPreference: (
    field: "tabularModel",
    value: string,
  ) => Promise<boolean>;
  updateApiKey: (
    provider:
      | "claude"
      | "gemini"
      | "openai"
      | "openrouter"
      | "nvidia"
      | "openaiCompatible",
    value: string | null,
  ) => Promise<boolean>;
  updateOpenAICompatibleBaseUrl: (value: string | null) => Promise<boolean>;
  updateEmbeddingSettings: (
    update: Partial<
      Pick<
        UserProfile,
        | "embeddingProvider"
        | "embeddingModel"
        | "embeddingBaseUrl"
        | "embeddingApiKey"
        | "embeddingDimensionsPolicy"
        | "embeddingEnabled"
        | "embeddingMemoryProfile"
        | "chatFullReadMaxDocs"
        | "chatFullReadMaxTextBytes"
        | "chatFetchMaxDocs"
        | "chatFetchMaxTextBytes"
      >
    >,
  ) => Promise<boolean>;
  reloadProfile: () => Promise<void>;
}

const UserProfileContext = createContext<UserProfileContextType | undefined>(
  undefined,
);

// Local desktop build: credit metering is meaningless (no SaaS billing).
// Keep the field set high so all UI paths gating on it pass.
const UNMETERED = 999_999;

interface ServerProfile {
  user_id: string;
  display_name: string | null;
  organisation: string | null;
  tier: string | null;
  message_credits_used: number;
  credits_reset_date: string;
  tabular_model: string | null;
  claude_api_key: string | null;
  gemini_api_key: string | null;
  openai_api_key: string | null;
  openrouter_api_key: string | null;
  nvidia_api_key: string | null;
  openai_compatible_api_key: string | null;
  openai_compatible_base_url: string | null;
  embedding_provider: string | null;
  embedding_model: string | null;
  embedding_base_url: string | null;
  embedding_api_key: string | null;
  embedding_dimensions_policy: string | null;
  embedding_enabled: number | boolean | null;
  embedding_memory_profile: string | null;
  chat_full_read_max_docs: number | null;
  chat_full_read_max_text_bytes: number | null;
  chat_fetch_max_docs: number | null;
  chat_fetch_max_text_bytes: number | null;
}

function toClientProfile(p: ServerProfile | null): UserProfile {
  return {
    displayName: p?.display_name ?? null,
    organisation: p?.organisation ?? null,
    messageCreditsUsed: p?.message_credits_used ?? 0,
    creditsResetDate: p?.credits_reset_date ?? new Date().toISOString(),
    creditsRemaining: UNMETERED,
    tier: p?.tier ?? "Free",
    tabularModel: p?.tabular_model ?? "gemini-3-flash-preview",
    claudeApiKey: p?.claude_api_key ?? null,
    geminiApiKey: p?.gemini_api_key ?? null,
    openaiApiKey: p?.openai_api_key ?? null,
    openrouterApiKey: p?.openrouter_api_key ?? null,
    nvidiaApiKey: p?.nvidia_api_key ?? null,
    openaiCompatibleApiKey: p?.openai_compatible_api_key ?? null,
    openaiCompatibleBaseUrl: p?.openai_compatible_base_url ?? null,
    embeddingProvider: p?.embedding_provider ?? "ollama",
    embeddingModel: p?.embedding_model ?? "batiai/qwen3-embedding:0.6b",
    embeddingBaseUrl: p?.embedding_base_url ?? null,
    embeddingApiKey: p?.embedding_api_key ?? null,
    embeddingDimensionsPolicy:
      p?.embedding_dimensions_policy ?? "truncate-to-256",
    embeddingEnabled: p?.embedding_enabled !== 0 && p?.embedding_enabled !== false,
    embeddingMemoryProfile: p?.embedding_memory_profile ?? "lightweight",
    chatFullReadMaxDocs: p?.chat_full_read_max_docs ?? 20,
    chatFullReadMaxTextBytes: p?.chat_full_read_max_text_bytes ?? 300000,
    chatFetchMaxDocs: p?.chat_fetch_max_docs ?? 3,
    chatFetchMaxTextBytes: p?.chat_fetch_max_text_bytes ?? 300000,
  };
}

async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token
    ? { Authorization: `Bearer ${session.access_token}` }
    : {};
}

async function fetchProfile(): Promise<ServerProfile | null> {
  try {
    const headers = await authHeaders();
    const resp = await fetch(`${await getApiBase()}/user/profile`, { headers });
    if (!resp.ok) return null;
    return (await resp.json()) as ServerProfile;
  } catch (err) {
    console.warn("[profile] fetch failed:", err);
    return null;
  }
}

async function patchProfile(
  update: Partial<ServerProfile>,
): Promise<ServerProfile | null> {
  try {
    const headers = await authHeaders();
    const resp = await fetch(`${await getApiBase()}/user/profile`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as ServerProfile;
  } catch (err) {
    console.warn("[profile] patch failed:", err);
    return null;
  }
}

export function UserProfileProvider({ children }: { children: ReactNode }) {
  const { user, isAuthenticated } = useAuth();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async () => {
    const server = await fetchProfile();
    setProfile(toClientProfile(server));
  }, []);

  useEffect(() => {
    if (isAuthenticated && user) {
      setLoading(true);
      loadProfile().finally(() => setLoading(false));
    } else {
      setProfile(null);
      setLoading(false);
    }
  }, [isAuthenticated, user, loadProfile]);

  useEffect(() => {
    const reload = (event: Event) => {
      const detail = (event as CustomEvent<Partial<UserProfile>>).detail;
      if (detail && typeof detail === "object") {
        setProfile((prev) => ({
          ...(prev ?? toClientProfile(null)),
          ...detail,
        }));
      }
      void loadProfile();
    };
    window.addEventListener("docket:profile-reload", reload);
    return () => window.removeEventListener("docket:profile-reload", reload);
  }, [loadProfile]);

  const updateDisplayName = useCallback(
    async (displayName: string): Promise<boolean> => {
      const updated = await patchProfile({ display_name: displayName });
      if (!updated) return false;
      setProfile(toClientProfile(updated));
      return true;
    },
    [],
  );

  const updateOrganisation = useCallback(
    async (organisation: string): Promise<boolean> => {
      const updated = await patchProfile({ organisation });
      if (!updated) return false;
      setProfile(toClientProfile(updated));
      return true;
    },
    [],
  );

  const updateModelPreference = useCallback(
    async (field: "tabularModel", value: string): Promise<boolean> => {
      if (field !== "tabularModel") return false;
      const updated = await patchProfile({ tabular_model: value });
      if (!updated) return false;
      setProfile(toClientProfile(updated));
      return true;
    },
    [],
  );

  const updateApiKey = useCallback(
    async (
      provider:
        | "claude"
        | "gemini"
        | "openai"
        | "openrouter"
        | "nvidia"
        | "openaiCompatible",
      value: string | null,
    ): Promise<boolean> => {
      const fieldByProvider = {
        claude: "claude_api_key",
        gemini: "gemini_api_key",
        openai: "openai_api_key",
        openrouter: "openrouter_api_key",
        nvidia: "nvidia_api_key",
        openaiCompatible: "openai_compatible_api_key",
      } as const;
      const dbField = fieldByProvider[provider];
      const normalized = value?.trim() ? value.trim() : null;
      const updated = await patchProfile({ [dbField]: normalized });
      if (!updated) return false;
      setProfile(toClientProfile(updated));
      return true;
    },
    [],
  );

  const updateOpenAICompatibleBaseUrl = useCallback(
    async (value: string | null): Promise<boolean> => {
      const normalized = value?.trim() ? value.trim() : null;
      const updated = await patchProfile({
        openai_compatible_base_url: normalized,
      });
      if (!updated) return false;
      setProfile(toClientProfile(updated));
      return true;
    },
    [],
  );

  const updateEmbeddingSettings = useCallback(
    async (
      update: Parameters<UserProfileContextType["updateEmbeddingSettings"]>[0],
    ): Promise<boolean> => {
      const serverUpdate: Partial<ServerProfile> = {};
      if (update.embeddingProvider != null)
        serverUpdate.embedding_provider = update.embeddingProvider;
      if (update.embeddingModel != null)
        serverUpdate.embedding_model = update.embeddingModel;
      if ("embeddingBaseUrl" in update)
        serverUpdate.embedding_base_url = update.embeddingBaseUrl?.trim() || null;
      if ("embeddingApiKey" in update)
        serverUpdate.embedding_api_key = update.embeddingApiKey?.trim() || null;
      if (update.embeddingDimensionsPolicy != null)
        serverUpdate.embedding_dimensions_policy =
          update.embeddingDimensionsPolicy;
      if (update.embeddingEnabled != null)
        serverUpdate.embedding_enabled = update.embeddingEnabled ? 1 : 0;
      if (update.embeddingMemoryProfile != null)
        serverUpdate.embedding_memory_profile = update.embeddingMemoryProfile;
      if (update.chatFullReadMaxDocs != null)
        serverUpdate.chat_full_read_max_docs = update.chatFullReadMaxDocs;
      if (update.chatFullReadMaxTextBytes != null)
        serverUpdate.chat_full_read_max_text_bytes =
          update.chatFullReadMaxTextBytes;
      if (update.chatFetchMaxDocs != null)
        serverUpdate.chat_fetch_max_docs = update.chatFetchMaxDocs;
      if (update.chatFetchMaxTextBytes != null)
        serverUpdate.chat_fetch_max_text_bytes = update.chatFetchMaxTextBytes;
      const updated = await patchProfile(serverUpdate);
      if (!updated) return false;
      setProfile(toClientProfile(updated));
      return true;
    },
    [],
  );

  const reloadProfile = useCallback(async () => {
    await loadProfile();
  }, [loadProfile]);

  return (
    <UserProfileContext.Provider
      value={{
        profile,
        loading,
        updateDisplayName,
        updateOrganisation,
        updateModelPreference,
        updateApiKey,
        updateOpenAICompatibleBaseUrl,
        updateEmbeddingSettings,
        reloadProfile,
      }}
    >
      {children}
    </UserProfileContext.Provider>
  );
}

export function useUserProfile() {
  const context = useContext(UserProfileContext);
  if (context === undefined) {
    throw new Error("useUserProfile must be used within a UserProfileProvider");
  }
  return context;
}
