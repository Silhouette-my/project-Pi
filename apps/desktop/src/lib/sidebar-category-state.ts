import { useSyncExternalStore } from "react";

/**
 * Which sidebar categories (and the 最近/Recent group) the user folded. This is
 * a per-window view convenience, not workflow data: the Host snapshot owns what
 * exists, this only remembers what is collapsed. Absent means expanded.
 */
const STORAGE_KEY = "pi.sidebar.collapsedGroups";
let collapsed: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();

function load(): ReadonlySet<string> {
  if (collapsed) return collapsed;
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    collapsed = new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    collapsed = new Set();
  }
  return collapsed;
}

export function isSidebarGroupCollapsed(id: string, state: ReadonlySet<string> = load()) {
  return state.has(id);
}

export function setSidebarGroupCollapsed(id: string, value: boolean) {
  const next = new Set(load());
  if (value) next.add(id);
  else next.delete(id);
  collapsed = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    /* Storage can be unavailable; the in-memory state still applies. */
  }
  listeners.forEach((listener) => listener());
}

/** Test seam: forget the cached state so the next read reloads storage. */
export function resetSidebarGroupState() {
  collapsed = null;
}

export function useSidebarCollapsedGroups(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    load,
  );
}
