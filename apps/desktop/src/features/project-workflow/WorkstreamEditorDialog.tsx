import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { OverlayBackdrop, portalOverlay } from "../../components/ui";
import { useBlockingOverlay } from "../../lib/blocking-overlay";

/** Keep the full work contract available without making the project home a form. */
export function WorkstreamEditorDialog({ children, onClose, labelledBy = "workflow-workstream-editor-title", className, style, dataProjectColor }: {
  children: ReactNode;
  onClose: () => void;
  labelledBy?: string;
  className?: string;
  style?: CSSProperties;
  /** Project colour id; pairs with `style` custom properties from `projectAccentStyle`. */
  dataProjectColor?: string;
}) {
  useBlockingOverlay();
  const dialog = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(document.activeElement);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = returnFocus.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); }
      if (event.key !== "Tab") return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex='0']") ?? [])];
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return portalOverlay(<OverlayBackdrop className="overlay workflow-editor-overlay" role="presentation" onClick={onClose}>
    <div className={["dialog workflow-editor-dialog", className].filter(Boolean).join(" ")} ref={dialog} style={style} data-project-color={dataProjectColor} role="dialog" aria-modal="true" aria-labelledby={labelledBy} onClick={(event) => event.stopPropagation()}>{children}</div>
  </OverlayBackdrop>);
}
