import { useEffect, useId, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { OverlayBackdrop, TooltipButton } from "../../components/ui";
import { IconClose } from "../../components/icons";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { portalToBody } from "../../lib/portal-visibility";

const FOCUSABLE =
  "input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])";

/**
 * The shell shared by the project panel's dialogs. Mirrors FolderDialog and
 * SessionRenameDialog so they read as one family: a backdrop that closes on
 * outside click, a focus trap, Escape to close, and focus handed back to the
 * control that opened it.
 */
export function ProjectPanelDialog({
  title,
  description,
  icon,
  workflow,
  busy = false,
  onClose,
  children,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  /** Value of the `data-workflow` attribute, for tests. */
  workflow: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useBlockingOverlay();
  const { t } = useTranslation();
  const id = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>("select, textarea, input")?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busyRef.current) closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  return portalToBody(
    <OverlayBackdrop
      className="overlay session-rename-dialog-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busyRef.current) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog session-rename-dialog project-panel-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        data-workflow={workflow}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="session-rename-dialog-head">
          <div className="session-rename-dialog-heading">
            <h2 id={`${id}-title`} className="session-rename-dialog-title">
              {icon}
              {title}
            </h2>
            <p id={`${id}-description`} className="session-rename-dialog-description">
              {description}
            </p>
          </div>
          <TooltipButton
            type="button"
            className="session-rename-dialog-close"
            tooltip={t("common.cancel")}
            ariaLabel={t("common.cancel")}
            disabled={busy}
            onClick={onClose}
          >
            <IconClose size={16} />
          </TooltipButton>
        </div>
        {children}
      </div>
    </OverlayBackdrop>,
  );
}
