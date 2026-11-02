import { useEffect, useRef } from "react";
import { useViewportWidth } from "../../hooks/use-viewport-width";
import type { AppSettings } from "@pi-desktop/shared";
import { type UseEdgeRevealResult, useEdgeReveal } from "../../hooks/use-edge-reveal";
import { isPanelPinned } from "../../lib/panel-pin";
import {
  hasWorkPanelNavigationReveal,
  subscribeWorkPanelNavigationReveal,
  takeWorkPanelNavigationReveal,
} from "../../lib/work-panel-navigation-reveal";
import { useAppStore } from "../../stores/app-store";

/**
 * An open request counts as the user's own only when it follows an input
 * gesture this closely. Agent and tool results (a plan artifact, a browser
 * preview) arrive on their own schedule and must never reveal the panel
 * (ADR 0033).
 */
export const USER_GESTURE_WINDOW_MS = 400;

export type SidePanelReveal = {
  sidebarPinned: boolean;
  workPanelPinned: boolean;
  /** Left overlay for the main sidebar while it is not pinned. */
  leftReveal: UseEdgeRevealResult;
  /** Right overlay for the work panel while it is not pinned. */
  rightReveal: UseEdgeRevealResult;
};

/**
 * Pin state and edge-reveal wiring for the two shell side panels
 * (docs/adr/auto-hide-side-panels.md). A pinned panel docks exactly as before;
 * an unpinned one takes no layout width and is revealed over the content.
 *
 * The work panel keeps its availability rule: no presented context (an active
 * session, or the project on the project page), or a page that hides the
 * panel, means no hot zone and no reveal.
 */
export function useSidePanelReveal({
  ready,
  page,
  contextKey,
  workPanelOpen,
  settings,
}: {
  ready: boolean;
  page: string;
  /** The presented work-panel context: `project:<id>` on the project page, else the session id. */
  contextKey: string | undefined;
  workPanelOpen: boolean;
  settings: AppSettings | null | undefined;
}): SidePanelReveal {
  // "Auto" panels dock on wide windows and auto-hide on narrow ones.
  const viewportWidth = useViewportWidth();
  const sidebarPinned = isPanelPinned(settings, "sidebarPinned", viewportWidth);
  const workPanelPinned = isPanelPinned(settings, "workPanelPinned", viewportWidth);
  const pageHidesWorkPanel =
    page === "settings" || page === "plugins" || page === "scheduled";

  const leftReveal = useEdgeReveal({
    side: "left",
    enabled: ready && !sidebarPinned && page !== "settings",
  });
  const rightReveal = useEdgeReveal({
    side: "right",
    enabled:
      ready && !workPanelPinned && !pageHidesWorkPanel && Boolean(contextKey),
  });

  const lastGestureAt = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    const note = () => {
      lastGestureAt.current = performance.now();
    };
    window.addEventListener("pointerdown", note, true);
    window.addEventListener("keydown", note, true);
    return () => {
      window.removeEventListener("pointerdown", note, true);
      window.removeEventListener("keydown", note, true);
    };
  }, []);

  // The store's per-session `open` flag belongs to the docked panel. While the
  // panel is unpinned that flag is a request, consumed here: a gesture-driven
  // open (a file or link opened into the panel) reveals the overlay, anything
  // else (an agent event, a session switch, unpinning) is dropped quietly.
  const previous = useRef({ pinned: workPanelPinned, sessionId: contextKey });
  const openPanel = rightReveal.openPanel;
  useEffect(() => {
    const was = previous.current;
    previous.current = { pinned: workPanelPinned, sessionId: contextKey };
    if (workPanelPinned || !workPanelOpen) return;
    const gesture =
      performance.now() - lastGestureAt.current <= USER_GESTURE_WINDOW_MS;
    const store = useAppStore.getState();
    const reveal =
      gesture &&
      !was.pinned &&
      was.sessionId === contextKey &&
      ready &&
      !pageHidesWorkPanel &&
      Boolean(contextKey);
    store.collapseWorkPanel();
    if (reveal) openPanel();
  }, [
    contextKey,
    openPanel,
    pageHidesWorkPanel,
    ready,
    workPanelOpen,
    workPanelPinned,
  ]);

  // Navigation reveal (ADR 0033 amendment): entering a project, or a chat that
  // belongs to one, presents the project Agent. A docked panel is already open
  // through the store; an auto-hidden one is revealed once, on request of the
  // default-open hook only. Focus stays where the navigation left it, so a
  // reveal never takes the composer away from the user.
  const rightEnabled = rightReveal.enabled;
  useEffect(() => {
    const reveal = () => {
      if (!hasWorkPanelNavigationReveal() || !ready) return;
      if (workPanelPinned) {
        takeWorkPanelNavigationReveal(contextKey);
        return;
      }
      if (!rightEnabled) return;
      if (!takeWorkPanelNavigationReveal(contextKey)) return;
      const focused = document.activeElement;
      openPanel();
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => {
          const panel = document.querySelector('[data-edge-reveal="right"]');
          if (
            focused instanceof HTMLElement &&
            focused.isConnected &&
            panel &&
            panel.contains(document.activeElement) &&
            !panel.contains(focused)
          ) {
            focused.focus({ preventScroll: true });
          }
        }),
      );
    };
    reveal();
    return subscribeWorkPanelNavigationReveal(reveal);
  }, [contextKey, openPanel, ready, rightEnabled, workPanelPinned]);

  return { sidebarPinned, workPanelPinned, leftReveal, rightReveal };
}
