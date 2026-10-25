import type { ProjectWorkflowSnapshot, WorkflowNavigation } from "@pi-desktop/shared";

/**
 * The order each conversation row currently shows. A conversation with no
 * navigation record sits at its list index; writing a record for it (a star)
 * must keep that position instead of falling back to 0.
 */
const shown = new Map<string, number>();

export function rememberVisibleOrders(entries: readonly { kind: string; id: string; order: number }[]) {
  for (const entry of entries) if (entry.kind === "session") shown.set(entry.id, entry.order);
}

export function visibleOrderOf(sessionId: string): number | undefined {
  return shown.get(sessionId);
}

/** The record to write when changing a flag: the stored one, or a new one at the visible order. */
export function navigationRecordFor(
  snapshot: Pick<ProjectWorkflowSnapshot, "navigation">,
  sessionId: string,
  visibleOrder: number | undefined = visibleOrderOf(sessionId),
): WorkflowNavigation {
  return (
    snapshot.navigation.find((item) => item.sessionId === sessionId) ?? {
      sessionId,
      order: visibleOrder ?? 0,
      favorite: false,
    }
  );
}
