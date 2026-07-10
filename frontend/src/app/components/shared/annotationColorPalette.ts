import { ANNOTATION_COLORS } from "./docViewTypes";
import { normalizeHexColor } from "./hsvColor";

export const ANNOTATION_COLOR_PALETTE_STORAGE_KEY =
    "docket-pdf-annotation-colors-v1";

export function defaultAnnotationColorPalette(): string[] {
    return [...ANNOTATION_COLORS];
}

export function parseAnnotationColorPalette(value: string | null): string[] {
    if (!value) return defaultAnnotationColorPalette();
    try {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed) || parsed.length !== ANNOTATION_COLORS.length) {
            return defaultAnnotationColorPalette();
        }
        const normalized = parsed.map((color) =>
            typeof color === "string" ? normalizeHexColor(color) : null,
        );
        return normalized.every((color): color is string => color !== null)
            ? normalized
            : defaultAnnotationColorPalette();
    } catch {
        return defaultAnnotationColorPalette();
    }
}

export function replaceAnnotationPaletteColor(
    colors: readonly string[],
    index: number,
    color: string,
): string[] {
    const normalized = normalizeHexColor(color);
    if (
        colors.length !== ANNOTATION_COLORS.length ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= colors.length ||
        !normalized
    ) {
        return [...colors];
    }
    const next = [...colors];
    next[index] = normalized;
    return next;
}

export function readAnnotationColorPalette(): string[] {
    try {
        return parseAnnotationColorPalette(
            window.localStorage.getItem(
                ANNOTATION_COLOR_PALETTE_STORAGE_KEY,
            ),
        );
    } catch {
        return defaultAnnotationColorPalette();
    }
}

export function writeAnnotationColorPalette(colors: readonly string[]): void {
    try {
        window.localStorage.setItem(
            ANNOTATION_COLOR_PALETTE_STORAGE_KEY,
            JSON.stringify(colors),
        );
    } catch {
        // Persistence is best-effort; the provider still keeps the palette
        // available for the lifetime of the current app session.
    }
}
