import type {
  ProjectWorkflowSnapshot,
  SessionSummary,
  WorkflowSource,
} from "@pi-desktop/shared";

/**
 * The title of the side conversation a source names, when it names one: a
 * `session` source whose session is a linked project conversation other than a
 * workstream's main. A proposal or output returned from a side conversation
 * carries such a source; the Context tab labels it "From side chat: <title>".
 */
export function sideSourceTitle(
  snapshot: Pick<ProjectWorkflowSnapshot, "conversations"> | null | undefined,
  sessions: readonly Pick<SessionSummary, "id" | "title">[],
  source: Pick<WorkflowSource, "kind" | "ref">,
  untitled: string,
): string | undefined {
  if (source.kind !== "session") return undefined;
  const link = snapshot?.conversations.find((item) => item.sessionId === source.ref);
  if (!link || link.relation === "main") return undefined;
  return sessions.find((session) => session.id === source.ref)?.title?.trim() || untitled;
}
