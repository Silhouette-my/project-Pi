import { isRemoteSession } from "../../lib/remote-session-safety";
import { RemoteWorkspace } from "../remote/RemoteWorkspace";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { UseEdgeRevealResult } from "../../hooks/use-edge-reveal";
import { useBlockingOverlayActive } from "../../lib/blocking-overlay";
import {
  workPanelTabReorderScrollDelta,
  workPanelTabReorderInsertAfter,
  workPanelTabReorderShouldArm,
} from "../../lib/work-panel-tab-reorder";
import {
  ACTIVE_TAB_MIN_WIDTH,
  TAB_TITLE_MIN_WIDTH,
  adjacentTabId,
  freezeTabWidths,
  tabStripLayout,
  tabWidth,
  workPanelShortcut,
} from "../../lib/work-panel-strip";
import {
  isKnownWorkPanelTab,
  parsePluginViewRef,
  pluginWorkPanelTab,
  subagentTabDisplayLabels,
  toolWorkPanelTab,
} from "../../lib/work-panel-tabs";
import type { PluginViewMeta } from "@pi-desktop/shared";
import { pluginViewIcon, pluginViewInitial } from "../../lib/plugin-view-icons";
import { useAppStore } from "../../stores/app-store";
import type { WorkPanelTab } from "../../stores/app-store";
import { cx } from "../ui";
import { TooltipButton } from "../ui";
import type { IconProps } from "../icons";
import {
  IconBot,
  IconChat,
  IconClose,
  IconDiff,
  IconFileText,
  IconPanelMaximize,
  IconPanelRestore,
  IconPin,
  IconPlug,
  IconPlus,
} from "../icons";
import { ReviewTab } from "./ReviewTab";
import { FilesTab } from "./FilesTab";
import { PluginViewTab } from "./PluginViewTab";
import { SubagentTranscriptTab } from "./SubagentTranscriptTab";
import { SideChatTab } from "../../features/chat/side-chat/SideChatTab";
import { ProjectAgentTab } from "../../features/project-panel/ProjectAgentTab";
import { ProjectSideTab } from "../../features/project-panel/ProjectSideTab";
import { ProjectPanelEmpty } from "../../features/project-panel/ProjectPanelEmpty";
import { useOptionalProjectWorkflow } from "../../features/project-workflow/useProjectWorkflow";
import { ProjectNewTabMenu } from "./ProjectNewTabMenu";
import {
  isProjectPanelContextKey,
  projectIdOfContextKey,
  workPanelContextKey,
} from "../../lib/project-panel";
import {
  MAIN_PANE_MIN_WIDTH,
  WORK_PANEL_COMPACT_MIN_WIDTH,
  clampWorkPanelWidth,
  workPanelGestureMinimum,
  workPanelLayout,
  workPanelRequestedWidth,
  workPanelResetWidth,
  workPanelWidthBounds,
} from "../../lib/work-panel-resize";

const TAB_ICONS = {
  new: IconPlus,
  review: IconDiff,
  file: IconFileText,
  plugin: IconPlug,
  subagent: IconBot,
  sidechat: IconChat,
  "project-agent": IconBot,
  "project-side": IconChat,
} as const;

type WorkPanelResizeState = {
  pointerId: number;
  startClientX: number;
  startWidth: number;
  minimumWidth: number;
  currentWidth: number;
  frame: number;
};

type WorkPanelTabReorderState = {
  pointerId: number;
  sourceTabId: string;
  activeSessionId: string | undefined;
  activeTabId: string | null;
  tabSignature: string;
  startClientX: number;
  startClientY: number;
  lastClientX: number;
  lastClientY: number;
  targetTabId: string | null;
  insertAfter: boolean;
  armed: boolean;
  autoScrollFrame: number | null;
  onMove: (event: PointerEvent) => void;
  onUp: (event: PointerEvent) => void;
  onCancel: (event: PointerEvent) => void;
};

type WorkPanelTool = {
  id: string;
  tab: WorkPanelTab;
  label: string;
  icon: ComponentType<IconProps> | null;
  initial?: string;
  description?: string;
  shortcut?: string;
};

function tabLabel(
  tab: WorkPanelTab,
  t: (key: string, options?: Record<string, unknown>) => string,
  pluginViews: PluginViewMeta[],
) {
  if (tab.kind === "plugin") {
    if (tab.resource === "pi.browser/browser" && tab.label) return tab.label;
    const view = pluginViews.find((candidate) => candidate.ref === tab.resource);
    // A view whose plugin was disabled mid-session no longer resolves; fall
    // back to its id rather than leaving the tab blank until it closes.
    return view?.title ?? tab.resource ?? t("panel.tabs.plugin");
  }
  if (tab.kind === "new") return t("panel.new.title");
  if (tab.kind === "subagent") return tab.label ?? t("panel.tabs.subagent");
  if (tab.kind === "sidechat") return t("sideChat.title");
  if (tab.kind === "project-agent") return t("projectPanel.agentTab");
  if (tab.kind === "project-side") {
    return tab.label ? t("sideChat.sessionTitle", { title: tab.label }) : t("projectPanel.sideTab");
  }
  if (tab.kind !== "file") return t(`panel.tabs.${tab.kind}`);
  const path = tab.resource ?? "";
  return path.split("/").filter(Boolean).pop() || t("panel.tabs.file");
}

/**
 * The tab tooltip. A side chat or the project Agent has no header any more, so
 * what the header said (what it is about, where it came from, what it may do)
 * lives here. Other tabs keep their resource or label.
 */
function tabTooltip(
  tab: WorkPanelTab,
  label: string,
  t: (key: string, options?: Record<string, unknown>) => string,
  workstreamTitleOf: (sessionId: string) => string | undefined,
): string {
  if (tab.kind === "sidechat") {
    return tab.sideChat?.excerpt
      ? t("workPanel.return.tooltipChat", { excerpt: tab.sideChat.excerpt })
      : label;
  }
  if (tab.kind === "project-agent") return t("workPanel.return.tooltipAgent");
  if (tab.kind === "project-side") {
    const workstream = tab.resource ? workstreamTitleOf(tab.resource) : undefined;
    return workstream ? t("workPanel.return.tooltipSide", { workstream }) : label;
  }
  if (tab.kind === "subagent") return tab.label ?? label;
  return tab.resource ?? label;
}

function workPanelTools(
  t: (key: string) => string,
  pluginViews: PluginViewMeta[],
): WorkPanelTool[] {
  // Review is the only host-owned launcher. Files, Browser, and every future
  // tool are plugin-contributed views, so their list stays data-driven.
  return [
    {
      id: "review",
      tab: toolWorkPanelTab("review"),
      label: t("panel.tabs.review"),
      icon: IconDiff,
    },
    ...pluginViews.map((view) => {
      const Icon = pluginViewIcon(view.icon);
      return {
        id: view.ref,
        tab: pluginWorkPanelTab(view.pluginId, view.viewId),
        label: view.title,
        icon: Icon,
        ...(Icon ? {} : { initial: pluginViewInitial(view.title) }),
        description: view.pluginName,
      };
    }),
  ];
}

function ToolIcon({ item, size = 15 }: { item: WorkPanelTool; size?: number }) {
  if (item.icon) return <item.icon size={size} />;
  return (
    <span className="work-panel-view-initial" aria-hidden>
      {item.initial}
    </span>
  );
}

/** Space between tabs, and the sticky "+" slot (28px button plus its margin). */
const TAB_GAP = 2;
const NEW_TAB_SLOT_WIDTH = 30;

/** Content left visible beside a revealed overlay panel, in CSS pixels. */
const EDGE_PANEL_CONTENT_MARGIN = 48;

export function WorkPanel(props: Parameters<typeof LocalWorkPanel>[0]) {
  const session = useAppStore((state) => state.sessions.find((item) => item.id === state.activeSessionId));
  const sessionId = useAppStore((state) => state.activeSessionId);
  const projectPage = useAppStore((state) => state.page === "project");
  const width = useAppStore((state) => state.workPanelWidth);
  // The project page presents the project's own context, whatever session
  // happens to be active underneath it.
  if (projectPage) return <LocalWorkPanel {...props} />;
  if (session && isRemoteSession(session)) {
    return <RemoteWorkspace key={session.id} session={session} width={Math.min(width, Math.max(280, (props.containerWidth || 900) - 320))}
      exiting={props.exiting} onExitAnimationEnd={props.onExitAnimationEnd}
      edgePanel={props.edgePanel} onClose={props.onCloseOverlay} />;
  }
  if (sessionId?.startsWith("remote:")) return null;
  return <LocalWorkPanel {...props} />;
}

function LocalWorkPanel({
  panelBlocked: panelBlockedRequest = false,
  exiting = false,
  onExitAnimationEnd,
  containerWidth = 0,
  sidebarCollapsed = false,
  sidebarExiting = false,
  sidebarWidth = 0,
  onAutoCollapseSidebar,
  maximized: maximizedRequest = false,
  onToggleMaximize,
  edgePanel,
  pinned = true,
  onTogglePin,
}: {
  /**
   * Hides every native surface in the panel. Both the preview browser and a
   * plugin view are `WebContentsView`s composited above renderer content, so a
   * blocking overlay must suppress them alike.
   */
  panelBlocked?: boolean;
  /** Plays work-panel-out; parent unmounts after animationend. */
  exiting?: boolean;
  onExitAnimationEnd?: () => void;
  /** Current renderer shell width used for the three-column budget. */
  containerWidth?: number;
  /** Sidebar state is part of the shared shell budget. */
  sidebarCollapsed?: boolean;
  /** Keep the dock in the budget while `sidebar-out` still occupies flex space. */
  sidebarExiting?: boolean;
  sidebarWidth?: number;
  /** Called on the first frame where the main pane would hit its hard floor. */
  onAutoCollapseSidebar?: () => void;
  /** Preview mode: the panel takes MainChat's width as well. */
  maximized?: boolean;
  /** Toggles the preview mode from the panel header. */
  onToggleMaximize?: () => void;
  /**
   * Present while the panel is an edge-reveal overlay (unpinned): the
   * `useEdgeReveal` panel props that slide it over the content. An overlay
   * takes no layout width, so the three-column budget does not apply to it.
   */
  edgePanel?: UseEdgeRevealResult["panelProps"];
  /** Closes an overlay panel (used by the remote workspace's close button). */
  onCloseOverlay?: () => void;
  /** Docked permanently; false while it auto-hides. */
  pinned?: boolean;
  onTogglePin?: () => void;
}) {
  const { t } = useTranslation();
  const overlay = edgePanel !== undefined;
  // Preview mode needs the dock: MainChat is removed beside it. An overlay
  // never maximizes; pin the panel first.
  const maximized = maximizedRequest && !overlay;
  // The overlay slides in with a transform, and native plugin views read their
  // bounds from the DOM, so they wait for the slide to settle.
  const [overlayEntering, setOverlayEntering] = useState(overlay);
  useEffect(() => {
    if (!overlay || !overlayEntering) return;
    const timer = window.setTimeout(() => setOverlayEntering(false), 400);
    return () => window.clearTimeout(timer);
  }, [overlay, overlayEntering]);
  const panelBlocked = panelBlockedRequest || overlayEntering;
  const blockingOverlayActive = useBlockingOverlayActive();
  const rawTabs = useAppStore((s) => s.workPanelTabs);
  const tabs = rawTabs.filter(isKnownWorkPanelTab);
  const activeTabId = useAppStore((s) => s.activeWorkPanelTabId);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  // The context key is what tab reordering must not outlive: the session's id,
  // or `project:<id>` on the project page.
  const contextKey = useAppStore((s) => workPanelContextKey(s));
  const projectContext = isProjectPanelContextKey(contextKey);
  const pluginViews = useAppStore((s) => s.pluginViews);
  const width = useAppStore((s) => s.workPanelWidth);
  const yieldedWidth = useAppStore((s) => s.workPanelYieldedWidth);
  const activateTab = useAppStore((s) => s.activateWorkPanelTab);
  const reorderTabs = useAppStore((s) => s.reorderWorkPanelTabs);
  const closeTab = useAppStore((s) => s.closeWorkPanelTab);
  const openWorkPanelTab = useAppStore((s) => s.openWorkPanelTab);
  const openNewWorkPanelTab = useAppStore((s) => s.openNewWorkPanelTab);
  const replaceWorkPanelTab = useAppStore((s) => s.replaceWorkPanelTab);
  const setWidth = useAppStore((s) => s.setWorkPanelWidth);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const tools = workPanelTools(t, pluginViews);
  const tabSignature = JSON.stringify(
    tabs.map(({ id, kind, resource, location }) => [id, kind, resource, location]),
  );
  // Subagent tabs may share an agent name; repeats gain a 1-based `#n`
  // suffix in strip order so the row stays unambiguous. The base label
  // already falls back to panel.tabs.subagent when no name was captured.
  const subagentTabsInOrder = tabs.filter(
    (tab) => tab.kind === "subagent" || tab.kind === "sidechat",
  );
  const subagentDisplayLabels = subagentTabDisplayLabels(
    subagentTabsInOrder.map((tab) => tabLabel(tab, t, pluginViews)),
  );
  const subagentLabelById = new Map(
    subagentTabsInOrder.map(
      (tab, index) => [tab.id, subagentDisplayLabels[index]] as const,
    ),
  );

  const workflow = useOptionalProjectWorkflow();
  const workstreamTitleOf = useCallback(
    (sessionId: string) => {
      const link = workflow?.snapshot?.conversations.find((item) => item.sessionId === sessionId);
      return link
        ? workflow?.snapshot?.workstreams.find((item) => item.id === link.workstreamId)?.title
        : undefined;
    },
    [workflow?.snapshot],
  );
  const projectId = projectIdOfContextKey(contextKey);
  const stripWrapRef = useRef<HTMLDivElement | null>(null);
  const [stripWidth, setStripWidth] = useState(0);
  const [stripFade, setStripFade] = useState({ start: false, end: false });
  // Widths held after a close button press, so the next close lands under the
  // pointer; released when the pointer leaves the strip.
  const [frozenWidths, setFrozenWidths] = useState<Record<string, number> | null>(null);
  const [panelDragWidth, setPanelDragWidth] = useState<number | null>(null);
  const panelResizeState = useRef<WorkPanelResizeState | null>(null);
  const tabReorderState = useRef<WorkPanelTabReorderState | null>(null);
  // The sticky "+" and the gaps between tabs come out of the room tabs share.
  const stripAvailable = stripWidth - NEW_TAB_SLOT_WIDTH - Math.max(0, tabs.length - 1) * TAB_GAP;
  const stripLayout = tabStripLayout(stripAvailable, tabs.length);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const suppressedTabClickPointerIdsRef = useRef<Set<number>>(new Set());
  const tabWrapperRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const tabButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const tabCloseButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const newTabButtonRef = useRef<HTMLButtonElement | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    tabId: string;
    insertAfter: boolean;
  } | null>(null);
  const [nativeSurfaceReadyForExit, setNativeSurfaceReadyForExit] =
    useState(false);

  // The first render can precede ResizeObserver's first notification. Use a
  // conservative shell estimate for that frame; the measured width takes over
  // before a user can interact with the divider.
  const sidebarOccupiesBudget = !sidebarCollapsed || sidebarExiting;
  const budgetWidth =
    containerWidth > 0
      ? containerWidth
      : (panelDragWidth ?? width) +
        (sidebarOccupiesBudget ? sidebarWidth : 0) +
        MAIN_PANE_MIN_WIDTH;
  // A drag preview is an explicit width; otherwise the panel asks for its
  // preferred width, or the width it lent to a manually reopened sidebar.
  const requestedPanelWidth =
    panelDragWidth ??
    workPanelRequestedWidth({
      containerWidth: budgetWidth,
      sidebarWidth,
      sidebarCollapsed: !sidebarOccupiesBudget,
      preferredWidth: width,
      yieldedWidth,
    });
  const dockLayout = workPanelLayout({
    containerWidth: budgetWidth,
    sidebarWidth,
    sidebarCollapsed: !sidebarOccupiesBudget,
    requestedPanelWidth,
    maximized,
  });
  // An overlay is bounded by the window, not by the MainChat floor: it floats
  // over the content, so neither the floor nor the sidebar yield applies.
  const overlayMaxWidth = Math.max(
    WORK_PANEL_COMPACT_MIN_WIDTH,
    Math.round(budgetWidth) - EDGE_PANEL_CONTENT_MARGIN,
  );
  const layout = overlay
    ? {
        mainWidth: 0,
        panelWidth: Math.min(
          clampWorkPanelWidth(panelDragWidth ?? width),
          overlayMaxWidth,
        ),
        maxPanelWidth: overlayMaxWidth,
        shouldCollapseSidebar: false,
      }
    : dockLayout;
  const renderPanelWidth = layout.panelWidth;
  const panelMinimum = workPanelGestureMinimum(renderPanelWidth);
  const isResizing = panelDragWidth !== null;

  useLayoutEffect(() => {
    if (!exiting && layout.shouldCollapseSidebar) onAutoCollapseSidebar?.();
  }, [exiting, layout.shouldCollapseSidebar, onAutoCollapseSidebar]);

  useEffect(() => {
    if (isResizing) {
      document.documentElement.setAttribute("data-work-panel-resizing", "true");
    } else {
      document.documentElement.removeAttribute("data-work-panel-resizing");
    }
    return () => {
      document.documentElement.removeAttribute("data-work-panel-resizing");
    };
  }, [isResizing]);

  useEffect(() => {
    if (!exiting) {
      setNativeSurfaceReadyForExit(false);
      return;
    }
    // Plugin views (and the host guest clamped to them) hide via `blocked`
    // before the dock CSS animation starts.
    setNativeSurfaceReadyForExit(true);
  }, [exiting]);

  useLayoutEffect(() => {
    if (!activeTabId) return;
    tabWrapperRefs.current[activeTabId]?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
    tabButtonRefs.current[activeTabId]?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
    tabCloseButtonRefs.current[activeTabId]?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeTabId, tabs.length]);

  // Tabs are sized from the room the strip has, so it is measured (not
  // guessed) and re-measured whenever the panel is resized.
  useLayoutEffect(() => {
    const node = stripWrapRef.current;
    if (!node) return;
    const update = () => setStripWidth(node.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Edge fades show only on the side that has more tabs to scroll to.
  const updateStripFade = useCallback(() => {
    const strip = tabStripRef.current;
    if (!strip) return;
    const start = strip.scrollLeft > 1;
    const end = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
    setStripFade((current) =>
      current.start === start && current.end === end ? current : { start, end },
    );
  }, []);
  useLayoutEffect(() => {
    updateStripFade();
  }, [updateStripFade, stripWidth, tabSignature, frozenWidths, activeTabId]);

  // A held width only lasts for the run of closes it was made for.
  useEffect(() => {
    setFrozenWidths(null);
  }, [contextKey]);

  const finishTabReorder = useCallback(() => {
    const state = tabReorderState.current;
    if (state) {
      window.removeEventListener("pointermove", state.onMove, true);
      window.removeEventListener("pointerup", state.onUp, true);
      window.removeEventListener("pointercancel", state.onCancel, true);
      if (state.autoScrollFrame !== null) {
        cancelAnimationFrame(state.autoScrollFrame);
        state.autoScrollFrame = null;
      }
      tabReorderState.current = null;
    }
    setDraggingTabId(null);
    setDropIndicator(null);
    document.documentElement.removeAttribute("data-work-panel-tab-reordering");
  }, []);

  useLayoutEffect(() => {
    const state = tabReorderState.current;
    if (
      state &&
      (state.activeSessionId !== contextKey ||
        state.activeTabId !== activeTabId ||
        state.tabSignature !== tabSignature)
    ) {
      suppressedTabClickPointerIdsRef.current.add(state.pointerId);
      finishTabReorder();
    }
  }, [contextKey, activeTabId, finishTabReorder, tabSignature]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = tabReorderState.current;
      if (event.key !== "Escape" || !state) return;
      event.preventDefault();
      suppressedTabClickPointerIdsRef.current.add(state.pointerId);
      finishTabReorder();
    };
    const onWindowBlur = () => {
      const state = tabReorderState.current;
      if (state) suppressedTabClickPointerIdsRef.current.add(state.pointerId);
      finishTabReorder();
    };
    const onPointerDown = (event: PointerEvent) => {
      // A reused pointer id starts a new gesture; unrelated pointers do not
      // clear a canceled gesture's pending click suppression.
      suppressedTabClickPointerIdsRef.current.delete(event.pointerId);
    };
    const onClick = (event: MouseEvent) => {
      if (
        event.detail === 0 ||
        !("pointerId" in event) ||
        typeof event.pointerId !== "number" ||
        !suppressedTabClickPointerIdsRef.current.has(event.pointerId)
      ) {
        return;
      }
      suppressedTabClickPointerIdsRef.current.delete(event.pointerId);
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('[role="tab"]')
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("click", onClick, true);
      suppressedTabClickPointerIdsRef.current.clear();
      finishTabReorder();
    };
  }, [finishTabReorder]);

  const reorderTab = useCallback(
    (sourceTabId: string, targetTabId: string, insertAfter: boolean) => {
      if (sourceTabId === targetTabId) return;
      reorderTabs(sourceTabId, targetTabId, insertAfter);
      requestAnimationFrame(() => {
        tabButtonRefs.current[sourceTabId]?.focus({ preventScroll: true });
      });
    },
    [reorderTabs],
  );

  const beginTabReorder = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, sourceTabId: string) => {
      if (
        event.button !== 0 ||
        event.pointerType === "touch" ||
        tabReorderState.current
      ) {
        return;
      }
      // Pointer click suppression is armed only when this drag completes.

      const updateDropTarget = (state: WorkPanelTabReorderState) => {
        const strip = tabStripRef.current;
        const target = strip
          ? document
              .elementFromPoint(state.lastClientX, state.lastClientY)
              ?.closest<HTMLElement>("[data-work-panel-tab-id]")
          : null;
        if (!target || !strip?.contains(target)) {
          state.targetTabId = null;
          setDropIndicator(null);
          return;
        }

        const targetTabId = target.dataset.workPanelTabId;
        if (!targetTabId || targetTabId === state.sourceTabId) {
          state.targetTabId = null;
          setDropIndicator(null);
          return;
        }
        const rect = target.getBoundingClientRect();
        const insertAfter = workPanelTabReorderInsertAfter(
          state.lastClientX,
          rect.left,
          rect.width,
        );
        state.targetTabId = targetTabId;
        state.insertAfter = insertAfter;
        setDropIndicator({ tabId: targetTabId, insertAfter });
      };

      const startAutoScroll = (state: WorkPanelTabReorderState) => {
        if (state.autoScrollFrame !== null) return;

        const tick = () => {
          const current = tabReorderState.current;
          const strip = tabStripRef.current;
          if (!current || current !== state || !current.armed || !strip) {
            state.autoScrollFrame = null;
            return;
          }

          const stripRect = strip.getBoundingClientRect();
          if (
            current.lastClientY < stripRect.top ||
            current.lastClientY > stripRect.bottom ||
            strip.scrollWidth <= strip.clientWidth
          ) {
            current.autoScrollFrame = null;
            return;
          }

          const delta = workPanelTabReorderScrollDelta(
            current.lastClientX,
            stripRect.left,
            stripRect.right,
          );
          if (!delta) {
            current.autoScrollFrame = null;
            return;
          }

          const maxScrollLeft = strip.scrollWidth - strip.clientWidth;
          const nextScrollLeft = Math.min(
            maxScrollLeft,
            Math.max(0, strip.scrollLeft + delta),
          );
          if (nextScrollLeft === strip.scrollLeft) {
            current.autoScrollFrame = null;
            return;
          }

          strip.scrollLeft = nextScrollLeft;
          updateDropTarget(current);
          current.autoScrollFrame = requestAnimationFrame(tick);
        };

        state.autoScrollFrame = requestAnimationFrame(tick);
      };

      const onMove = (moveEvent: PointerEvent) => {
        const state = tabReorderState.current;
        if (!state || state.pointerId !== moveEvent.pointerId) return;
        state.lastClientX = moveEvent.clientX;
        state.lastClientY = moveEvent.clientY;
        if (!state.armed) {
          if (
            !workPanelTabReorderShouldArm(
              moveEvent.clientX - state.startClientX,
              moveEvent.clientY - state.startClientY,
            )
          ) {
            return;
          }
          state.armed = true;
          document.documentElement.setAttribute(
            "data-work-panel-tab-reordering",
            "true",
          );
          setDraggingTabId(state.sourceTabId);
        }

        moveEvent.preventDefault();
        updateDropTarget(state);
        startAutoScroll(state);
      };

      const onUp = (upEvent: PointerEvent) => {
        const state = tabReorderState.current;
        if (!state || state.pointerId !== upEvent.pointerId) return;
        if (state.armed) {
          upEvent.preventDefault();
          if (state.targetTabId) {
            reorderTab(state.sourceTabId, state.targetTabId, state.insertAfter);
          }
          finishTabReorder();
          suppressedTabClickPointerIdsRef.current.add(state.pointerId);
          return;
        }
        finishTabReorder();
      };

      const onCancel = (cancelEvent: PointerEvent) => {
        if (tabReorderState.current?.pointerId !== cancelEvent.pointerId) return;
        suppressedTabClickPointerIdsRef.current.delete(cancelEvent.pointerId);
        finishTabReorder();
      };

      const state: WorkPanelTabReorderState = {
        pointerId: event.pointerId,
        sourceTabId,
        activeSessionId: contextKey,
        activeTabId,
        tabSignature,
        startClientX: event.clientX,
        startClientY: event.clientY,
        lastClientX: event.clientX,
        lastClientY: event.clientY,
        targetTabId: null,
        insertAfter: false,
        armed: false,
        autoScrollFrame: null,
        onMove,
        onUp,
        onCancel,
      };
      tabReorderState.current = state;
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onCancel, true);
    },
    [contextKey, activeTabId, finishTabReorder, reorderTab, tabSignature],
  );

  const selectTool = useCallback(
    (item: WorkPanelTool, sourceTabId?: string) => {
      if (sourceTabId) {
        replaceWorkPanelTab(sourceTabId, item.tab);
        return;
      }
      const existing = tabs.find((tab) => tab.id === item.tab.id);
      if (existing) activateTab(existing.id);
      else openWorkPanelTab(item.tab);
    },
    [activateTab, openWorkPanelTab, replaceWorkPanelTab, tabs],
  );

  const closeTabAndFocus = useCallback(
    (tabId: string, options?: { holdWidths?: boolean }) => {
      const index = tabs.findIndex((tab) => tab.id === tabId);
      // Closing active activates the right neighbour, else the left one.
      const nextTab = index >= 0 ? tabs[index + 1] ?? tabs[index - 1] : undefined;
      if (options?.holdWidths) {
        const rendered: Record<string, number> = {};
        for (const tab of tabs) {
          const width = tabWrapperRefs.current[tab.id]?.getBoundingClientRect().width;
          if (width) rendered[tab.id] = width;
        }
        setFrozenWidths(freezeTabWidths(rendered, tabId));
      }
      closeTab(tabId);
      requestAnimationFrame(() => {
        if (nextTab) tabButtonRefs.current[nextTab.id]?.focus();
        else newTabButtonRef.current?.focus();
      });
    },
    [closeTab, tabs],
  );
  // Panel-scoped shortcuts: they act only while focus is inside the panel, so
  // no global binding is spent and every shell shortcut keeps its key.
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const shortcut = workPanelShortcut(
        event,
        window.piDesktop?.platform ?? "darwin",
      );
      if (!shortcut) return;
      const focused = document.activeElement;
      if (!(focused instanceof Element) || !focused.closest('[data-testid="work-panel"]')) return;
      const current = activeTabIdRef.current;
      if (shortcut === "close-tab") {
        if (!current) return;
        event.preventDefault();
        event.stopPropagation();
        closeTabAndFocus(current);
        return;
      }
      const target = adjacentTabId(
        tabs.map((tab) => tab.id),
        current,
        shortcut === "next-tab" ? 1 : -1,
      );
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      activateTab(target);
      requestAnimationFrame(() => tabButtonRefs.current[target]?.focus({ preventScroll: true }));
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activateTab, closeTabAndFocus, tabs]);

  const onTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, tabId: string) => {
      const index = tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        closeTabAndFocus(tabId);
        return;
      }
      if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        const target = tabs[index + (event.key === "ArrowLeft" ? -1 : 1)];
        if (!target) return;
        reorderTab(tabId, target.id, event.key === "ArrowRight");
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : event.key === "ArrowLeft"
              ? (index - 1 + tabs.length) % tabs.length
              : (index + 1) % tabs.length;
      const nextTab = tabs[nextIndex];
      if (!nextTab) return;
      activateTab(nextTab.id);
      requestAnimationFrame(() => tabButtonRefs.current[nextTab.id]?.focus());
    },
    [activateTab, closeTabAndFocus, reorderTab, tabs],
  );

  const onTabStripWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const strip = event.currentTarget;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    if (strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft += event.deltaY;
    event.preventDefault();
  };

  const finishPanelResize = useCallback(
    (target: HTMLDivElement, pointerId: number, cancelled: boolean) => {
      const drag = panelResizeState.current;
      if (drag?.pointerId !== pointerId) return;
      panelResizeState.current = null;
      if (drag.frame) cancelAnimationFrame(drag.frame);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      setPanelDragWidth(null);
      if (!cancelled && drag.currentWidth !== drag.startWidth) {
        setWidth(drag.currentWidth);
      }
    },
    [setWidth],
  );

  const onPanelResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // While maximized there is no second column to trade width with.
      if (maximized) return;
      if (event.button !== 0 || panelResizeState.current) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.focus({ preventScroll: true });
      const startWidth = clampWorkPanelWidth(renderPanelWidth, panelMinimum);
      panelResizeState.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startWidth,
        minimumWidth: panelMinimum,
        currentWidth: startWidth,
        frame: 0,
      };
      setPanelDragWidth(startWidth);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [maximized, panelMinimum, renderPanelWidth],
  );

  const onPanelResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = panelResizeState.current;
    if (drag?.pointerId !== event.pointerId) return;
    drag.currentWidth = clampWorkPanelWidth(
      drag.startWidth + drag.startClientX - event.clientX,
      drag.minimumWidth,
    );
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => {
      if (panelResizeState.current !== drag) return;
      drag.frame = 0;
      setPanelDragWidth(drag.currentWidth);
    });
  }, []);

  const onPanelResizeCommit = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      finishPanelResize(event.currentTarget, event.pointerId, false);
    },
    [finishPanelResize],
  );

  const onPanelResizeCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      finishPanelResize(event.currentTarget, event.pointerId, true);
    },
    [finishPanelResize],
  );

  useEffect(
    () => () => {
      const drag = panelResizeState.current;
      if (drag?.frame) cancelAnimationFrame(drag.frame);
      panelResizeState.current = null;
      document.documentElement.removeAttribute("data-work-panel-resizing");
    },
    [],
  );

  const onPanelResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const drag = panelResizeState.current;
      if (event.key === "Escape" && drag) {
        event.preventDefault();
        finishPanelResize(event.currentTarget, drag.pointerId, true);
        return;
      }
      // While maximized there is no second column to trade width with.
      if (maximized) return;
      const step = event.shiftKey ? 32 : 16;
      const { minimum, maximum } = workPanelWidthBounds(
        panelMinimum,
        layout.maxPanelWidth,
      );
      let nextWidth: number | null = null;
      if (event.key === "ArrowLeft") nextWidth = renderPanelWidth + step;
      else if (event.key === "ArrowRight") nextWidth = renderPanelWidth - step;
      else if (event.key === "Home") nextWidth = minimum;
      else if (event.key === "End") nextWidth = maximum;
      if (nextWidth === null) return;
      event.preventDefault();
      const committedWidth = clampWorkPanelWidth(nextWidth, minimum);
      // A key that cannot move the separator commits nothing, so it neither
      // rewrites the preferred width nor ends a width lent to the sidebar.
      if (committedWidth === renderPanelWidth) return;
      setWidth(committedWidth);
    },
    [finishPanelResize, layout.maxPanelWidth, maximized, panelMinimum, renderPanelWidth, setWidth],
  );

  /**
   * Double-click reset: the default width, kept inside the same live bounds
   * the keyboard path uses, so a reset never breaches the MainChat floor or
   * reopens a compact panel wider than the window allows.
   */
  const onPanelResizeReset = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // While maximized there is no second column to trade width with.
      if (maximized) return;
      // A gesture that is still open (a second pointer) must not overwrite the
      // reset when it is finally released.
      const drag = panelResizeState.current;
      if (drag) finishPanelResize(event.currentTarget, drag.pointerId, true);
      setPanelDragWidth(null);
      setWidth(workPanelResetWidth(panelMinimum, layout.maxPanelWidth));
    },
    [finishPanelResize, layout.maxPanelWidth, maximized, panelMinimum, setWidth],
  );

  const activePluginView =
    activeTab?.kind === "plugin"
      ? pluginViews.find((view) => view.ref === activeTab.resource)
      : undefined;
  const activeLabel = activeTab
    ? tabLabel(activeTab, t, pluginViews)
    : t("panel.title");
  const exitAnimationReady = exiting && nativeSurfaceReadyForExit;
  const panelStyle = {
    width: renderPanelWidth,
    maxWidth: layout.maxPanelWidth,
    "--work-panel-width": `${renderPanelWidth}px`,
  } as CSSProperties;

  return (
    <aside
      className={cx(
        "work-panel",
        overlay && "edge-panel",
        maximized && "is-maximized",
        exiting && !exitAnimationReady && "is-exit-pending",
        exitAnimationReady && "is-exiting",
      )}
      style={panelStyle}
      aria-label={t("panel.title")}
      {...edgePanel}
      data-testid="work-panel"
      data-resizing={isResizing ? "true" : undefined}
      data-exiting={exiting ? "true" : undefined}
      onAnimationEnd={(event) => {
        if (
          overlay &&
          event.target === event.currentTarget &&
          event.animationName.startsWith("edge-panel-in")
        ) {
          setOverlayEntering(false);
          return;
        }
        if (!exitAnimationReady) return;
        if (event.target !== event.currentTarget) return;
        if (!event.animationName.startsWith("work-panel-out")) return;
        onExitAnimationEnd?.();
      }}
    >
      <div
        className="work-panel-resize no-drag"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("panel.resize")}
        aria-valuemin={Math.min(
          panelMinimum,
          Math.max(WORK_PANEL_COMPACT_MIN_WIDTH, layout.maxPanelWidth),
        )}
        aria-valuemax={Math.max(
          Math.min(panelMinimum, layout.maxPanelWidth),
          layout.maxPanelWidth,
        )}
        aria-valuenow={Math.round(panelDragWidth ?? renderPanelWidth)}
        aria-disabled={maximized || undefined}
        data-maximized={maximized ? "true" : undefined}
        tabIndex={0}
        onPointerDown={onPanelResizeStart}
        onPointerMove={onPanelResizeMove}
        onPointerUp={onPanelResizeCommit}
        onPointerCancel={onPanelResizeCancel}
        onLostPointerCapture={onPanelResizeCancel}
        onKeyDown={onPanelResizeKeyDown}
        onDoubleClick={onPanelResizeReset}
      />
      <div className="work-panel-main">
        <header className="work-panel-header">
          <div className="work-panel-tab-strip-wrap" ref={stripWrapRef}>
              <div
                ref={tabStripRef}
                className={cx(
                  "work-panel-tab-strip no-drag",
                  stripFade.start && "fade-start",
                  stripFade.end && "fade-end",
                )}
                role="tablist"
                aria-label={t("panel.tabsLabel")}
                onWheel={onTabStripWheel}
                onScroll={updateStripFade}
                onPointerLeave={() => setFrozenWidths(null)}
              >
                {tabs.map((tab) => {
                  const label =
                    tab.kind === "subagent" || tab.kind === "sidechat"
                      ? (subagentLabelById.get(tab.id) ?? tabLabel(tab, t, pluginViews))
                      : tabLabel(tab, t, pluginViews);
                  const selected = tab.id === activeTabId;
                  const width = tabWidth(stripLayout, selected, frozenWidths?.[tab.id]);
                  // Inactive tabs give up their title (and close button, shown on
                  // hover over the icon) before the strip has to scroll.
                  const iconOnly = !selected && width < TAB_TITLE_MIN_WIDTH;
                  const Icon =
                    tab.kind === "plugin"
                      ? pluginViewIcon(
                          pluginViews.find((view) => view.ref === tab.resource)?.icon,
                        ) ?? TAB_ICONS.plugin
                      : TAB_ICONS[tab.kind];
                  return (
                    <div
                      ref={(node) => {
                        tabWrapperRefs.current[tab.id] = node;
                      }}
                      className={cx(
                        "work-panel-tab",
                        selected && "active",
                        iconOnly && "is-icon-only",
                        draggingTabId === tab.id && "is-dragging",
                        dropIndicator?.tabId === tab.id &&
                          (dropIndicator.insertAfter ? "is-drop-after" : "is-drop-before"),
                      )}
                      style={{ width: Math.max(width, selected ? ACTIVE_TAB_MIN_WIDTH : 0) }}
                      data-work-panel-tab-id={tab.id}
                      key={tab.id}
                    >
                      <button
                        ref={(node) => {
                          tabButtonRefs.current[tab.id] = node;
                        }}
                        type="button"
                        role="tab"
                        id={`work-panel-tab-${tab.id}`}
                        aria-selected={selected}
                        aria-controls={`work-panel-surface-${tab.id}`}
                        tabIndex={selected ? 0 : -1}
                        aria-grabbed={draggingTabId === tab.id}
                        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                        aria-label={iconOnly ? label : undefined}
                        className="work-panel-tab-button"
                        title={tabTooltip(tab, label, t, workstreamTitleOf)}
                        onPointerDown={(event) => beginTabReorder(event, tab.id)}
                        onMouseDown={(event) => {
                          // Middle press would start the platform's autoscroll.
                          if (event.button === 1) event.preventDefault();
                        }}
                        onDragStart={(event) => event.preventDefault()}
                        onClick={() => activateTab(tab.id)}
                        onAuxClick={(event) => {
                          if (event.button !== 1) return;
                          event.preventDefault();
                          closeTabAndFocus(tab.id, { holdWidths: true });
                        }}
                        onKeyDown={(event) => onTabKeyDown(event, tab.id)}
                      >
                        <Icon size={14} />
                        <span className="work-panel-tab-label">{label}</span>
                      </button>
                      <button
                        type="button"
                        ref={(node) => {
                          tabCloseButtonRefs.current[tab.id] = node;
                        }}
                        className="work-panel-tab-close"
                        aria-label={t("panel.closeTab", { name: label })}
                        title={t("panel.closeTab", { name: label })}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => closeTabAndFocus(tab.id, { holdWidths: true })}
                      >
                        <IconClose size={12} />
                      </button>
                    </div>
                  );
                })}
                {/* Right after the last tab; sticky at the right edge once the strip scrolls. */}
                {projectContext ? (
                  <ProjectNewTabMenu
                    projectId={projectId}
                    t={t}
                    agentOpen={tabs.some((tab) => tab.kind === "project-agent")}
                  />
                ) : (
                  <TooltipButton
                    ref={newTabButtonRef}
                    type="button"
                    className="work-panel-new-tab work-panel-tab-plus"
                    tooltip={t("panel.new.open")}
                    ariaLabel={t("panel.new.open")}
                    onClick={openNewWorkPanelTab}
                  >
                    <IconPlus size={16} />
                  </TooltipButton>
                )}
              </div>
          </div>
          <div className="work-panel-actions no-drag">
            {onTogglePin ? (
              <TooltipButton
                type="button"
                className="work-panel-pin edge-pin-btn"
                tooltip={pinned ? t("nav.unpinWorkPanel") : t("nav.pinWorkPanel")}
                ariaLabel={pinned ? t("nav.unpinWorkPanel") : t("nav.pinWorkPanel")}
                aria-pressed={pinned}
                data-nav="pin-work-panel"
                onClick={onTogglePin}
              >
                <IconPin size={15} />
              </TooltipButton>
            ) : null}
            {overlay ? null : (
              <TooltipButton
                type="button"
                className="work-panel-maximize"
                tooltip={t(maximized ? "panel.restore" : "panel.maximize")}
                ariaLabel={t(maximized ? "panel.restore" : "panel.maximize")}
                aria-pressed={maximized}
                onClick={() => onToggleMaximize?.()}
              >
                {maximized ? (
                  <IconPanelRestore size={15} />
                ) : (
                  <IconPanelMaximize size={15} />
                )}
              </TooltipButton>
            )}
          </div>
        </header>
        <div className="work-panel-body">
          {activeTab?.kind === "subagent" && (
            <div
              key={activeTab.id}
              id={`work-panel-surface-${activeTab.id}`}
              className="work-panel-tabpane"
              role="tabpanel"
              aria-labelledby={`work-panel-tab-${activeTab.id}`}
            >
              <SubagentTranscriptTab delegationId={activeTab.resource ?? ""} />
            </div>
          )}
          {activeTab?.kind === "sidechat" && (
            <div
              key={activeTab.id}
              id={`work-panel-surface-${activeTab.id}`}
              className="work-panel-tabpane"
              role="tabpanel"
              aria-labelledby={`work-panel-tab-${activeTab.id}`}
            >
              <SideChatTab tab={activeTab} />
            </div>
          )}
          {activeTab?.kind === "project-agent" && activeTab.resource && (
            <div
              key={activeTab.id}
              id={`work-panel-surface-${activeTab.id}`}
              className="work-panel-tabpane"
              role="tabpanel"
              aria-labelledby={`work-panel-tab-${activeTab.id}`}
            >
              <ProjectAgentTab projectId={activeTab.resource} />
            </div>
          )}
          {activeTab?.kind === "project-side" && activeTab.resource && (
            <div
              key={activeTab.id}
              id={`work-panel-surface-${activeTab.id}`}
              className="work-panel-tabpane"
              role="tabpanel"
              aria-labelledby={`work-panel-tab-${activeTab.id}`}
            >
              <ProjectSideTab sessionId={activeTab.resource} label={activeTab.label} />
            </div>
          )}
          {activeTab?.kind === "review" && (
            <div
              id={`work-panel-surface-${activeTab.id}`}
              className="work-panel-tabpane"
              role="tabpanel"
              aria-labelledby={`work-panel-tab-${activeTab.id}`}
            >
              <ReviewTab />
            </div>
          )}
          {activeTab?.kind === "file" && (
            <div
              key={activeTab.id}
              id={`work-panel-surface-${activeTab.id}`}
              className="work-panel-tabpane"
              role="tabpanel"
              aria-labelledby={`work-panel-tab-${activeTab.id}`}
            >
              <FilesTab />
            </div>
          )}
          {activeTab?.kind === "plugin" &&
            (() => {
              const ref = parsePluginViewRef(activeTab.resource);
              if (!ref) return null;
              return (
                <div
                  key={activeTab.id}
                  id={`work-panel-surface-${activeTab.id}`}
                  className="work-panel-tabpane"
                  role="tabpanel"
                  aria-labelledby={`work-panel-tab-${activeTab.id}`}
                >
                  <PluginViewTab
                    pluginId={ref.pluginId}
                    viewId={ref.viewId}
                    title={activeLabel}
                    icon={activePluginView?.icon}
                    sessionId={activeSessionId ?? undefined}
                    location={activeTab.location}
                    tabId={activeTab.id}
                    // Native WebContentsViews composite above renderer content.
                    blocked={exiting || panelBlocked || blockingOverlayActive}
                  />
                </div>
              );
            })()}
          {!activeTab && projectContext && (
            <div className="work-panel-tabpane" data-testid="work-panel-empty">
              <ProjectPanelEmpty contextKey={contextKey} />
            </div>
          )}
          {(!activeTab || activeTab.kind === "new") && !(projectContext && !activeTab) && (
            <div
              className="work-panel-tabpane"
              data-testid="work-panel-empty"
              id={activeTab ? `work-panel-surface-${activeTab.id}` : undefined}
              role={activeTab ? "tabpanel" : undefined}
              aria-labelledby={
                activeTab ? `work-panel-tab-${activeTab.id}` : undefined
              }
            >
              <div className="work-panel-launcher">
                <div className="work-panel-launcher-title">{t("panel.new.title")}</div>
                <div
                  className="work-panel-launcher-list"
                  role="group"
                  aria-label={t("panel.toolsAndPanels")}
                >
                  {tools.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="work-panel-launcher-row"
                      data-work-panel-launcher-item={item.id}
                      onClick={() =>
                        selectTool(
                          item,
                          activeTab?.kind === "new" ? activeTab.id : undefined,
                        )
                      }
                    >
                      <span className="work-panel-launcher-icon" aria-hidden>
                        <ToolIcon item={item} />
                      </span>
                      <span className="work-panel-launcher-label">{item.label}</span>
                      {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
