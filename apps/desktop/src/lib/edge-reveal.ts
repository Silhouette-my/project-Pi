/**
 * Edge-reveal controller: the framework-free state machine behind
 * `hooks/use-edge-reveal.ts`. A side panel that is not docked sits off-screen;
 * the pointer reaching a window edge (after a short dwell) or a command slides
 * it in, and it retracts a short delay after the pointer leaves, unless
 * something is holding it open. See docs/adr/auto-hide-side-panels.md.
 *
 * Everything here is pure or timer-driven so the rules can be tested without a
 * DOM: the React hook only translates real pointer, keyboard and focus events
 * into the calls below.
 */

export type EdgeSide = "left" | "right";

/** How the panel became visible. A command-opened panel is sticky. */
export type EdgeRevealSource = "pointer" | "command";

export const EDGE_ZONE_WIDTH = 6;
export const EDGE_DWELL_MS = 80;
export const EDGE_HIDE_DELAY_MS = 300;
/** Re-check cadence while a hold keeps an overdue hide pending. */
export const EDGE_HOLD_RECHECK_MS = 100;
/** Time the panel stays mounted to play its slide-out motion. */
export const EDGE_EXIT_MS = 180;

export type EdgeRevealState = {
  open: boolean;
  source: EdgeRevealSource | null;
};

export type EdgePointer = {
  /** The pointer is inside the invisible edge hot zone. */
  inZone: boolean;
  /** The pointer is inside the revealed panel (or a native view it hosts). */
  inPanel: boolean;
  /** A button is down: a drag or selection, never a deliberate reveal. */
  pressed?: boolean;
};

export type EdgeRevealTimers = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type EdgeRevealControllerOptions = {
  dwellMs?: number;
  hideDelayMs?: number;
  holdRecheckMs?: number;
  /** True while something forbids hiding (menu, drag, text entry, ...). */
  isHeld?: () => boolean;
  /** False while a reveal would be wrong (a modal dialog is open, ...). */
  canReveal?: () => boolean;
  onChange?: (state: EdgeRevealState) => void;
  timers?: EdgeRevealTimers;
};

export type EdgeRevealController = {
  getState: () => EdgeRevealState;
  /** Disabling hides at once and ignores the pointer until re-enabled. */
  setEnabled: (enabled: boolean) => void;
  /** Feed one pointer sample (from a window-level pointermove). */
  pointerMoved: (pointer: EdgePointer) => void;
  /** Command reveal (shortcut, toggle button): stays until dismissed. */
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** Escape: closes an open panel. Returns whether it handled the key. */
  escape: () => boolean;
  dispose: () => void;
};

const defaultTimers: EdgeRevealTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createEdgeRevealController(
  options: EdgeRevealControllerOptions = {},
): EdgeRevealController {
  const dwellMs = options.dwellMs ?? EDGE_DWELL_MS;
  const hideDelayMs = options.hideDelayMs ?? EDGE_HIDE_DELAY_MS;
  const holdRecheckMs = options.holdRecheckMs ?? EDGE_HOLD_RECHECK_MS;
  const timers = options.timers ?? defaultTimers;
  const isHeld = options.isHeld ?? (() => false);
  const canReveal = options.canReveal ?? (() => true);

  let enabled = false;
  let state: EdgeRevealState = { open: false, source: null };
  // A command-opened panel only starts retracting once the pointer has been
  // inside it and left again; a pointer-opened one retracts on any exit.
  let pointerEntered = false;
  let dwellTimer: unknown = null;
  let hideTimer: unknown = null;

  const emit = (next: EdgeRevealState) => {
    if (next.open === state.open && next.source === state.source) return;
    state = next;
    options.onChange?.(state);
  };
  const cancelDwell = () => {
    if (dwellTimer === null) return;
    timers.clearTimeout(dwellTimer);
    dwellTimer = null;
  };
  const cancelHide = () => {
    if (hideTimer === null) return;
    timers.clearTimeout(hideTimer);
    hideTimer = null;
  };
  const closeNow = () => {
    cancelDwell();
    cancelHide();
    pointerEntered = false;
    emit({ open: false, source: null });
  };
  const fireHide = () => {
    hideTimer = null;
    if (!state.open) return;
    if (isHeld()) {
      hideTimer = timers.setTimeout(fireHide, holdRecheckMs);
      return;
    }
    closeNow();
  };
  const scheduleHide = () => {
    if (hideTimer !== null) return;
    hideTimer = timers.setTimeout(fireHide, hideDelayMs);
  };
  const openAs = (source: EdgeRevealSource) => {
    cancelDwell();
    cancelHide();
    if (state.open) {
      // A command upgrade makes an already hover-revealed panel sticky.
      if (source === "command") emit({ open: true, source });
      return;
    }
    pointerEntered = false;
    emit({ open: true, source });
  };

  return {
    getState: () => state,
    setEnabled(next) {
      if (enabled === next) return;
      enabled = next;
      if (!enabled) closeNow();
    },
    pointerMoved({ inZone, inPanel, pressed = false }) {
      if (!enabled) return;
      if (!state.open) {
        if (inZone && !pressed && canReveal()) {
          if (dwellTimer === null) {
            dwellTimer = timers.setTimeout(() => {
              dwellTimer = null;
              if (enabled && !state.open && canReveal()) openAs("pointer");
            }, dwellMs);
          }
        } else {
          cancelDwell();
        }
        return;
      }
      if (inPanel) pointerEntered = true;
      if (inPanel || inZone) {
        cancelHide();
        return;
      }
      if (state.source === "pointer" || pointerEntered) scheduleHide();
    },
    open() {
      if (!enabled) return;
      openAs("command");
    },
    close: closeNow,
    toggle() {
      if (state.open) closeNow();
      else if (enabled) openAs("command");
    },
    escape() {
      if (!state.open) return false;
      closeNow();
      return true;
    },
    dispose() {
      enabled = false;
      closeNow();
    },
  };
}

// ---------------------------------------------------------------------------
// Hold rules

/**
 * Root attributes that mark a drag or resize in progress. Components that start
 * such a gesture already publish one of these; the list is the contract.
 */
export const EDGE_DRAG_ATTRIBUTES = [
  "data-sidebar-resizing",
  "data-work-panel-resizing",
  "data-project-reordering",
  "data-work-panel-tab-reordering",
] as const;

/** What the hold rules need to know about the page, injectable for tests. */
export type EdgeRevealEnvironment = {
  /** Whether the document root carries a given attribute. */
  rootHasAttribute: (name: string) => boolean;
  /** An HTML5 drag started and has not ended. */
  dragging: () => boolean;
  /** A pointer button went down inside the panel and is still down. */
  pressedInside: () => boolean;
  /** Focus inside the panel, or null when focus is elsewhere. */
  focusInside: () => {
    textEntry: boolean;
    /** Focus is visible, i.e. it was moved there by the keyboard. */
    keyboardFocus: boolean;
  } | null;
  /** A menu, popover, context menu or dialog is open. */
  popupOpen: () => boolean;
};

/**
 * Why a revealed panel must not retract right now, or null when it may.
 * Order is irrelevant; the first match is reported for debugging.
 */
export function edgeRevealHoldReason(
  environment: EdgeRevealEnvironment,
): "drag" | "pressed" | "popup" | "text-entry" | "keyboard-focus" | null {
  if (
    environment.dragging() ||
    EDGE_DRAG_ATTRIBUTES.some((name) => environment.rootHasAttribute(name))
  ) {
    return "drag";
  }
  if (environment.pressedInside()) return "pressed";
  if (environment.popupOpen()) return "popup";
  const focus = environment.focusInside();
  if (focus?.textEntry) return "text-entry";
  if (focus?.keyboardFocus) return "keyboard-focus";
  return null;
}

/**
 * Hot-zone geometry for a pointer sample. The zone is `zoneWidth` wide on the
 * given edge and starts below `topInset`, so it never covers the macOS traffic
 * lights or the Windows window controls.
 */
export function pointInEdgeZone({
  side,
  clientX,
  clientY,
  viewportWidth,
  zoneWidth = EDGE_ZONE_WIDTH,
  topInset,
}: {
  side: EdgeSide;
  clientX: number;
  clientY: number;
  viewportWidth: number;
  zoneWidth?: number;
  topInset: number;
}): boolean {
  if (clientY < topInset) return false;
  return side === "left"
    ? clientX >= 0 && clientX <= zoneWidth
    : clientX <= viewportWidth && clientX >= viewportWidth - zoneWidth;
}

export function pointInRect(
  rect: { left: number; right: number; top: number; bottom: number },
  clientX: number,
  clientY: number,
  slop = 1,
): boolean {
  return (
    clientX >= rect.left - slop &&
    clientX <= rect.right + slop &&
    clientY >= rect.top - slop &&
    clientY <= rect.bottom + slop
  );
}
