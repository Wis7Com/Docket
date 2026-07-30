"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Monitor, Moon, RefreshCw, Sun } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { useTheme, type ThemePreference } from "@/contexts/ThemeContext";
import { useCapabilities } from "@/app/hooks/useCapabilities";

const THEME_OPTIONS: {
  value: ThemePreference;
  label: string;
  icon: typeof Sun;
}[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

export default function AccountPage() {
  const { user } = useAuth();
  const { profile, updateDisplayName } = useUserProfile();
  const { capabilities, loading: capabilitiesLoading, refresh } = useCapabilities();
  const { theme, setTheme } = useTheme();
  const [displayName, setDisplayName] = useState("");
  const [nameStatus, setNameStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  // What the server currently holds, so a re-render from the profile reload
  // that follows a save doesn't look like a fresh edit and save again.
  const savedNameRef = useRef<string | null>(null);

  // Seed the field once, from the first profile that loads. Later profile
  // updates are echoes of our own saves and must not overwrite what the user
  // is typing.
  useEffect(() => {
    if (savedNameRef.current !== null || !profile) return;
    savedNameRef.current = profile.displayName ?? "";
    setDisplayName(profile.displayName ?? "");
  }, [profile]);

  // Autosave: settings persist on their own, so there is no Save button to
  // forget to press. An empty field is treated as "still typing" rather than
  // as a request to clear the name.
  useEffect(() => {
    const trimmed = displayName.trim();
    if (savedNameRef.current === null) return;
    if (!trimmed || trimmed === savedNameRef.current) return;

    let active = true;
    const timer = setTimeout(async () => {
      setNameStatus("saving");
      const ok = await updateDisplayName(trimmed);
      if (!active) return;
      if (ok) savedNameRef.current = trimmed;
      setNameStatus(ok ? "saved" : "error");
    }, 600);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [displayName, updateDisplayName]);

  // Let "Saved" fade out; a failure stays put until the next edit.
  useEffect(() => {
    if (nameStatus !== "saved") return;
    const timer = setTimeout(() => setNameStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [nameStatus]);

  if (!user) return null;

  return (
    <div className="space-y-4">
      {/* Profile Settings */}
      <div className="pb-6">
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-2xl font-medium font-serif">Profile</h2>
        </div>
        <div className="space-y-4">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <label className="text-sm text-gray-600">Display Name</label>
              {nameStatus === "saving" && (
                <span className="text-xs text-gray-400">Saving…</span>
              )}
              {nameStatus === "saved" && (
                <span className="text-xs text-gray-400">Saved</span>
              )}
              {nameStatus === "error" && (
                <span className="text-xs text-amber-700">
                  Couldn&apos;t save — retry by editing the field.
                </span>
              )}
            </div>
            <Input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Enter your name"
              className="max-w-md"
            />
          </div>
        </div>
      </div>

      {/* Appearance */}
      <div className="py-6">
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-2xl font-medium font-serif">Appearance</h2>
        </div>
        <div>
          <label className="text-sm text-gray-600 block mb-2">UI Theme</label>
          <div className="inline-flex gap-1 rounded-lg border border-gray-200 p-1">
            {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                onClick={() => setTheme(value)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
                  theme === value
                    ? "bg-gray-900 text-white"
                    : "text-gray-600 hover:bg-gray-100"
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* System */}
      <div className="py-6">
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-2xl font-medium font-serif">System</h2>
        </div>
        <div className="space-y-3 max-w-xl">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <p className="text-sm text-gray-600">
                LibreOffice
                <span className="text-xs text-gray-400 ml-2">
                  (used to convert Word documents to PDF for preview)
                </span>
              </p>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => void refresh()}
                disabled={capabilitiesLoading}
                aria-label="Refresh LibreOffice status"
              >
                <RefreshCw
                  className={`h-4 w-4 ${capabilitiesLoading ? "animate-spin" : ""}`}
                />
              </Button>
            </div>
            {capabilities?.libreoffice.available ? (
              <p className="text-sm text-green-700">
                Installed
                {capabilities.libreoffice.version
                  ? ` — ${capabilities.libreoffice.version}`
                  : ""}
              </p>
            ) : capabilities?.libreoffice.install_url ? (
              <p className="text-sm text-amber-700">
                Not detected. Word uploads still work for text, but PDF preview
                is unavailable until you{" "}
                <a
                  href={capabilities.libreoffice.install_url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-amber-900"
                >
                  install LibreOffice
                </a>
                .
              </p>
            ) : capabilities ? (
              <p className="text-sm text-amber-700">
                Not detected. LibreOffice ships bundled with Docket on Windows —
                if this message persists, the install may be incomplete. Try
                reinstalling Docket. Word uploads still work for text, but PDF
                preview is unavailable.
              </p>
            ) : (
              <p className="text-sm text-gray-400">Checking…</p>
            )}
          </div>
        </div>
      </div>

      {/* About */}
      <div className="py-6">
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-2xl font-medium font-serif">About</h2>
        </div>
        <div className="space-y-2 max-w-xl text-sm text-gray-600">
          <p>
            Docket is a local desktop AI legal platform. It is a derivative of{" "}
            <a
              href="https://github.com/rafal-fryc/mikelocal"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-gray-900"
            >
              mikelocal
            </a>
            , the Electron desktop edition of{" "}
            <a
              href="https://github.com/Open-Legal-Products/mike"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-gray-900"
            >
              Mike
            </a>
            , an open-source AI legal platform. All three projects are licensed
            under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
          </p>
          <p>
            Original Mike portions © the Mike contributors. Desktop port
            portions © the mikelocal contributors. Docket modifications © 2026
            the Docket contributors. Source code, including the full license
            text, is available in the project repository.
          </p>
        </div>
      </div>
    </div>
  );
}
