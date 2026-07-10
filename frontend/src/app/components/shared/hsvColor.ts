// Color conversions for the custom color picker: hex <-> RGB <-> HSV.
// HSV drives the picker surfaces (hue/saturation area + value slider).

export type Hsv = { h: number; s: number; v: number };
export type Rgb = { r: number; g: number; b: number };

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function normalizeHexColor(value: string): string | null {
    const raw = value.trim();
    if (!raw) return null;
    const withHash = raw.startsWith("#") ? raw : `#${raw}`;
    if (!HEX_COLOR_RE.test(withHash)) return null;
    const hex = withHash.slice(1);
    const full =
        hex.length === 3
            ? hex
                  .split("")
                  .map((c) => c + c)
                  .join("")
            : hex;
    return `#${full.toLowerCase()}`;
}

export function hexToRgb(value: string): Rgb | null {
    const normalized = normalizeHexColor(value);
    if (!normalized) return null;
    return {
        r: parseInt(normalized.slice(1, 3), 16),
        g: parseInt(normalized.slice(3, 5), 16),
        b: parseInt(normalized.slice(5, 7), 16),
    };
}

export function rgbToHex({ r, g, b }: Rgb): string {
    const channel = (n: number) =>
        Math.min(255, Math.max(0, Math.round(n)))
            .toString(16)
            .padStart(2, "0");
    return `#${channel(r)}${channel(g)}${channel(b)}`;
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
    const hue = (((h % 360) + 360) % 360) / 60;
    const c = v * s;
    const x = c * (1 - Math.abs((hue % 2) - 1));
    const m = v - c;
    const [r, g, b] =
        hue < 1
            ? [c, x, 0]
            : hue < 2
              ? [x, c, 0]
              : hue < 3
                ? [0, c, x]
                : hue < 4
                  ? [0, x, c]
                  : hue < 5
                    ? [x, 0, c]
                    : [c, 0, x];
    return {
        r: Math.round((r + m) * 255),
        g: Math.round((g + m) * 255),
        b: Math.round((b + m) * 255),
    };
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const delta = max - min;
    let h = 0;
    if (delta > 0) {
        if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
        else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
        else h = 60 * ((rn - gn) / delta + 4);
    }
    if (h < 0) h += 360;
    return { h, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToHex(hsv: Hsv): string {
    return rgbToHex(hsvToRgb(hsv));
}

export function hexToHsv(value: string): Hsv | null {
    const rgb = hexToRgb(value);
    return rgb ? rgbToHsv(rgb) : null;
}
