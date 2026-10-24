import { useState, type ReactNode } from "react";
import { AnchoredMenu } from "../settings/AnchoredMenu";
import { IconCheck, IconChevronDown } from "../icons";
import { Button, Tooltip, cx } from "../ui";
import "./work-return.css";

export type ReturnMenuSection = {
  id: string;
  /** Small caption above the options; omitted for a single-section menu. */
  heading?: string;
  options: readonly { id: string; label: string; checked: boolean; disabled?: boolean }[];
  onSelect: (optionId: string) => void;
};

/**
 * The return control every right-panel conversation tab shares (chat side
 * chat, project side conversation, project Agent): a pill at the top-left that
 * names where answers go and opens the mode menu, and a ghost "Return to
 * conversation" button at the top-right that only exists while a mode other
 * than "none" is chosen. Both float over the transcript on a translucent
 * panel plate: there is no header bar, divider or second line.
 */
export function FloatingReturnBar({
  label,
  pillTitle,
  menuLabel,
  sections,
  actionLabel,
  showAction,
  actionDisabled = false,
  actionTitle,
  actionBusy = false,
  onAction,
  trailing,
  workflow,
}: {
  label: string;
  pillTitle?: string;
  menuLabel: string;
  sections: readonly ReturnMenuSection[];
  actionLabel: string;
  showAction: boolean;
  actionDisabled?: boolean;
  /** Why the action is disabled, or its plain tooltip. */
  actionTitle?: string;
  actionBusy?: boolean;
  onAction: () => void;
  /** Icon buttons that sit with the action (open as conversation). */
  trailing?: ReactNode;
  /** `data-return-bar` value, for tests. */
  workflow: string;
}) {
  const [open, setOpen] = useState(false);
  const hasEnd = showAction || Boolean(trailing);
  const actionButton = (
    <Button
      type="button"
      variant="ghost"
      className="work-return-action"
      disabled={actionDisabled}
      aria-busy={actionBusy || undefined}
      data-return-action
      onClick={onAction}
    >
      {actionLabel}
    </Button>
  );
  return (
    <div className="work-return-bar" data-return-bar={workflow}>
      <AnchoredMenu
        className="work-return"
        open={open}
        onClose={() => setOpen(false)}
        menuClassName="composer-mode-menu work-return-menu"
        label={menuLabel}
        role="menu"
        align="start"
        side="bottom"
        trigger={(ref) => (
          <button
            ref={ref}
            type="button"
            className={cx("work-return-pill", open && "active")}
            aria-haspopup="menu"
            aria-expanded={open}
            title={pillTitle ?? label}
            data-return-pill
            onClick={() => setOpen((current) => !current)}
          >
            <span className="work-return-pill-label">{label}</span>
            <IconChevronDown size={12} aria-hidden className="work-return-pill-caret" />
          </button>
        )}
      >
        {sections.filter((section) => section.options.length > 0).map((section, index) => (
          <div key={section.id} role="group" aria-label={section.heading} className="work-return-section">
            {index > 0 ? <div className="work-return-separator" role="separator" /> : null}
            {section.heading ? <div className="work-return-heading">{section.heading}</div> : null}
            {section.options.map((option) => (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={option.checked}
                disabled={option.disabled}
                className={cx("composer-plus-item", option.checked && "active")}
                data-return-option={`${section.id}:${option.id}`}
                onClick={() => {
                  setOpen(false);
                  section.onSelect(option.id);
                }}
              >
                <span className="work-return-option-label">{option.label}</span>
                {option.checked ? <IconCheck size={13} /> : null}
              </button>
            ))}
          </div>
        ))}
      </AnchoredMenu>
      {hasEnd ? (
        <div className="work-return-end">
          {showAction ? (
            actionTitle ? (
              <Tooltip label={actionTitle} className="work-return-action-tip">
                {actionButton}
              </Tooltip>
            ) : (
              actionButton
            )
          ) : null}
          {trailing}
        </div>
      ) : null}
    </div>
  );
}
