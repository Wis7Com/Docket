"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check, Monitor, Moon, RefreshCw, Sun } from "lucide-react";
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
  const [isSavingName, setIsSavingName] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (profile?.displayName) {
      setDisplayName(profile.displayName);
    }
  }, [profile]);

  const handleSaveDisplayName = async () => {
    setIsSavingName(true);
    const success = await updateDisplayName(displayName.trim());
    setIsSavingName(false);

    if (success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      alert("Failed to update display name. Please try again.");
    }
  };

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
            <label className="text-sm text-gray-600 block mb-2">
              Display Name
            </label>
            <div className="flex gap-2">
              <Input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Enter your name"
                className="flex-1"
              />
              <Button
                onClick={handleSaveDisplayName}
                disabled={isSavingName || !displayName.trim() || saved}
                className="min-w-[80px] transition-all bg-black hover:bg-gray-900 text-white"
              >
                {isSavingName ? (
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
            ) : capabilities ? (
              <p className="text-sm text-amber-700">
                Not detected. LibreOffice ships bundled with Docket — if this
                message persists, the install may be incomplete. Try
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
