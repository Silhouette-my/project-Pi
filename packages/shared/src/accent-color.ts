/**
 * Theme accent colour (D-accent / ADR: user-customizable accent).
 *
 * `AppSettings.accentColor` is either a preset id or a custom `#rrggbb`.
 * Presets carry hand-tuned light and dark values; a custom value gets a
 * derived dark variant. The renderer publishes both variants as CSS custom
 * properties so no script needs to know the active theme.
 *
 * Per-project colours reuse the preset table only (no custom values).
 */

export const ACCENT_PRESET_IDS = [
  "blue",
  "teal",
  "green",
  "amber",
  "rose",
  "violet",
  "graphite",
] as const;

export type AccentPresetId = (typeof ACCENT_PRESET_IDS)[number];

export const DEFAULT_ACCENT_COLOR: AccentPresetId = "blue";

export type AccentPreset = { light: string; dark: string };

export const ACCENT_PRESETS: Record<AccentPresetId, AccentPreset> = {
  blue: { light: "#2f6fed", dark: "#5b93ff" },
  teal: { light: "#0f8b8d", dark: "#3cc3c4" },
  green: { light: "#1f8a4c", dark: "#4cc38a" },
  amber: { light: "#b86e00", dark: "#f0a33a" },
  rose: { light: "#c4365d", dark: "#ff6f93" },
  violet: { light: "#6d4ad8", dark: "#a68bff" },
  // The previous neutral look.
  graphite: { light: "#3c3f44", dark: "#c9cbd0" },
};

export type ResolvedAccentColor = {
  light: string;
  dark: string;
  /** Text/icon colour with at least 4.5:1 contrast on `light`. */
  onLight: string;
  /** Text/icon colour with at least 4.5:1 contrast on `dark`. */
  onDark: string;
};

const HEX_RE = /^#[0-9a-f]{6}$/;

export function isAccentPresetId(value: unknown): value is AccentPresetId {
  return (
    typeof value === "string" &&
    (ACCENT_PRESET_IDS as readonly string[]).includes(value)
  );
}

/** Preset id or undefined; used for per-project colours. */
export function normalizeAccentPresetId(
  value: unknown,
): AccentPresetId | undefined {
  return isAccentPresetId(value) ? value : undefined;
}

/** Preset id, lower-case `#rrggbb`, or undefined for anything else. */
export function normalizeAccentColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (isAccentPresetId(trimmed)) return trimmed;
  return HEX_RE.test(trimmed) ? trimmed : undefined;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
}

/** WCAG relative luminance of a `#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Black or white, whichever reads better on `background` (>= 4.5:1). */
export function onAccentColor(background: string): "#000000" | "#ffffff" {
  return contrastRatio(background, "#ffffff") >= contrastRatio(background, "#000000")
    ? "#ffffff"
    : "#000000";
}

function rgbToOklab(rgb: [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb.map(srgbToLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb([L, a, b]: [number, number, number]): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** Lightness floor so a dark variant reads on the #181818 dark surface. */
const DARK_MIN_LIGHTNESS = 0.72;
const DARK_MAX_LIGHTNESS = 0.86;

/** Derive a dark-theme variant by lifting OKLab lightness, keeping hue. */
export function deriveDarkAccent(hex: string): string {
  const [L, a, b] = rgbToOklab(hexToRgb(hex));
  const lifted = Math.min(DARK_MAX_LIGHTNESS, Math.max(DARK_MIN_LIGHTNESS, L));
  if (lifted === L) return hex;
  // Chroma scales with the lightness change so the hue stays recognisable.
  const scale = L > 0 ? Math.min(1, lifted / L) : 1;
  return rgbToHex(oklabToRgb([lifted, a * scale, b * scale]));
}

export function resolveAccentColor(value: unknown): ResolvedAccentColor {
  const normalized = normalizeAccentColor(value) ?? DEFAULT_ACCENT_COLOR;
  const pair: AccentPreset = isAccentPresetId(normalized)
    ? ACCENT_PRESETS[normalized]
    : { light: normalized, dark: deriveDarkAccent(normalized) };
  return {
    light: pair.light,
    dark: pair.dark,
    onLight: onAccentColor(pair.light),
    onDark: onAccentColor(pair.dark),
  };
}
