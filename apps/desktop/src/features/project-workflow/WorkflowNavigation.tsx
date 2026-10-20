import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  ProjectGroupRecord,
  SessionSummary,
  WorkflowFolder,
  WorkflowNavigation as NavigationRecord,
} from "@pi-desktop/shared";
import { Button, Checkbox, Field, Input, Select, TooltipButton } from "../../components/ui";
import {
  IconChevronDown,
  IconFolder,
  IconNewSession,
  IconPencil,
  IconStar,
  IconTrash,
} from "../../components/icons";
import { api } from "../../lib/api";
import { sessionArchived } from "../../lib/sidebar-session-groups";
import { useAppStore } from "../../stores/app-store";
import { useProjectWorkflow } from "./useProjectWorkflow";
import { folderParents, navigationSessions, orderedFolders } from "./navigation-model";
import "./navigation-styles.css";

type Props = {
  sessions: SessionSummary[];
  renderSessions: (sessions: SessionSummary[]) => ReactNode;
};

export function WorkflowNavigation({ sessions, renderSessions }: Props) {
  const workflow = useProjectWorkflow();
  const { t } = useTranslation();
  const [manage, setManage] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [destination, setDestination] = useState("");
  const [editor, setEditor] = useState<{
    folder?: WorkflowFolder;
    parentId: string;
    name: string;
  } | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [creationError, setCreationError] = useState<string | null>(null);
  const snapshot = workflow.snapshot;
  if (!snapshot) return null;
  const nav = new Map(snapshot.navigation.map((item) => [item.sessionId, item]));
  const expanded = new Set(snapshot.expandedIds);
  const record = (sessionId: string): NavigationRecord =>
    nav.get(sessionId) ?? { sessionId, order: 0, favorite: false };
  const toggle = (id: string) =>
    workflow.mutate({
      kind: "navigation.expand",
      expandedIds: expanded.has(id)
        ? snapshot.expandedIds.filter((item) => item !== id)
        : [...snapshot.expandedIds, id],
    });
  async function newChat(folderId?: string) {
    setCreating(true);
    setCreationError(null);
    try {
      const sessionId = await useAppStore.getState().newSession({ projectPath: null });
      if (sessionId)
        await workflow.mutate({ kind: "navigation.move", sessionIds: [sessionId], folderId });
    } catch (cause) {
      setCreationError(
        t("workflow.requestFailed", {
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    } finally {
      setCreating(false);
    }
  }
  async function saveFolder() {
    if (!editor?.name.trim()) return;
    const folder = {
      id: editor.folder?.id ?? crypto.randomUUID(),
      name: editor.name.trim(),
      parentId: editor.parentId || undefined,
      order: editor.folder?.order ?? snapshot!.folders.length,
    };
    if (await workflow.mutate({ kind: editor.folder ? "folder.update" : "folder.create", folder }))
      setEditor(null);
  }
  function renderChats(items: SessionSummary[]) {
    return items.map((session) => (
      <div
        key={session.id}
        className="workflow-navigation-chat"
        onClickCapture={(event) => {
          if (!(event.target as Element).closest(".thread-item-main")) return;
          void workflow.mutate({
            kind: "navigation.update",
            navigation: { ...record(session.id), lastAccessedAt: new Date().toISOString() },
          });
        }}
      >
        {manage ? (
          <Checkbox
            checked={selected.includes(session.id)}
            label={
              <span className="sr-only">
                {t("workflowNav.selectChat", { title: session.title })}
              </span>
            }
            onChange={() =>
              setSelected((ids) =>
                ids.includes(session.id)
                  ? ids.filter((id) => id !== session.id)
                  : [...ids, session.id],
              )
            }
          />
        ) : null}
        <div className="workflow-navigation-session">{renderSessions([session])}</div>
        {manage ? (
          <>
            <TooltipButton
              className="sidebar-toolbar-button"
              tooltip={t("workflowNav.favorite")}
              ariaLabel={t("workflowNav.favorite")}
              aria-pressed={record(session.id).favorite}
              disabled={workflow.busy}
              onClick={() =>
                void workflow.mutate({
                  kind: "navigation.update",
                  navigation: { ...record(session.id), favorite: !record(session.id).favorite },
                })
              }
            >
              <IconStar size={12} />
            </TooltipButton>
            <TooltipButton
              className="sidebar-toolbar-button"
              tooltip={t("workflowNav.moveFirst")}
              ariaLabel={t("workflowNav.moveFirst")}
              disabled={workflow.busy}
              onClick={() =>
                void workflow.mutate({
                  kind: "navigation.update",
                  navigation: {
                    ...record(session.id),
                    order: Math.min(0, ...snapshot!.navigation.map((item) => item.order)) - 1,
                  },
                })
              }
            >
              ↑
            </TooltipButton>
          </>
        ) : null}
      </div>
    ));
  }
  function folderView(folder: WorkflowFolder) {
    const open = expanded.has(folder.id);
    return (
      <section
        key={folder.id}
        className="workflow-navigation-folder"
        data-workflow-folder={folder.id}
      >
        <div className="workflow-navigation-header">
          <Button
            variant="ghost"
            className="workflow-navigation-label"
            aria-expanded={open}
            onClick={() => void toggle(folder.id)}
          >
            <IconChevronDown size={12} className={open ? "" : "workflow-navigation-folded"} />
            <IconFolder size={13} />
            <span>{folder.name}</span>
          </Button>
          <TooltipButton
            className="sidebar-toolbar-button"
            tooltip={t("workflowNav.newChat")}
            ariaLabel={t("workflowNav.newChat")}
            disabled={workflow.busy || creating}
            onClick={() => void newChat(folder.id)}
          >
            <IconNewSession size={13} />
          </TooltipButton>
          {manage ? (
            <>
              <TooltipButton
                className="sidebar-toolbar-button"
                tooltip={t("workflowNav.editFolder")}
                ariaLabel={t("workflowNav.editFolder")}
                onClick={() =>
                  setEditor({ folder, name: folder.name, parentId: folder.parentId ?? "" })
                }
              >
                <IconPencil size={12} />
              </TooltipButton>
              <TooltipButton
                className="sidebar-toolbar-button"
                tooltip={t("workflowNav.moveFirst")}
                ariaLabel={t("workflowNav.moveFirst")}
                disabled={workflow.busy}
                onClick={() =>
                  void workflow.mutate({
                    kind: "folder.update",
                    folder: {
                      ...folder,
                      order: Math.min(0, ...snapshot!.folders.map((item) => item.order)) - 1,
                    },
                  })
                }
              >
                ↑
              </TooltipButton>
              <TooltipButton
                className="sidebar-toolbar-button"
                tooltip={t("workflowNav.removeFolder")}
                ariaLabel={t("workflowNav.removeFolder")}
                onClick={() => setRemoveId(folder.id)}
              >
                <IconTrash size={12} />
              </TooltipButton>
            </>
          ) : null}
        </div>
        {open ? (
          <div className="workflow-navigation-children">
            {renderChats(navigationSessions(snapshot!, sessions, folder.id))}
            {orderedFolders(snapshot!.folders, folder.id).map(folderView)}
          </div>
        ) : null}
      </section>
    );
  }
  const sessionIds = new Set(sessions.map((session) => session.id));
  const favorites = snapshot.navigation
    .filter((item) => item.favorite && sessionIds.has(item.sessionId))
    .sort((a, b) => a.order - b.order)
    .flatMap((item) => sessions.filter((session) => session.id === item.sessionId));
  const recent = snapshot.navigation
    .filter((item) => item.lastAccessedAt && sessionIds.has(item.sessionId))
    .sort((a, b) => b.lastAccessedAt!.localeCompare(a.lastAccessedAt!))
    .slice(0, 5)
    .flatMap((item) => sessions.filter((session) => session.id === item.sessionId));
  return (
    <section className="workflow-navigation" aria-label={t("workflowNav.chats")}>
      <div className="sidebar-list-toolbar">
        <span className="sidebar-list-label">{t("workflowNav.chats")}</span>
        <TooltipButton
          className="sidebar-toolbar-button"
          tooltip={t("workflowNav.newChat")}
          ariaLabel={t("workflowNav.newChat")}
          disabled={creating || workflow.busy}
          onClick={() => void newChat()}
        >
          <IconNewSession size={14} />
        </TooltipButton>
        <TooltipButton
          className="sidebar-toolbar-button"
          tooltip={t("workflowNav.newFolder")}
          ariaLabel={t("workflowNav.newFolder")}
          onClick={() => setEditor({ name: "", parentId: "" })}
        >
          <IconFolder size={14} />
        </TooltipButton>
        <TooltipButton
          className="sidebar-toolbar-button"
          tooltip={t("workflowNav.organize")}
          ariaLabel={t("workflowNav.organize")}
          aria-pressed={manage}
          onClick={() => {
            setManage(!manage);
            setSelected([]);
          }}
        >
          <IconPencil size={14} />
        </TooltipButton>
      </div>
      {workflow.error ? (
        <p role="alert" className="workflow-navigation-error">
          {workflow.error}
        </p>
      ) : null}
      {creationError ? (
        <p role="alert" className="workflow-navigation-error">
          {creationError}
        </p>
      ) : null}
      {editor ? (
        <form
          className="workflow-navigation-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void saveFolder();
          }}
        >
          <Field label={t("workflowNav.folderName")}>
            <Input
              autoFocus
              value={editor.name}
              onChange={(event) => setEditor({ ...editor, name: event.target.value })}
            />
          </Field>
          <Field label={t("workflowNav.parentFolder")}>
            <Select
              value={editor.parentId}
              onChange={(event) => setEditor({ ...editor, parentId: event.target.value })}
            >
              <option value="">{t("workflowNav.topLevel")}</option>
              {folderParents(snapshot.folders, editor.folder).map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="workflow-navigation-actions">
            <Button type="submit" disabled={workflow.busy || !editor.name.trim()}>
              {t("common.save")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEditor(null)}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : null}
      {removeId ? (
        <div className="workflow-navigation-editor" role="alert">
          <p>{t("workflowNav.removeHint")}</p>
          <Button
            disabled={workflow.busy}
            onClick={async () => {
              if (await workflow.mutate({ kind: "folder.remove", folderId: removeId }))
                setRemoveId(null);
            }}
          >
            {t("workflowNav.removeFolder")}
          </Button>
          <Button variant="ghost" onClick={() => setRemoveId(null)}>
            {t("common.cancel")}
          </Button>
        </div>
      ) : null}
      {manage && selected.length > 0 ? (
        <div className="workflow-navigation-editor">
          <Field label={t("workflowNav.moveSelected", { count: selected.length })}>
            <Select value={destination} onChange={(event) => setDestination(event.target.value)}>
              <option value="">{t("workflowNav.unfiled")}</option>
              {snapshot.folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            disabled={workflow.busy}
            onClick={async () => {
              if (
                await workflow.mutate({
                  kind: "navigation.move",
                  sessionIds: selected,
                  folderId: destination || undefined,
                })
              )
                setSelected([]);
            }}
          >
            {t("workflowNav.move")}
          </Button>
        </div>
      ) : null}
      {favorites.length ? (
        <section>
          <div className="workflow-navigation-subheading">{t("workflowNav.favorites")}</div>
          {renderChats(favorites)}
        </section>
      ) : null}
      {recent.length ? (
        <section>
          <div className="workflow-navigation-subheading">{t("workflowNav.recent")}</div>
          {renderChats(recent)}
        </section>
      ) : null}
      {orderedFolders(snapshot.folders).map(folderView)}
      <section>
        <div className="workflow-navigation-subheading">{t("workflowNav.unfiled")}</div>
        {renderChats(navigationSessions(snapshot, sessions))}
      </section>
    </section>
  );
}

/** Resolve durable identity only; Sidebar remains the owner of visible project ordering/filtering. */
export function useWorkflowProjectGroups(refreshKey: unknown) {
  const [groups, setGroups] = useState<ProjectGroupRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void api.listProjectGroups().then(
      (result) => {
        if (current) {
          setGroups(result.groups);
          setError(null);
        }
      },
      (reason: unknown) => {
        if (current) setError(String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [refreshKey]);
  return { groups, error };
}

export function WorkflowProjectConversations({
  sessions,
  renderSessions,
  projectId,
}: Props & { projectId: string }) {
  const { snapshot, mutate, busy } = useProjectWorkflow();
  const { t } = useTranslation();
  const setPage = useAppStore((state) => state.setPage);
  const selectSession = useAppStore((state) => state.selectSession);
  const allSessions = useAppStore((state) => state.sessions);
  const sessionMeta = useAppStore((state) => state.sessionMeta);
  if (!snapshot) return null;
  const toggle = (id: string) =>
    mutate({
      kind: "navigation.expand",
      expandedIds: snapshot.expandedIds.includes(id)
        ? snapshot.expandedIds.filter((item) => item !== id)
        : [...snapshot.expandedIds, id],
    });
  const associatedIds = new Set(snapshot.conversations.map((item) => item.sessionId));
  for (const workstream of snapshot.workstreams)
    if (workstream.mainSessionId) associatedIds.add(workstream.mainSessionId);
  const legacy = sessions.filter((item) => !associatedIds.has(item.id));
  const legacyId = `project:${projectId}:legacy`;
  return (
    <div className="workflow-navigation-projects">
      {snapshot.workstreams
        .filter((item) => item.projectId === projectId)
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
        .map((workstream) => {
          const open = snapshot.expandedIds.includes(workstream.id);
          const links = snapshot.conversations
            .filter((item) => item.workstreamId === workstream.id && item.relation !== "main")
            .sort((a, b) => a.order - b.order);
          const isHistory = (link: (typeof links)[number]) => {
            const session = allSessions.find((item) => item.id === link.sessionId);
            if (link.archived || (session && sessionArchived(session, sessionMeta[session.id])))
              return true;
            const runs = snapshot.runs
              .filter(
                (run) => run.workstreamId === workstream.id && run.sessionId === link.sessionId,
              )
              .sort(
                (a, b) =>
                  b.startedAt.localeCompare(a.startedAt) || b.updatedAt.localeCompare(a.updatedAt),
              );
            // Unresolved execution stays visible even if an older run completed.
            if (
              runs.some(
                (run) =>
                  ["queued", "executing", "paused", "unknown"].includes(run.state) ||
                  run.effects.some((effect) => effect.state === "unknown"),
              )
            )
              return false;
            return link.purpose === "work" && runs[0]?.state === "completed";
          };
          const activeLinks = links.filter((item) => !isHistory(item));
          const historicalLinks = links.filter(isHistory);
          const linkedRows = (items: typeof links) =>
            items.map((link) => (
              <div
                key={link.sessionId}
                className="workflow-navigation-side"
                data-workflow-conversation={link.sessionId}
              >
                <span className="workflow-navigation-relation">
                  {t(`workflowNav.${link.relation}`)}
                </span>
                {renderSessions(allSessions.filter((session) => session.id === link.sessionId))}
              </div>
            ));
          return (
            <div className="workflow-navigation-children" key={workstream.id}>
              <div className="workflow-navigation-header">
                <TooltipButton
                  className="sidebar-toolbar-button"
                  tooltip={t("workflowNav.toggleWorkstream")}
                  ariaLabel={t("workflowNav.toggleWorkstream")}
                  aria-expanded={open}
                  disabled={busy}
                  onClick={() => void toggle(workstream.id)}
                >
                  <IconChevronDown size={12} className={open ? "" : "workflow-navigation-folded"} />
                </TooltipButton>
                <Button
                  variant="ghost"
                  className="workflow-navigation-label"
                  onClick={() =>
                    workstream.mainSessionId
                      ? void selectSession(workstream.mainSessionId)
                      : setPage("project", { projectId })
                  }
                >
                  <span>{workstream.title}</span>
                </Button>
                <span className="workflow-navigation-status">
                  {t(`workflow.status.${workstream.status}`, { defaultValue: workstream.status })}
                </span>
              </div>
              {open ? (
                <>
                  {linkedRows(activeLinks)}
                  {historicalLinks.length ? (
                    <>
                      <Button
                        variant="ghost"
                        aria-expanded={snapshot.expandedIds.includes(`${workstream.id}:history`)}
                        onClick={() => void toggle(`${workstream.id}:history`)}
                      >
                        {t("workflowNav.history", { count: historicalLinks.length })}
                      </Button>
                      {snapshot.expandedIds.includes(`${workstream.id}:history`)
                        ? linkedRows(historicalLinks)
                        : null}
                    </>
                  ) : null}
                </>
              ) : null}
            </div>
          );
        })}
      {legacy.length ? (
        <section className="workflow-navigation-legacy" data-workflow-legacy={projectId}>
          <Button
            variant="ghost"
            className="workflow-navigation-label"
            aria-expanded={snapshot.expandedIds.includes(legacyId)}
            disabled={busy}
            onClick={() => void toggle(legacyId)}
          >
            <IconChevronDown
              size={12}
              className={
                snapshot.expandedIds.includes(legacyId) ? "" : "workflow-navigation-folded"
              }
            />
            {t("workflowNav.legacyConversations", { count: legacy.length })}
          </Button>
          {snapshot.expandedIds.includes(legacyId) ? renderSessions(legacy) : null}
        </section>
      ) : null}
    </div>
  );
}
