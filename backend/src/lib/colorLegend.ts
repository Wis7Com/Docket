import type { AnnotationColorFamily } from "./annotationColors";
import { PARTY_ROLES } from "./documentClassification";

export const ANNOTATION_COLOR_FAMILIES: readonly AnnotationColorFamily[] = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "gray",
] as const;

export type ColorLegendEntry = {
  color_family: AnnotationColorFamily;
  label: string;
  party_role?: string | null;
  party_side?: "A" | "B" | null;
};

const FAMILY_SET = new Set<string>(ANNOTATION_COLOR_FAMILIES);
const PARTY_ROLE_SET = new Set<string>(PARTY_ROLES);

export function parseColorLegendEntries(
  body: unknown,
): { ok: true; entries: ColorLegendEntry[] } | { ok: false; detail: string } {
  const raw = body as { entries?: unknown };
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.entries)) {
    return { ok: false, detail: "entries must be an array" };
  }
  if (raw.entries.length > ANNOTATION_COLOR_FAMILIES.length) {
    return { ok: false, detail: "too many legend entries" };
  }

  const seen = new Set<string>();
  const entries: ColorLegendEntry[] = [];
  for (const item of raw.entries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, detail: "each entry must be an object" };
    }
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.color_family !== "string" ||
      !FAMILY_SET.has(entry.color_family)
    ) {
      return { ok: false, detail: "invalid color_family" };
    }
    if (seen.has(entry.color_family)) {
      return {
        ok: false,
        detail: `duplicate color_family: ${entry.color_family}`,
      };
    }

    const label =
      typeof entry.label === "string" ? entry.label.trim().slice(0, 120) : "";
    if (!label) continue;

    let party_role: string | null = null;
    if (typeof entry.party_role === "string" && entry.party_role !== "") {
      if (!PARTY_ROLE_SET.has(entry.party_role)) {
        return {
          ok: false,
          detail: `unknown party_role: ${entry.party_role}`,
        };
      }
      party_role = entry.party_role;
    } else if (entry.party_role != null && entry.party_role !== "") {
      return {
        ok: false,
        detail: "party_role must be a PARTY_ROLES token or null",
      };
    }

    let party_side: "A" | "B" | null = null;
    if (entry.party_side === "A" || entry.party_side === "B") {
      party_side = entry.party_side;
    } else if (entry.party_side != null && entry.party_side !== "") {
      return { ok: false, detail: "party_side must be A, B, or null" };
    }

    seen.add(entry.color_family);
    entries.push({
      color_family: entry.color_family as AnnotationColorFamily,
      label,
      party_role,
      party_side,
    });
  }

  return { ok: true, entries };
}

export function buildColorLegendPrompt(
  entries: readonly ColorLegendEntry[],
): string | null {
  const usable = entries.filter((entry) => entry.label.trim().length > 0);
  if (usable.length === 0) return null;

  const ordered = [...usable].sort(
    (a, b) =>
      ANNOTATION_COLOR_FAMILIES.indexOf(a.color_family) -
      ANNOTATION_COLOR_FAMILIES.indexOf(b.color_family),
  );
  const lines = ordered.map((entry) => {
    const binding =
      entry.party_role ?? (entry.party_side ? `side ${entry.party_side}` : "");
    return `- ${entry.color_family}${binding ? ` (${binding})` : ""}: ${entry.label}`;
  });

  return `PROJECT COLOR LEGEND:
The user has defined persistent meanings for their annotation colors in this project. Treat these as standing instructions: when the user refers to a color by its meaning, or asks you to filter, group, compare, or summarize annotations by meaning, map the meaning to the listed color_family and pass that color_family to get_user_pdf_annotations. When the user's current message assigns a different meaning to a color, the current message overrides this legend for that turn.
${lines.join("\n")}`;
}
