import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TooltipButton } from "../../components/ui";
import { IconRefresh } from "../../components/icons";
import { SettingsMenuSelect, type MenuSelectOption } from "../../components/settings/SettingsMenuSelect";

/**
 * One toolbar row per Structure view (06 §toolbar): the view switcher leads,
 * pickers follow inline, and reload sits at the trailing edge.
 */
export function StructureToolbar({
  switcher,
  children,
  onReload,
}: {
  switcher?: ReactNode;
  children?: ReactNode;
  onReload?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="project-structure-filters">
      {switcher}
      {children}
      <span className="project-structure-toolbar-spacer" />
      {onReload ? (
        <TooltipButton
          className="ct-icon-btn project-structure-reload"
          tooltip={t("workflow.retry")}
          ariaLabel={t("workflow.retry")}
          onClick={onReload}
        >
          <IconRefresh size={15} />
        </TooltipButton>
      ) : null}
    </div>
  );
}

/** A labelled native menu picker (the shared SettingsMenuSelect) for a Structure filter. */
export function StructurePicker({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: string;
  options: MenuSelectOption[];
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <span className={["project-structure-picker", className].filter(Boolean).join(" ")}>
      <span className="project-structure-picker-label">{label}</span>
      <SettingsMenuSelect label={label} value={value} options={options} onChange={onChange} />
    </span>
  );
}
