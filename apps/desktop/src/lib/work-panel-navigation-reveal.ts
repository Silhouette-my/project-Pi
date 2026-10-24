/**
 * A deliberate reveal of the unpinned work panel on navigation (ADR 0033
 * amendment). Entering a project, or a chat that belongs to one, presents the
 * project Agent; when the right side is auto-hidden, that means the edge
 * overlay is revealed once on entry.
 *
 * This is navigation-driven, never agent-driven: only the default-open hook
 * requests it, and nothing in the agent or tool event paths imports it. The
 * request names the context it was made for, so it is dropped when the user
 * has already moved on by the time the panel can show it.
 */
let pendingContextKey: string | null = null;
const listeners = new Set<() => void>();

export function requestWorkPanelNavigationReveal(contextKey: string): void {
  pendingContextKey = contextKey;
  for (const listener of listeners) listener();
}

/** Take the pending request if it is for this context; any other request is stale. */
export function takeWorkPanelNavigationReveal(contextKey: string | undefined): boolean {
  const pending = pendingContextKey;
  pendingContextKey = null;
  return pending !== null && pending === contextKey;
}

/** Whether a request is waiting, without consuming it. */
export function hasWorkPanelNavigationReveal(): boolean {
  return pendingContextKey !== null;
}

export function subscribeWorkPanelNavigationReveal(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only. */
export function resetWorkPanelNavigationReveal(): void {
  pendingContextKey = null;
}
