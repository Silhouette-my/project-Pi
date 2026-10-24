import { useSyncExternalStore } from "react";

// Project drafts are not session drafts: the session cache prunes keys when
// sessions refresh, so keep this equally transient project-owned slot separate.
const drafts = new Map<string, string>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useProjectAgentDraft(projectId: string) {
  const text = useSyncExternalStore(
    subscribe,
    () => drafts.get(projectId) ?? "",
    () => "",
  );
  const update = (next: string) => {
    if (next) drafts.set(projectId, next);
    else drafts.delete(projectId);
    emit();
  };
  return [text, update] as const;
}

/**
 * Add text after what a panel draft already holds, separated by one blank
 * line. Used when something is returned into a conversation whose composer is
 * a panel tab; the mounted composer follows through `useProjectAgentDraft`.
 */
export function appendProjectAgentDraft(key: string, addition: string): void {
  if (!addition.trim()) return;
  const base = (drafts.get(key) ?? "").replace(/\s+$/, "");
  drafts.set(key, base ? `${base}\n\n${addition}` : addition);
  emit();
}
