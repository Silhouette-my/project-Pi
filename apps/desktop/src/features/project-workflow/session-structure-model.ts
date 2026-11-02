import type {
  ProjectWorkflowSnapshot,
  SessionSummary,
  WorkflowConversation,
  WorkflowRun,
  WorkflowWorkstream,
} from "@pi-desktop/shared";
import { normalizeProjectPath } from "../../lib/sidebar-session-groups";

export type StructureSession = {
  id: string;
  session?: SessionSummary;
  link?: WorkflowConversation;
  parentId?: string;
  mainFor: WorkflowWorkstream[];
  workstreams: WorkflowWorkstream[];
  runs: WorkflowRun[];
  agent: boolean;
  externalSource: boolean;
  source: boolean;
  unlinked: boolean;
};
/** Membership never implies a parent edge. Missing transcripts remain explicit records. */
export function projectSessionStructure(
  snapshot: ProjectWorkflowSnapshot,
  sessions: SessionSummary[],
  projectId: string,
  paths: string[],
) {
  const roots = new Set(paths.map((path) => normalizeProjectPath(path)));
  const workstreams = snapshot.workstreams.filter((item) => item.projectId === projectId);
  const links = snapshot.conversations.filter((item) => item.projectId === projectId);
  const runs = snapshot.runs.filter((item) => item.projectId === projectId);
  const agentId = snapshot.projectAgents?.find((item) => item.projectId === projectId)?.sessionId;
  const members = new Set([
    ...sessions
      .filter(
        (session) => session.projectPath && roots.has(normalizeProjectPath(session.projectPath)),
      )
      .map((session) => session.id),
    ...links.map((item) => item.sessionId),
    ...workstreams.flatMap((item) => (item.mainSessionId ? [item.mainSessionId] : [])),
    ...runs.map((item) => item.sessionId),
    ...(agentId ? [agentId] : []),
  ]);
  const sources = new Set(
    links.flatMap((item) => (item.parentSessionId ? [item.parentSessionId] : [])),
  );
  const ids = new Set([...members, ...sources]);
  const bySession = new Map(sessions.map((session) => [session.id, session]));
  const nodes: StructureSession[] = [...ids].map((id) => {
    const link = links.find((item) => item.sessionId === id);
    const mainFor = workstreams.filter((item) => item.mainSessionId === id);
    const sessionRuns = runs
      .filter((item) => item.sessionId === id)
      .sort(
        (a, b) => b.startedAt.localeCompare(a.startedAt) || b.updatedAt.localeCompare(a.updatedAt),
      );
    const memberships = workstreams.filter(
      (item) =>
        mainFor.includes(item) ||
        link?.workstreamId === item.id ||
        sessionRuns.some((run) => run.workstreamId === item.id),
    );
    return {
      id,
      session: bySession.get(id),
      link,
      parentId: link?.parentSessionId,
      mainFor,
      workstreams: memberships,
      runs: sessionRuns,
      agent: id === agentId,
      externalSource: !members.has(id),
      source: sources.has(id),
      unlinked:
        !link &&
        !mainFor.length &&
        !sessionRuns.length &&
        id !== agentId &&
        !sources.has(id) &&
        members.has(id),
    };
  });
  nodes.sort(
    (a, b) =>
      Number(b.agent) - Number(a.agent) ||
      Number(b.mainFor.length > 0) - Number(a.mainFor.length > 0) ||
      (a.link?.order ?? 0) - (b.link?.order ?? 0) ||
      (b.session?.updatedAt ?? "").localeCompare(a.session?.updatedAt ?? "") ||
      a.id.localeCompare(b.id),
  );
  return { nodes, byId: new Map(nodes.map((node) => [node.id, node])) };
}
export function sessionTreeRoots(nodes: StructureSession[]) {
  const ids = new Set(nodes.map((node) => node.id));
  return nodes.filter((node) => !node.parentId || !ids.has(node.parentId));
}
export function sessionTreeSelection(
  nodes: StructureSession[],
  workstreamId: string,
  predicate: (node: StructureSession) => boolean,
) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selected = new Set(
    nodes
      .filter(
        (node) =>
          (!workstreamId || node.workstreams.some((work) => work.id === workstreamId)) &&
          predicate(node),
      )
      .map((node) => node.id),
  );
  for (const id of [...selected]) {
    let parent = byId.get(id)?.parentId;
    while (parent && byId.has(parent)) {
      selected.add(parent);
      parent = byId.get(parent)?.parentId;
    }
  }
  return nodes.filter((node) => selected.has(node.id));
}
