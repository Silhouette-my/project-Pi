import type { CSSProperties } from "react";
import {
  ACCENT_PRESETS,
  type AccentPresetId,
  normalizeAccentPresetId,
} from "@pi-desktop/shared";

/** i18n keys naming each accent preset (shared by Settings and the project menu). */
export const ACCENT_PRESET_LABEL_KEYS = {
  blue: "settings.accentBlue",
  teal: "settings.accentTeal",
  green: "settings.accentGreen",
  amber: "settings.accentAmber",
  rose: "settings.accentRose",
  violet: "settings.accentViolet",
  graphite: "settings.accentGraphite",
} as const satisfies Record<AccentPresetId, string>;

/**
 * Inline custom properties carrying a project colour's light and dark values.
 * CSS picks the variant per theme (see `[data-project-color]` rules), so the
 * element needs no knowledge of the active theme.
 */
export function projectAccentStyle(color: unknown): CSSProperties | undefined {
  const id = normalizeAccentPresetId(color);
  if (!id) return undefined;
  return {
    "--project-accent-light": ACCENT_PRESETS[id].light,
    "--project-accent-dark": ACCENT_PRESETS[id].dark,
  } as CSSProperties;
}
