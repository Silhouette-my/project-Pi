import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@pi-desktop/shared";
import { Button, Input, OverlayBackdrop, portalOverlay, TooltipButton } from "../../components/ui";
import { IconClose } from "../../components/icons";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { listableSessions } from "../../lib/session-origin";
import { normalizeProjectPath, sessionArchived } from "../../lib/sidebar-session-groups";
import { useAppStore } from "../../stores/app-store";
import { SettingsCard, SettingsRow } from "./primitives";
import "./archived-conversations.css";

function ArchivedConversationsDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  useBlockingOverlay();
  const sessions = useAppStore((state) => state.sessions);
  const sessionMeta = useAppStore((state) => state.sessionMeta);
  const projectMeta = useAppStore((state) => state.projectMeta);
  const projects = useAppStore((state) => state.openProjects);
  const restoreSession = useAppStore((state) => state.restoreSession);
  const selectSession = useAppStore((state) => state.selectSession);
  const showToast = useAppStore((state) => state.showToast);
  const [query, setQuery] = useState("");
  const [openingId, setOpeningId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    inputRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
      if (event.key !== "Tab") return;
      const elements = dialogRef.current?.querySelectorAll<HTMLElement>(
        'input:not([disabled]), button:not([disabled])',
      );
      if (!elements?.length) return;
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => {
      window.removeEventListener("keydown", handleKey, true);
      document.body.style.overflow = overflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [onClose]);

  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return listableSessions(sessions)
      .filter((session) => sessionArchived(session, sessionMeta[session.id]))
      .map((session) => {
        const path = normalizeProjectPath(session.projectPath);
        const project = projects.find((item) => normalizeProjectPath(item.path) === path);
        const label = project?.name || session.remoteWorkspaceLabel || session.projectPath
          || t("nav.temporarySessions");
        return { session, label, projectArchived: !!(path && projectMeta[path]?.archived) };
      })
      .filter(({ session, label }) => !needle || `${session.title}\n${label}`.toLocaleLowerCase().includes(needle))
      .sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt));
  }, [sessions, sessionMeta, projects, projectMeta, query, t]);

  const open = async (session: SessionSummary) => {
    setOpeningId(session.id);
    try {
      await selectSession(session.id);
      const selected = useAppStore.getState();
      if (selected.activeSessionId === session.id && selected.page === "chat") onClose();
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" });
    } finally {
      setOpeningId(undefined);
    }
  };

  return portalOverlay(
    <OverlayBackdrop className="overlay" onClick={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div ref={dialogRef} className="dialog archived-conversations-dialog" role="dialog"
        aria-modal="true" aria-labelledby="archived-conversations-title">
        <header className="archived-conversations-heading">
          <h2 id="archived-conversations-title">{t("settings.archivedChats.title")}</h2>
          <TooltipButton tooltip={t("common.close")} ariaLabel={t("common.close")} onClick={onClose}>
            <IconClose size={16} />
          </TooltipButton>
        </header>
        <Input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder={t("settings.archivedChats.search")} aria-label={t("settings.archivedChats.search")} />
        {notice && <p role="status" className="archived-conversations-notice">{notice}</p>}
        <ul className="archived-conversations-list">
          {rows.map(({ session, label, projectArchived }) => (
            <li key={session.id} className="archived-conversation" data-archived-session={session.id}>
              <div className="archived-conversation-info">
                <span className="archived-conversation-title" title={session.title}>{session.title}</span>
                <span className="archived-conversation-meta" title={session.projectPath}>
                  {label} · {new Date(session.updatedAt).toLocaleDateString(i18n.language)}
                </span>
              </div>
              <div className="archived-conversation-actions">
                <Button disabled={!!openingId} onClick={() => void open(session)}>{t("settings.archivedChats.open")}</Button>
                <Button disabled={!!openingId} onClick={() => {
                  restoreSession(session.id);
                  inputRef.current?.focus();
                  setNotice(projectArchived ? t("settings.archivedChats.projectStillArchived")
                    : t("settings.archivedChats.restored", { title: session.title }));
                }}>{t("settings.archivedChats.restore")}</Button>
              </div>
            </li>
          ))}
        </ul>
        {!rows.length && <p className="archived-conversations-empty">
          {t(query.trim() ? "settings.archivedChats.noResults" : "settings.archivedChats.empty")}
        </p>}
      </div>
    </OverlayBackdrop>,
  );
}

export function ArchivedConversationsSection() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <SettingsCard>
        <SettingsRow title={t("settings.archivedChats.title")} description={t("settings.archivedChats.description")}>
          <Button onClick={() => setOpen(true)}>{t("settings.archivedChats.manage")}</Button>
        </SettingsRow>
      </SettingsCard>
      {open && <ArchivedConversationsDialog onClose={close} />}
    </>
  );
}
