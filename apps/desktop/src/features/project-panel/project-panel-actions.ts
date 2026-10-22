import { useAppStore } from "../../stores/app-store";
import {
  hasProjectAgentTab,
  projectAgentWorkPanelTab,
  projectPanelContextKey,
  projectSideWorkPanelTab,
} from "../../lib/project-panel";
import type { WorkPanelTab } from "../../lib/work-panel-tabs";

function projectTabs(projectId: string): readonly WorkPanelTab[] {
  const state = useAppStore.getState();
  const key = projectPanelContextKey(projectId);
  const presented = state.page === "project" && state.projectConsoleId === projectId;
  return presented ? state.workPanelTabs : (state.workPanelContexts[key]?.tabs ?? []);
}

/**
 * Open a tab in the project's own work-panel context and present the panel.
 * The project Agent tab is always there first, so a side conversation never
 * leaves the panel without the discussion beside it.
 */
export function openProjectPanelTab(projectId: string, tab: WorkPanelTab): void {
  const store = useAppStore.getState();
  const key = projectPanelContextKey(projectId);
  if (tab.kind !== "project-agent" && !hasProjectAgentTab(projectTabs(projectId), projectId)) {
    store.openWorkPanelTabForSession(key, projectAgentWorkPanelTab(projectId));
  }
  store.openWorkPanelTabForSession(key, tab);
}

export function openProjectAgentPanel(projectId: string): void {
  openProjectPanelTab(projectId, projectAgentWorkPanelTab(projectId));
}

/** Open a side conversation of the project beside the console. */
export function openProjectSidePanel(projectId: string, sessionId: string, label?: string): void {
  openProjectPanelTab(projectId, projectSideWorkPanelTab(sessionId, label));
}

/**
 * The Explore side conversation's "review proposals" link: take the project
 * page to its Shared context tab for the workstream. The console owns its tab
 * state, so this is a request it consumes (now if mounted, on mount if not).
 */
type ContextViewRequest = { projectId: string; workstreamId?: string };
let pendingContextView: ContextViewRequest | null = null;
const contextViewListeners = new Set<() => void>();

export function requestProjectContextView(projectId: string, workstreamId?: string): void {
  pendingContextView = { projectId, workstreamId };
  const state = useAppStore.getState();
  if (state.page !== "project" || state.projectConsoleId !== projectId) {
    state.setPage("project", { projectId });
  }
  for (const listener of contextViewListeners) listener();
}

export function takeProjectContextView(projectId: string): ContextViewRequest | null {
  if (pendingContextView?.projectId !== projectId) return null;
  const request = pendingContextView;
  pendingContextView = null;
  return request;
}

export function subscribeProjectContextView(listener: () => void): () => void {
  contextViewListeners.add(listener);
  return () => {
    contextViewListeners.delete(listener);
  };
}
