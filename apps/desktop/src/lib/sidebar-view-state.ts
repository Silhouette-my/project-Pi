import { useSyncExternalStore } from "react";

/**
 * Which list the sidebar shows: the category tree or the Favorites view. Like
 * the folded categories this is a per-window view preference, not workflow
 * data, so it lives in local storage and the Host never sees it.
 */
export type SidebarListView = "tree" | "favorites";

const STORAGE_KEY = "pi.sidebar.listView";
let view: SidebarListView | null = null;
const listeners = new Set<() => void>();

function load(): SidebarListView {
  if (view) return view;
  try {
    view = globalThis.localStorage?.getItem(STORAGE_KEY) === "favorites" ? "favorites" : "tree";
  } catch {
    view = "tree";
  }
  return view;
}

export function setSidebarListView(next: SidebarListView) {
  if (load() === next) return;
  view = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next);
  } catch {
    /* Storage can be unavailable; the in-memory choice still applies. */
  }
  listeners.forEach((listener) => listener());
}

export function toggleSidebarFavoritesView() {
  setSidebarListView(load() === "favorites" ? "tree" : "favorites");
}

/** Test seam: forget the cached choice so the next read reloads storage. */
export function resetSidebarListView() {
  view = null;
}

export function useSidebarListView(): SidebarListView {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    load,
  );
}
