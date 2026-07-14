"use client";

import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import {
  getProjectColorLegend,
  putProjectColorLegend,
  type ColorLegendEntry,
} from "@/app/lib/docketApi";
import type { AnnotationColorFamily } from "@/app/components/shared/types";
import { useAnnotationColorPalette } from "@/contexts/AnnotationColorPaletteContext";

const FAMILIES: readonly AnnotationColorFamily[] = ["red", "orange", "yellow", "green", "blue", "purple", "pink", "gray"];

const FALLBACK_COLORS: Record<AnnotationColorFamily, string> = {
  red: "#ff8787",
  orange: "#ffc078",
  yellow: "#ffe066",
  green: "#8ce99a",
  blue: "#74c0fc",
  purple: "#b197fc",
  pink: "#f783ac",
  gray: "#ced4da",
};

const PALETTE_INDEX: Partial<Record<AnnotationColorFamily, number>> = {
  yellow: 0,
  orange: 1,
  red: 2,
  green: 3,
  blue: 4,
  purple: 5,
  pink: 6,
};

const PLACEHOLDERS: Partial<Record<AnnotationColorFamily, string>> = {
  green: "e.g. undisputed facts",
  red: "e.g. disputed points",
  orange: "e.g. flagged for review",
  yellow: "e.g. important plaintiff argument",
  blue: "e.g. important defendant argument",
};

const PARTY_ROLES = "원고,피고,항소인,피항소인,상고인,피상고인,참가인,제3자,plaintiff,defendant,appellant,appellee,petitioner,respondent,cross-appellant,cross-appellee,intervenor,amicus,third-party,neutral".split(",");

function emptyEntries(): ColorLegendEntry[] {
  return FAMILIES.map((color_family) => ({
    color_family,
    label: "",
    party_role: null,
    party_side: null,
  }));
}

export function ColorLegendEditor({ projectId }: { projectId: string }) {
  const { colors } = useAnnotationColorPalette();
  const [entries, setEntries] = useState<ColorLegendEntry[]>(emptyEntries);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStatus(null);
    void getProjectColorLegend(projectId)
      .then(({ entries: saved }) => {
        if (cancelled) return;
        const byFamily = new Map(saved.map((entry) => [entry.color_family, entry]));
        setEntries(
          FAMILIES.map(
            (family) =>
              byFamily.get(family) ?? {
                color_family: family,
                label: "",
                party_role: null,
                party_side: null,
              },
          ),
        );
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setStatus(error instanceof Error ? error.message : "Could not load color legend");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  function updateEntry(
    family: AnnotationColorFamily,
    patch: Partial<ColorLegendEntry>,
  ) {
    setEntries((current) =>
      current.map((entry) =>
        entry.color_family === family ? { ...entry, ...patch } : entry,
      ),
    );
    setStatus(null);
  }

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      const active = entries
        .filter((entry) => entry.label.trim().length > 0)
        .map((entry) => ({ ...entry, label: entry.label.trim() }));
      const result = await putProjectColorLegend(projectId, active);
      const saved = new Map(
        result.entries.map((entry) => [entry.color_family, entry]),
      );
      setEntries(
        FAMILIES.map(
          (family) =>
            saved.get(family) ?? {
              color_family: family,
              label: "",
              party_role: null,
              party_side: null,
            },
        ),
      );
      setStatus("Saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save color legend");
    } finally {
      setSaving(false);
    }
  }

  return (
    <details
      data-session-check="project-color-legend"
      className="border-b border-gray-100 px-8 py-2"
    >
      <summary className="cursor-pointer select-none text-xs font-medium text-gray-600">
        Color legend
      </summary>
      <div className="mt-3 max-w-5xl space-y-2 pb-2">
        <p className="text-xs text-gray-500">
          Give annotation colors a persistent meaning for this project. A meaning stated in a chat message still takes priority for that turn.
        </p>
        <div className="grid grid-cols-[minmax(90px,0.7fr)_minmax(220px,2fr)_minmax(150px,1fr)_70px] gap-2 text-[11px] font-medium text-gray-400">
          <span>Color</span><span>Meaning</span><span>Party role (optional)</span><span>Side</span>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 py-3 text-xs text-gray-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : (
          entries.map((entry) => {
            const paletteIndex = PALETTE_INDEX[entry.color_family];
            const chip = paletteIndex === undefined
              ? FALLBACK_COLORS[entry.color_family]
              : colors[paletteIndex] ?? FALLBACK_COLORS[entry.color_family];
            return (
              <div
                key={entry.color_family}
                data-session-check="project-color-legend-row"
                data-color-family={entry.color_family}
                className="grid grid-cols-[minmax(90px,0.7fr)_minmax(220px,2fr)_minmax(150px,1fr)_70px] gap-2"
              >
                <div className="flex items-center gap-2 text-xs text-gray-600">
                  <span className="h-4 w-4 rounded border border-black/10" style={{ backgroundColor: chip }} />
                  {entry.color_family}
                </div>
                <input value={entry.label} onChange={(event) => updateEntry(entry.color_family, { label: event.target.value })} placeholder={PLACEHOLDERS[entry.color_family] ?? "Meaning for this color"} maxLength={120} className="h-8 rounded border border-gray-200 px-2 text-xs outline-none focus:border-gray-400" />
                <input list="color-legend-party-roles" value={entry.party_role ?? ""} onChange={(event) => updateEntry(entry.color_family, { party_role: event.target.value || null })} placeholder="e.g. 피고" className="h-8 rounded border border-gray-200 px-2 text-xs outline-none focus:border-gray-400" />
                <select value={entry.party_side ?? ""} onChange={(event) => updateEntry(entry.color_family, { party_side: event.target.value === "A" || event.target.value === "B" ? event.target.value : null })} aria-label={`${entry.color_family} party side`} className="h-8 rounded border border-gray-200 bg-white px-2 text-xs outline-none focus:border-gray-400">
                  <option value="">—</option><option value="A">A</option><option value="B">B</option>
                </select>
              </div>
            );
          })
        )}
        <datalist id="color-legend-party-roles">
          {PARTY_ROLES.map((role) => <option key={role} value={role} />)}
        </datalist>
        <div className="flex items-center gap-3 pt-1">
          <button data-session-check="project-color-legend-save" type="button" disabled={loading || saving} onClick={() => void save()} className="flex h-8 items-center gap-1.5 rounded bg-gray-900 px-3 text-xs font-medium text-white hover:bg-gray-700 disabled:bg-gray-300">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
          </button>
          {status && <span data-session-check="project-color-legend-status" className={status === "Saved" ? "text-xs text-emerald-600" : "text-xs text-red-600"}>{status}</span>}
        </div>
      </div>
    </details>
  );
}
