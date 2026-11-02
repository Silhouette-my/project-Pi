import type { AccentPresetId } from "@pi-desktop/shared";

/** i18n keys naming each accent preset. */
export const ACCENT_PRESET_LABEL_KEYS = {
  blue: "settings.accentBlue",
  teal: "settings.accentTeal",
  green: "settings.accentGreen",
  amber: "settings.accentAmber",
  rose: "settings.accentRose",
  violet: "settings.accentViolet",
  graphite: "settings.accentGraphite",
} as const satisfies Record<AccentPresetId, string>;
