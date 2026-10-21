import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  ProjectGroupRecord,
  SessionSummary,
  WorkflowNavigation as NavigationRecord,
} from "@pi-desktop/shared";
import { Button, TooltipButton } from "../../components/ui";
import { IconFolder, IconNewSession } from "../../components/icons";
import { api } from "../../lib/api";
import { sessionArchived } from "../../lib/sidebar-session-groups";
import { useAppStore } from "../../stores/app-store";
import { useProjectWorkflow } from "./useProjectWorkflow";
import { navigationHighlights, navigationSessions } from "./navigation-model";
import { ProjectAgentButton } from "./ProjectAgentButton";
import { NavigationTree } from "./NavigationTree";
import { folderInContext } from "./navigation-tree-model";
import "./navigation-styles.css";

type Props = {
  sessions: SessionSummary[];
  renderSessions: (sessions: SessionSummary[]) => ReactNode;
};

export function WorkflowNavigation({ sessions, renderSessions }: Props) {
  const workflow = useProjectWorkflow();
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [creationError, setCreationError] = useState<string | null>(null);
  const snapshot = workflow.snapshot;
  if (!snapshot) return null;
  const folders = snapshot.folders.filter((folder) => folderInContext(folder, { scope: "chats" }));
  const nav = new Map(snapshot.navigation.map((item) => [item.sessionId, item]));
  const record = (sessionId: string): NavigationRecord =>
    nav.get(sessionId) ?? { sessionId, order: 0, favorite: false };
  const { favorites, recent, promotedIds } = navigationHighlights(snapshot, sessions);
  const eligible = [
    ...navigationSessions(snapshot, sessions),
    ...folders.flatMap((folder) => navigationSessions(snapshot, sessions, folder.id)),
  ];
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
  function renderChat(session: SessionSummary) {
    return (
      <div
        key={session.id}
        className="workflow-navigation-chat"
        onClickCapture={(event) => {
          if ((event.target as Element).closest(".thread-item-main"))
            void workflow.mutate({
              kind: "navigation.update",
              navigation: { ...record(session.id), lastAccessedAt: new Date().toISOString() },
            });
        }}
      >
        <div className="workflow-navigation-session">{renderSessions([session])}</div>
      </div>
    );
  }
  return (
    <section className="workflow-navigation" aria-label={t("workflowNav.chats")}>
      {creationError ? (
        <p role="alert" className="workflow-navigation-error">
          {creationError}
        </p>
      ) : null}
      <NavigationTree
        context={{ scope: "chats" }}
        label={t("workflowNav.chats")}
        toolbarActions={
          <TooltipButton
            className="sidebar-toolbar-button"
            tooltip={t("workflowNav.newChat")}
            ariaLabel={t("workflowNav.newChat")}
            disabled={creating || workflow.busy}
            onClick={() => void newChat()}
          >
            <IconNewSession size={14} />
          </TooltipButton>
        }
        renderFolderActions={(folder) => (
          <TooltipButton
            className="sidebar-toolbar-button"
            tooltip={t("workflowNav.newChat")}
            ariaLabel={t("workflowNav.newChat")}
            disabled={creating || workflow.busy}
            onClick={() => void newChat(folder.id)}
          >
            <IconNewSession size={13} />
          </TooltipButton>
        )}
        entries={eligible.map((session, index) => ({
          kind: "session",
          id: session.id,
          label: session.title,
          parentId: nav.get(session.id)?.folderId,
          order: nav.get(session.id)?.order ?? index,
        }))}
        renderEntry={(entry) => {
          const session = eligible.find((session) => session.id === entry.id);
          return session ? renderChat(session) : null;
        }}
        shortcuts={[
          { label: t("workflowNav.favorites"), ids: favorites.map((item) => item.id) },
          { label: t("workflowNav.recent"), ids: recent.map((item) => item.id) },
        ]}
        hiddenRootIds={[...promotedIds]}
      />
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
  const { snapshot } = useProjectWorkflow();
  const { t } = useTranslation();
  const setPage = useAppStore((state) => state.setPage);
  const page = useAppStore((state) => state.page);
  const consoleId = useAppStore((state) => state.projectConsoleId);
  const agentIds = new Set((snapshot?.projectAgents ?? []).map((agent) => agent.sessionId));
  const nav = new Map(snapshot?.navigation.map((item) => [item.sessionId, item]));
  const allSessions = useAppStore((state) => state.sessions);
  const sessionMeta = useAppStore((state) => state.sessionMeta);
  const showArchived = useAppStore((state) => state.sessionView.archived);
  const linked = new Set([
    ...(snapshot?.conversations
      .filter((item) => item.projectId === projectId)
      .map((item) => item.sessionId) ?? []),
    ...(snapshot?.workstreams
      .filter((item) => item.projectId === projectId)
      .flatMap((item) => (item.mainSessionId ? [item.mainSessionId] : [])) ?? []),
  ]);
  const candidates = new Map(
    [...sessions, ...allSessions.filter((session) => linked.has(session.id))].map((session) => [
      session.id,
      session,
    ]),
  );
  const visible = [...candidates.values()].filter(
    (session) =>
      !agentIds.has(session.id) &&
      (showArchived || !sessionArchived(session, sessionMeta[session.id])),
  );
  const folderIds = new Set(
    snapshot?.folders
      .filter((folder) => folderInContext(folder, { scope: "project", projectId }))
      .map((folder) => folder.id),
  );
  return (
    <div className="workflow-navigation-projects">
      <div className="workflow-navigation-project-entry">
        <Button
          variant="ghost"
          className="workflow-navigation-label"
          aria-current={page === "project" && consoleId === projectId ? "page" : undefined}
          onClick={() => setPage("project", { projectId })}
        >
          <IconFolder size={14} />
          <span>{t("workflow.projectHome")}</span>
        </Button>
        <ProjectAgentButton projectId={projectId} className="sidebar-toolbar-button" />
      </div>
      <NavigationTree
        context={{ scope: "project", projectId }}
        label={t("workflowNav.chats")}
        toolbar={false}
        entries={visible.map((session, index) => ({
          kind: "session",
          id: session.id,
          label: session.title,
          parentId: folderIds.has(nav.get(session.id)?.folderId ?? "")
            ? nav.get(session.id)?.folderId
            : undefined,
          order: nav.get(session.id)?.order ?? index,
        }))}
        renderEntry={(entry) =>
          renderSessions(visible.filter((session) => session.id === entry.id))
        }
      />
    </div>
  );
}
