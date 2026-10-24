import type { SessionSummary, WorkflowConversation } from "@pi-desktop/shared";

/**
 * Nest branches and child conversations under their parent session, using the
 * existing workflow relation (`parentSessionId`, `relation` main|branch|child).
 * A session whose parent is not shown stays a root, so nothing disappears, and
 * a cycle can never hide a row: its members fall back to roots.
 */
export function projectSessionChildren(
  conversations: Pick<WorkflowConversation, "sessionId" | "projectId" | "parentSessionId" | "relation">[],
  projectId: string,
  visible: SessionSummary[],
) {
  const shown = new Set(visible.map((session) => session.id));
  const parentOf = new Map<string, string>();
  for (const item of conversations) {
    if (
      item.projectId === projectId &&
      item.relation !== "main" &&
      item.parentSessionId &&
      item.parentSessionId !== item.sessionId &&
      shown.has(item.parentSessionId) &&
      shown.has(item.sessionId)
    )
      parentOf.set(item.sessionId, item.parentSessionId);
  }
  // Break cycles: an ancestor walk that returns to its start makes that session a root.
  for (const id of [...parentOf.keys()]) {
    const seen = new Set([id]);
    for (let next = parentOf.get(id); next; next = parentOf.get(next)) {
      if (seen.has(next)) {
        parentOf.delete(id);
        break;
      }
      seen.add(next);
    }
  }
  const children = new Map<string, SessionSummary[]>();
  const roots: SessionSummary[] = [];
  for (const session of visible) {
    const parent = parentOf.get(session.id);
    if (!parent) roots.push(session);
    else children.set(parent, [...(children.get(parent) ?? []), session]);
  }
  return { roots, childrenOf: (session: SessionSummary) => children.get(session.id) ?? [] };
}
