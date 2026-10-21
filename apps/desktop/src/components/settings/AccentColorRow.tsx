import { useRef } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  ACCENT_PRESET_IDS,
  ACCENT_PRESETS,
  DEFAULT_ACCENT_COLOR,
  type AppSettings,
  isAccentPresetId,
  normalizeAccentColor,
  resolveAccentColor,
} from "@pi-desktop/shared";
import { ACCENT_PRESET_LABEL_KEYS as PRESET_LABEL_KEYS } from "../../lib/project-accent";
import { cx } from "../ui";
import { SettingsRow } from "../../features/settings/primitives";

/**
 * Global theme colour (Settings → General → Appearance). A radiogroup of
 * preset swatches plus a custom `<input type="color">`; persists as
 * `AppSettings.accentColor`. Arrow keys move the selection (roving tabindex).
 */
export function AccentColorRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const groupRef = useRef<HTMLDivElement>(null);
  const current = normalizeAccentColor(settings.accentColor) ?? DEFAULT_ACCENT_COLOR;
  const customActive = !isAccentPresetId(current);
  const customHex = customActive ? current : "#2f6fed";

  const commit = (next: string) => {
    if (next === current) return;
    void saveSettings({ accentColor: next }).catch(() => undefined);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
    if (!forward && !backward) return;
    const radios = Array.from(
      groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [],
    );
    const index = radios.indexOf(document.activeElement as HTMLElement);
    if (index === -1) return;
    event.preventDefault();
    const next = radios[(index + (forward ? 1 : -1) + radios.length) % radios.length];
    next?.focus();
    // Presets select on arrow; the custom colour input only takes focus
    // (clicking it would open the native picker).
    if (next instanceof HTMLButtonElement) next.click();
  };

  const customResolved = resolveAccentColor(customHex);

  return (
    <SettingsRow
      title={t("settings.accentColor")}
      description={t("settings.accentColorDesc")}
    >
      <div
        ref={groupRef}
        className="settings-accent-swatches"
        role="radiogroup"
        aria-label={t("settings.accentColor")}
        onKeyDown={onKeyDown}
      >
        {ACCENT_PRESET_IDS.map((id) => {
          const selected = current === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={t(PRESET_LABEL_KEYS[id])}
              title={t(PRESET_LABEL_KEYS[id])}
              tabIndex={selected ? 0 : -1}
              className={cx("settings-accent-swatch", selected && "is-selected")}
              data-accent={id}
              style={
                {
                  "--swatch-light": ACCENT_PRESETS[id].light,
                  "--swatch-dark": ACCENT_PRESETS[id].dark,
                } as React.CSSProperties
              }
              onClick={() => commit(id)}
            />
          );
        })}
        <label
          className={cx(
            "settings-accent-swatch settings-accent-custom",
            customActive && "is-selected",
          )}
          title={t("settings.accentCustom")}
          style={
            {
              "--swatch-light": customResolved.light,
              "--swatch-dark": customResolved.dark,
            } as React.CSSProperties
          }
        >
          <input
            type="color"
            role="radio"
            aria-checked={customActive}
            aria-label={t("settings.accentCustom")}
            tabIndex={customActive ? 0 : -1}
            value={customHex}
            onChange={(event) => {
              const next = normalizeAccentColor(event.target.value);
              if (next) commit(next);
            }}
          />
        </label>
      </div>
    </SettingsRow>
  );
}
