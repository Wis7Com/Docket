export type AnnotationColorFamily =
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "gray";

export type ClassifiedAnnotationColor = {
  family: AnnotationColorFamily;
  label: string;
};

const COLOR_LABELS: Record<AnnotationColorFamily, string> = {
  red: "red",
  orange: "orange",
  yellow: "yellow",
  green: "green",
  blue: "blue",
  purple: "purple",
  pink: "pink",
  gray: "gray",
};

function rgbToHsl(
  r: number,
  g: number,
  b: number,
): {
  hue: number;
  saturation: number;
  lightness: number;
} {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;

  if (delta === 0) {
    return { hue: 0, saturation: 0, lightness: lightness * 100 };
  }

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === red) {
    hue = 60 * (((green - blue) / delta) % 6);
  } else if (max === green) {
    hue = 60 * ((blue - red) / delta + 2);
  } else {
    hue = 60 * ((red - green) / delta + 4);
  }
  if (hue < 0) hue += 360;

  return {
    hue,
    saturation: saturation * 100,
    lightness: lightness * 100,
  };
}

/**
 * Classifies annotation palette colors by hue while keeping truly neutral colors
 * gray. HSL is important here because the saved annotation colors are commonly
 * very light pastels whose RGB channels are all high but still carry a clear hue.
 */
export function classifyAnnotationColor(
  color: string | null | undefined,
): ClassifiedAnnotationColor | null {
  const normalized = (color ?? "").trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(normalized)) return null;

  const { hue, saturation, lightness } = rgbToHsl(
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  );

  let family: AnnotationColorFamily;
  if (saturation <= 12 || lightness <= 4 || lightness >= 98) {
    family = "gray";
  } else if (hue < 15 || hue >= 345) {
    family = "red";
  } else if (hue < 45) {
    family = "orange";
  } else if (hue < 75) {
    family = "yellow";
  } else if (hue < 165) {
    family = "green";
  } else if (hue < 255) {
    family = "blue";
  } else if (hue < 290) {
    family = "purple";
  } else {
    family = "pink";
  }

  return { family, label: COLOR_LABELS[family] };
}
