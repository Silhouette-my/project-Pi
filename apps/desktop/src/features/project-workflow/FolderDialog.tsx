import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, OverlayBackdrop, TooltipButton } from "../../components/ui";
import { IconClose, IconFolder } from "../../components/icons";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { portalToBody } from "../../lib/portal-visibility";

export type FolderDialogValues = { name: string; parentId: string; first: boolean };
export type FolderDialogChoice = { id: string; label: string };

type Props = {
  mode: "create" | "rename" | "move";
  /** Heading for a move; create and rename use fixed copy. */
  title?: string;
  initialName?: string;
  initialParentId?: string;
  choices: FolderDialogChoice[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  /** Resolves true once the Host accepted the change. */
  onSubmit: (values: FolderDialogValues) => Promise<boolean>;
};

const MAX_FOLDER_NAME_LENGTH = 120;
const FOCUSABLE = "input:not([disabled]), select:not([disabled]), button:not([disabled])";

/**
 * Create, rename or move a navigation folder. Mirrors SessionRenameDialog so
 * the two read as one family; folders never change a conversation's workspace.
 */
export function FolderDialog({
  mode,
  title,
  initialName = "",
  initialParentId = "",
  choices,
  busy,
  error,
  onClose,
  onSubmit,
}: Props) {
  useBlockingOverlay();
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState(initialName);
  const [parentId, setParentId] = useState(initialParentId);
  const [first, setFirst] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const locationRef = useRef<HTMLSelectElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const named = mode !== "move";
  const heading =
    mode === "create"
      ? t("workflowNav.newFolder")
      : mode === "rename"
        ? t("workflowNav.renameFolderTitle")
        : (title ?? t("workflowNav.move"));
  const submitLabel =
    mode === "create" ? t("workflowNav.create") : mode === "rename" ? t("common.save") : t("workflowNav.move");
  const disabled = saving || busy;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => {
      const target = named ? nameRef.current : locationRef.current;
      target?.focus();
      if (named) nameRef.current?.select();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!savingRef.current) closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!focusable?.length) return;
      const firstItem = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [named]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingRef.current || (named && !name.trim())) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (await onSubmit({ name: name.trim(), parentId, first })) onClose();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const dialog = (
    <OverlayBackdrop
      className="overlay session-rename-dialog-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !savingRef.current) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog session-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        data-workflow="folder-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="session-rename-dialog-head">
          <div className="session-rename-dialog-heading">
            <h2 id={`${id}-title`} className="session-rename-dialog-title">
              <IconFolder size={16} aria-hidden />
              {heading}
            </h2>
            <p id={`${id}-description`} className="session-rename-dialog-description">
              {t("workflowNav.dialogDescription")}
            </p>
          </div>
          <TooltipButton
            type="button"
            className="session-rename-dialog-close"
            tooltip={t("common.cancel")}
            ariaLabel={t("common.cancel")}
            disabled={saving}
            onClick={onClose}
          >
            <IconClose size={16} />
          </TooltipButton>
        </div>
        <form className="workflow-folder-dialog-form" onSubmit={(event) => void submit(event)}>
          {named ? (
            <div>
              <label className="session-rename-dialog-label" htmlFor={`${id}-name`}>
                {t("workflowNav.folderName")}
              </label>
              <input
                className="field-input"
                ref={nameRef}
                id={`${id}-name`}
                value={name}
                maxLength={MAX_FOLDER_NAME_LENGTH}
                onChange={(event) => setName(event.target.value)}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                disabled={saving}
              />
            </div>
          ) : null}
          <div>
            <label className="session-rename-dialog-label" htmlFor={`${id}-location`}>
              {t("workflowNav.location")}
            </label>
            <select
              ref={locationRef}
              id={`${id}-location`}
              className="field-select workflow-folder-dialog-select"
              value={parentId}
              disabled={saving}
              onChange={(event) => setParentId(event.target.value)}
            >
              <option value="">{t("workflowNav.topLevel")}</option>
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>
          {mode === "move" ? (
            <div>
              <label className="session-rename-dialog-label" htmlFor={`${id}-position`}>
                {t("workflowNav.position")}
              </label>
              <select
                id={`${id}-position`}
                className="field-select workflow-folder-dialog-select"
                value={first ? "first" : "last"}
                disabled={saving}
                onChange={(event) => setFirst(event.target.value === "first")}
              >
                <option value="last">{t("workflowNav.positionEnd")}</option>
                <option value="first">{t("workflowNav.positionStart")}</option>
              </select>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="workflow-navigation-error workflow-folder-dialog-error">
              {error}
            </p>
          ) : null}
          <div className="session-rename-dialog-actions">
            <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={disabled || (named && !name.trim())}>
              {submitLabel}
            </Button>
          </div>
        </form>
      </div>
    </OverlayBackdrop>
  );
  return portalToBody(dialog);
}
