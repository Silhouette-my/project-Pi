import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectGroupRecord, SessionSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { sessionArchived, sessionPinned } from "../../lib/sidebar-session-groups";
import { useAppStore } from "../../stores/app-store";
import { useProjectWorkflow } from "./useProjectWorkflow";
import { NavigationTree } from "./NavigationTree";
import { folderInContext } from "./navigation-tree-model";
import { projectSessionChildren } from "./navigation-session-children";
import { rememberVisibleOrders } from "./navigation-visible-order";
import "./navigation-styles.css";

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

type ProjectConversationsProps = {
  sessions: SessionSummary[];
  /** Rows for these sessions; `childrenOf` supplies the branches nested under each. */
  renderSessions: (
    sessions: SessionSummary[],
    childrenOf?: (session: SessionSummary) => SessionSummary[],
  ) => ReactNode;
  projectId: string;
  /** Create a conversation in the project and resolve its id. */
  createSession: () => Promise<string | undefined>;
};

/** One project's own tree: its folders, conversations and their branches. */
export function WorkflowProjectConversations({
  sessions,
  renderSessions,
  projectId,
  createSession,
}: ProjectConversationsProps) {
  const workflow = useProjectWorkflow();
  const { snapshot } = workflow;
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
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
  // Branches and child conversations nest under their parent when it is shown.
  const { roots, childrenOf } = projectSessionChildren(snapshot?.conversations ?? [], projectId, visible);
  async function newChat(where: { folderId?: string }) {
    if (!snapshot) return;
    setCreating(true);
    try {
      const sessionId = await createSession();
      if (!sessionId) return;
      const siblings = roots.filter((session) => nav.get(session.id)?.folderId === where.folderId);
      const order = Math.max(-1, ...siblings.map((session) => nav.get(session.id)?.order ?? 0)) + 1;
      await workflow.mutate({
        kind: "tree.move",
        target: { kind: "session", id: sessionId },
        scope: "project",
        projectId,
        folderId: where.folderId,
        order,
      });
    } finally {
      setCreating(false);
    }
  }
  const treeEntries = roots.map((session, index) => ({
    kind: "session" as const,
    id: session.id,
    label: session.title,
    parentId: folderIds.has(nav.get(session.id)?.folderId ?? "")
      ? nav.get(session.id)?.folderId
      : undefined,
    order: nav.get(session.id)?.order ?? index,
    rank: sessionPinned(session, sessionMeta[session.id] ?? {}) ? -1 : 0,
  }));
  rememberVisibleOrders(treeEntries);
  return (
    <div className="workflow-navigation-projects">
      <NavigationTree
        context={{ scope: "project", projectId }}
        label={t("workflowNav.chats")}
        newChatDisabled={creating}
        onNewChat={(where) => void newChat(where)}
        entries={treeEntries}
        renderEntry={(entry) =>
          renderSessions(roots.filter((session) => session.id === entry.id), childrenOf)
        }
      />
    </div>
  );
}
