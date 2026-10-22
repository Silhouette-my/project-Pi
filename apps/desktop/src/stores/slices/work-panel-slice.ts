import { api } from "../../lib/api";
import { isRemoteSession } from "../../lib/remote-session-safety";
import {
  isProjectPanelContextKey,
  markProjectAgentTabClosed,
  workPanelContextKey,
} from "../../lib/project-panel";
import {
  activateWorkPanelTabState,
  browserPluginTab,
  browserTabLabel,
  closeWorkPanelTabState,
  createWorkPanelFileRequest,
  emptyWorkPanelContext,
  fileWorkPanelTab,
  newWorkPanelTab,
  openWorkPanelTabState,
  reorderWorkPanelTabsState,
  replaceWorkPanelTabState,
  sanitizeWorkPanelTabsState,
  subagentWorkPanelTab,
  switchWorkPanelContextState,
  type WorkPanelContext,
  type WorkPanelTab,
} from "../../lib/work-panel-tabs";
import {
  WORK_PANEL_COMPACT_MIN_WIDTH,
  WORK_PANEL_DEFAULT_WIDTH,
  WORK_PANEL_MIN_WIDTH,
} from "../../lib/work-panel-resize";
import type { AppState } from "../app-state";
import type { StoreAccess } from "./types";

const WORK_PANEL_STORAGE_KEY = "pi.desktop.workPanel";

export function loadWorkPanelWidth(): number {
  try {
    const raw = localStorage.getItem(WORK_PANEL_STORAGE_KEY);
    if (!raw) return WORK_PANEL_DEFAULT_WIDTH;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const width = Number(parsed.width);
    // Only the former sidebar-reopen path stored widths below the regular
    // minimum; that width was lent to the sidebar, not chosen by the user.
    return Number.isFinite(width)
      ? Math.max(WORK_PANEL_MIN_WIDTH, Math.round(width))
      : WORK_PANEL_DEFAULT_WIDTH;
  } catch {
    return WORK_PANEL_DEFAULT_WIDTH;
  }
}

function saveWorkPanelWidth(width: number): void {
  try {
    localStorage.setItem(WORK_PANEL_STORAGE_KEY, JSON.stringify({ width }));
  } catch {
    // best-effort persistence
  }
}

export function currentWorkPanelContext(state: AppState): WorkPanelContext {
  const tabs = sanitizeWorkPanelTabsState({
    tabs: state.workPanelTabs,
    activeTabId: state.activeWorkPanelTabId,
  });
  return {
    open: state.workPanelOpen,
    tabs: tabs.tabs,
    activeTabId: tabs.activeTabId,
    fileRequest: state.workPanelFileRequest,
  };
}

/** The context the panel presents now: the project's on the project page, else the session's. */
export function presentedWorkPanelContextKey(
  state: Pick<AppState, "page" | "projectConsoleId" | "activeSessionId">,
): string | undefined {
  return workPanelContextKey(state);
}

type WorkPanelProjection = Pick<
  AppState,
  | "workPanelContexts"
  | "workPanelOpen"
  | "workPanelTabs"
  | "activeWorkPanelTabId"
  | "workPanelFileRequest"
>;

function projectionOf(
  contexts: Record<string, WorkPanelContext>,
  visible: WorkPanelContext,
): WorkPanelProjection {
  return {
    workPanelContexts: contexts,
    workPanelOpen: visible.open,
    workPanelTabs: visible.tabs,
    activeWorkPanelTabId: visible.activeTabId,
    workPanelFileRequest: visible.fileRequest,
  };
}

/**
 * Move the visible projection to another session's context. While the project
 * page is presented the projection belongs to the project context, which a
 * session change underneath must not disturb: the session's own context is
 * picked up when the page leaves the project.
 */
export function switchWorkPanelSession(
  state: AppState,
  nextSessionId?: string,
): WorkPanelProjection {
  if (isProjectPanelContextKey(presentedWorkPanelContextKey(state))) {
    return projectionOf(state.workPanelContexts, currentWorkPanelContext(state));
  }
  const switched = switchWorkPanelContextState(
    state.workPanelContexts,
    state.activeSessionId,
    currentWorkPanelContext(state),
    nextSessionId,
  );
  return projectionOf(switched.contexts, switched.visible);
}

/**
 * Swap the visible projection when the page enters or leaves a project, or
 * moves between projects (ADR 0028 contexts, project-scoped). Session changes
 * on the chat page keep their own switch in `selectSession`; this only
 * handles the page-level change, so both contexts survive the round trip.
 * Returns undefined when the presented context did not change kind.
 */
export function switchWorkPanelPage(
  state: AppState,
  previous: Pick<AppState, "page" | "projectConsoleId">,
): WorkPanelProjection | undefined {
  const before = presentedWorkPanelContextKey({
    page: previous.page,
    projectConsoleId: previous.projectConsoleId,
    activeSessionId: state.activeSessionId,
  });
  const after = presentedWorkPanelContextKey(state);
  if (before === after) return undefined;
  if (!isProjectPanelContextKey(before) && !isProjectPanelContextKey(after)) return undefined;
  const switched = switchWorkPanelContextState(
    state.workPanelContexts,
    before,
    currentWorkPanelContext(state),
    after,
  );
  return projectionOf(switched.contexts, switched.visible);
}

export type WorkPanelSliceDependencies = StoreAccess & {
  isSessionSelectionPending: (sessionId: string) => boolean;
};

export function createWorkPanelSlice({
  get,
  set,
  isSessionSelectionPending,
}: WorkPanelSliceDependencies): Pick<
  AppState,
  "openSubagentTab"
  | "openWorkPanel"
  | "toggleWorkPanel"
  | "openWorkPanelTab"
  | "openNewWorkPanelTab"
  | "replaceWorkPanelTab"
  | "openWorkPanelTabForSession"
  | "activateWorkPanelTab"
  | "reorderWorkPanelTabs"
  | "closeWorkPanelTab"
  | "collapseWorkPanel"
  | "resetWorkPanelContext"
  | "setWorkPanelWidth"
  | "setWorkPanelYieldedWidth"
  | "openFileInWorkPanel"
  | "openUrlInWorkPanel"
  | "updateBrowserWorkPanelTab"
> {
  let workPanelFileRequestSeq = 0;
  const nextFileRequest = (tab?: WorkPanelTab): WorkPanelContext["fileRequest"] => {
    if (!tab || tab.kind !== "file" || !tab.resource) return null;
    return createWorkPanelFileRequest(tab, ++workPanelFileRequestSeq);
  };

  return {
  openSubagentTab: (delegationId, agentName) => {
    const id = delegationId.trim();
    if (!id) return;
    get().openWorkPanelTab(subagentWorkPanelTab(id, agentName || undefined));
  },

  openWorkPanel: () => {
    const state = get();
    const sessionId = presentedWorkPanelContextKey(state);
    if (!sessionId) return;
    const context = currentWorkPanelContext(state);
    set({
      workPanelOpen: true,
      workPanelContexts: {
        ...state.workPanelContexts,
        [sessionId]: { ...context, open: true },
      },
    });
  },

  toggleWorkPanel: () => {
    const state = get();
    if (state.workPanelOpen) {
      state.collapseWorkPanel();
      return;
    }
    state.openWorkPanel();
  },

  openWorkPanelTabForSession: (sessionId, tab) => {
    if (!sessionId) return;
    const projectContext = isProjectPanelContextKey(sessionId);
    if (!projectContext && (isRemoteSession(get().sessions.find((session) => session.id === sessionId)) || sessionId.startsWith("remote:"))) return;
    set((state) => {
      const affectsVisibleSession =
        presentedWorkPanelContextKey(state) === sessionId &&
        (projectContext ||
          !isSessionSelectionPending(sessionId) ||
          // The selection has committed (the projection is this session's);
          // only the runtime's own pending marker has not been released yet.
          (state.activeSessionId === sessionId && !state.selectingSessionId));
      const context = affectsVisibleSession
        ? currentWorkPanelContext(state)
        : state.workPanelContexts[sessionId] ?? emptyWorkPanelContext();
      const next = openWorkPanelTabState(
        {
          tabs: context.tabs,
          activeTabId: context.activeTabId,
        },
        tab,
      );
      const fileRequest = nextFileRequest(tab) ?? context.fileRequest;
      const nextContext: WorkPanelContext = {
        open: true,
        tabs: next.tabs,
        activeTabId: next.activeTabId,
        fileRequest,
      };
      return {
        workPanelContexts: {
          ...state.workPanelContexts,
          [sessionId]: nextContext,
        },
        ...(affectsVisibleSession
          ? {
              workPanelOpen: true,
              workPanelTabs: next.tabs,
              activeWorkPanelTabId: next.activeTabId,
              workPanelFileRequest: fileRequest,
            }
          : {}),
      };
    });
  },
  openWorkPanelTab: (tab) => {
    const sessionId = presentedWorkPanelContextKey(get());
    if (!sessionId) return;
    get().openWorkPanelTabForSession(sessionId, tab);
  },
  openNewWorkPanelTab: () => {
    const sessionId = presentedWorkPanelContextKey(get());
    if (!sessionId) return;
    get().openWorkPanelTabForSession(sessionId, newWorkPanelTab());
  },
  replaceWorkPanelTab: (sourceTabId, tab) => {
    set((state) => {
      const sessionId = presentedWorkPanelContextKey(state);
      if (!sessionId) return {};
      if (!isProjectPanelContextKey(sessionId) && (isRemoteSession(state.sessions.find((session) => session.id === sessionId)) || sessionId.startsWith("remote:"))) return {};
      const next = replaceWorkPanelTabState(
        {
          tabs: state.workPanelTabs,
          activeTabId: state.activeWorkPanelTabId,
        },
        sourceTabId,
        tab,
      );
      const activeTab = next.tabs.find((item) => item.id === next.activeTabId);
      const fileRequest = nextFileRequest(activeTab) ?? state.workPanelFileRequest;
      const nextContext: WorkPanelContext = {
        open: true,
        tabs: next.tabs,
        activeTabId: next.activeTabId,
        fileRequest,
      };
      return {
        workPanelOpen: true,
        workPanelTabs: next.tabs,
        activeWorkPanelTabId: next.activeTabId,
        workPanelFileRequest: fileRequest,
        workPanelContexts: {
          ...state.workPanelContexts,
          [sessionId]: nextContext,
        },
      };
    });
  },
  activateWorkPanelTab: (tabId) => {
    set((state) => {
      const sessionId = presentedWorkPanelContextKey(state);
      if (!sessionId) return {};
      const next = activateWorkPanelTabState(
        {
          tabs: state.workPanelTabs,
          activeTabId: state.activeWorkPanelTabId,
        },
        tabId,
      );
      const activeTab = next.tabs.find((tab) => tab.id === next.activeTabId);
      const fileRequest = nextFileRequest(activeTab) ?? state.workPanelFileRequest;
      const nextContext: WorkPanelContext = {
        open: state.workPanelOpen,
        tabs: next.tabs,
        activeTabId: next.activeTabId,
        fileRequest,
      };
      return {
        activeWorkPanelTabId: next.activeTabId,
        workPanelFileRequest: fileRequest,
        workPanelContexts: {
          ...state.workPanelContexts,
          [sessionId]: nextContext,
        },
      };
    });
  },
  reorderWorkPanelTabs: (sourceTabId, targetTabId, insertAfter) => {
    set((state) => {
      const sessionId = presentedWorkPanelContextKey(state);
      if (!sessionId) return {};
      const next = reorderWorkPanelTabsState(
        {
          tabs: state.workPanelTabs,
          activeTabId: state.activeWorkPanelTabId,
        },
        sourceTabId,
        targetTabId,
        insertAfter,
      );
      if (next.tabs === state.workPanelTabs) return {};
      const nextContext: WorkPanelContext = {
        open: state.workPanelOpen,
        tabs: next.tabs,
        activeTabId: next.activeTabId,
        fileRequest: state.workPanelFileRequest,
      };
      return {
        workPanelTabs: next.tabs,
        activeWorkPanelTabId: next.activeTabId,
        workPanelContexts: {
          ...state.workPanelContexts,
          [sessionId]: nextContext,
        },
      };
    });
  },
  closeWorkPanelTab: (tabId) => {
    const current = get();
    const closing = current.workPanelTabs.find((tab) => tab.id === tabId);
    const closingKey = presentedWorkPanelContextKey(current);
    // Closing the project Agent tab is a choice a default open must respect.
    if (closing?.kind === "project-agent" && closingKey) markProjectAgentTabClosed(closingKey);
    if (current.activeSessionId && !isProjectPanelContextKey(closingKey) && current.workPanelTabs.some((tab) => tab.id === tabId && tab.resource === "pi.browser/browser")) {
      void api.pluginViewClose("pi.browser", "browser", { sessionId: current.activeSessionId, tabId })
        .catch((error) => get().showToast(String(error), { variant: "error" }));
    }
    set((state) => {
      const sessionId = presentedWorkPanelContextKey(state);
      if (!sessionId) return {};
      const next = closeWorkPanelTabState(
        {
          tabs: state.workPanelTabs,
          activeTabId: state.activeWorkPanelTabId,
        },
        tabId,
      );
      const activeTab = next.tabs.find((tab) => tab.id === next.activeTabId);
      const fileRequest = nextFileRequest(activeTab) ?? state.workPanelFileRequest;
      const nextContext: WorkPanelContext = {
        // Closing the final tab leaves the panel open so the user can choose
        // another tool from the new-tab launcher instead of losing the dock.
        open: state.workPanelOpen,
        tabs: next.tabs,
        activeTabId: next.activeTabId,
        fileRequest,
      };
      return {
        workPanelTabs: next.tabs,
        activeWorkPanelTabId: next.activeTabId,
        workPanelOpen: state.workPanelOpen,
        workPanelFileRequest: fileRequest,
        workPanelContexts: {
          ...state.workPanelContexts,
          [sessionId]: nextContext,
        },
      };
    });
  },
  collapseWorkPanel: () => {
    const state = get();
    const sessionId = presentedWorkPanelContextKey(state);
    if (!sessionId || !state.workPanelOpen) return;
    set({
      workPanelOpen: false,
      workPanelContexts: {
        ...state.workPanelContexts,
        [sessionId]: { ...currentWorkPanelContext(state), open: false },
      },
    });
  },
  resetWorkPanelContext: () => {
    set((state) => switchWorkPanelSession(state));
  },
  setWorkPanelWidth: (width) => {
    const committedWidth = Math.round(width);
    set({
      workPanelWidth: Math.max(WORK_PANEL_MIN_WIDTH, committedWidth),
      // An explicit resize replaces any width lent to a reopened sidebar.
      workPanelYieldedWidth: null,
    });
    saveWorkPanelWidth(get().workPanelWidth);
  },
  setWorkPanelYieldedWidth: (width) => {
    const next =
      width === null
        ? null
        : Math.max(WORK_PANEL_COMPACT_MIN_WIDTH, Math.round(width));
    if (get().workPanelYieldedWidth === next) return;
    set({ workPanelYieldedWidth: next });
  },

  openFileInWorkPanel: (path, mimeType, position) => {
    get().openWorkPanelTab(fileWorkPanelTab(path, mimeType, position));
  },
  updateBrowserWorkPanelTab: (event) => {
    const sessionId = event.sessionId;
    if (!sessionId || !event.tabId || !event.url) return;
    set((state) => {
      const visible = presentedWorkPanelContextKey(state) === sessionId && !isSessionSelectionPending(sessionId);
      const context = visible ? currentWorkPanelContext(state) : state.workPanelContexts[sessionId];
      if (!context || !context.tabs.some((tab) => tab.id === event.tabId && tab.resource === "pi.browser/browser")) return {};
      const tabs = context.tabs.map((tab) => tab.id === event.tabId
        ? { ...tab, location: event.url, label: !event.isLoading && !event.loadError && event.title ? event.title : browserTabLabel(event.url) }
        : tab);
      return { ...(visible ? { workPanelTabs: tabs } : {}),
        workPanelContexts: { ...state.workPanelContexts, [sessionId]: { ...context, tabs } } };
    });
  },
  openUrlInWorkPanel: (url) => {
    if (isRemoteSession(get().sessions.find((session) => session.id === get().activeSessionId))) return;
    const hasBrowser = get().pluginViews.some(
      (view) => view.pluginId === "pi.browser" && view.viewId === "browser",
    );
    // The project context has no session to own a browser view.
    if (!hasBrowser || isProjectPanelContextKey(presentedWorkPanelContextKey(get()))) {
      if (/^https?:\/\//i.test(url.trim())) {
        void api.browserOpenExternal(url.trim());
      }
      return;
    }
    get().openWorkPanelTab(browserPluginTab(url));
  },
  };
}
