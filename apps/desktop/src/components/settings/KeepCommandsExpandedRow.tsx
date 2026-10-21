import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import { resolveKeepCommandsExpanded } from "../../lib/command-folding";
import { SettingsRow } from "../../features/settings/primitives";
import { SettingsToggle } from "../ui";

export function KeepCommandsExpandedRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const expanded = resolveKeepCommandsExpanded(settings);
  return (
    <SettingsRow
      title={t("settings.keepCommandsExpanded")}
      description={t("settings.keepCommandsExpandedDesc")}
    >
      <SettingsToggle
        checked={expanded}
        label={t("settings.keepCommandsExpanded")}
        onChange={() => void saveSettings({ keepCommandsExpanded: !expanded })}
      />
    </SettingsRow>
  );
}
