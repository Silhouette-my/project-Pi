import {
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createEdgeRevealController,
  EDGE_DWELL_MS,
  EDGE_EXIT_MS,
  EDGE_HIDE_DELAY_MS,
  EDGE_ZONE_WIDTH,
  type EdgeRevealController,
  type EdgeRevealEnvironment,
  type EdgeRevealSource,
  type EdgeSide,
  edgeRevealHoldReason,
  pointInEdgeZone,
  pointInRect,
} from "../lib/edge-reveal.ts";

/** Default height of the titlebar row the hot zone must stay below. */
const DEFAULT_TOP_INSET = 46;

const TEXT_ENTRY_SELECTOR =
  'input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="range"]), textarea, select, [contenteditable=""], [contenteditable="true"]';
const POPUP_SELECTOR =
  '[role="menu"], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-edge-reveal-hold]';

export type UseEdgeRevealOptions = {
  side: EdgeSide;
  /**
   * False removes the hot zone and hides the panel at once: use it while the
   * panel is docked (pinned) or has no context to show.
   */
  enabled: boolean;
  /** Dwell before the pointer at the edge reveals the panel. */
  dwellMs?: number;
  /** Delay between the pointer leaving and the panel retracting. */
  hideDelayMs?: number;
  /** Time the panel stays mounted for its slide-out. */
  exitMs?: number;
  /** Hot-zone width in CSS pixels. */
  zoneWidth?: number;
  /** Pixels at the top the zone must not cover (the titlebar row). */
  topInset?: number;
  /** Extra hold rule, for state only the owner knows about. */
  holdOpen?: () => boolean;
  /** Called whenever the panel opens or closes, with how it opened. */
  onOpenChange?: (open: boolean, source: EdgeRevealSource | null) => void;
};

export type EdgeRevealPhase = "closed" | "open" | "closing";

export type UseEdgeRevealResult = {
  /** The hot zone is armed (`enabled` as last applied). */
  enabled: boolean;
  /** The panel is logically revealed. */
  open: boolean;
  /** Render the panel while true: open, or still playing its exit. */
  mounted: boolean;
  phase: EdgeRevealPhase;
  source: EdgeRevealSource | null;
  /** Reveal until dismissed (shortcut, toggle button). */
  openPanel: () => void;
  closePanel: () => void;
  toggle: () => void;
  /** Spread on the overlay element. */
  panelProps: {
    ref: RefObject<HTMLElement | null>;
    tabIndex: -1;
    /** Set while closed, for panels that stay mounted (the sidebar). */
    inert: true | undefined;
    "data-edge-reveal": EdgeSide;
    "data-edge-state": EdgeRevealPhase;
  };
  /** Spread on an empty element; present only while the zone is active. */
  zoneProps: {
    "data-edge-zone": EdgeSide;
    "aria-hidden": true;
  };
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Edge-reveal behavior for a side panel that is not docked: an invisible hot
 * zone at the window edge (pointer only) slides the panel in after a short
 * dwell, and it retracts a delay after the pointer leaves, unless a menu or
 * dialog is open, a drag is running, text is being typed, or the keyboard
 * moved focus inside. Escape closes it; `toggle` serves the shortcuts.
 *
 * The hot zone is not hit-tested: it is measured from window-level pointer
 * samples, so it never steals clicks, wheel events or the transcript
 * scrollbar from the content beneath. `zoneProps` marks an inert element for
 * styling and tests.
 *
 * The same hook serves any future panel (the project Agent dock): pass its
 * own `side`, `enabled` and pin state. See docs/adr/auto-hide-side-panels.md.
 */
export function useEdgeReveal(options: UseEdgeRevealOptions): UseEdgeRevealResult {
  const {
    side,
    enabled,
    dwellMs = EDGE_DWELL_MS,
    hideDelayMs = EDGE_HIDE_DELAY_MS,
    zoneWidth = EDGE_ZONE_WIDTH,
    topInset = DEFAULT_TOP_INSET,
  } = options;
  const panelRef = useRef<HTMLElement | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const exitTimerRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const pressedInsideRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<EdgeRevealSource | null>(null);
  const [exiting, setExiting] = useState(false);

  const controller = useMemo<EdgeRevealController>(() => {
    const environment: EdgeRevealEnvironment = {
      rootHasAttribute: (name) => document.documentElement.hasAttribute(name),
      dragging: () => draggingRef.current,
      pressedInside: () => pressedInsideRef.current,
      focusInside: () => {
        const panel = panelRef.current;
        const active = document.activeElement;
        if (!panel || !active || !panel.contains(active)) return null;
        return {
          textEntry: active.matches(TEXT_ENTRY_SELECTOR),
          keyboardFocus: active.matches(":focus-visible"),
        };
      },
      popupOpen: () => edgePopupOpen(),
    };
    return createEdgeRevealController({
      dwellMs,
      hideDelayMs,
      isHeld: () =>
        optionsRef.current.holdOpen?.() === true ||
        edgeRevealHoldReason(environment) !== null,
      canReveal: () => !edgePopupOpen(),
      onChange: (next) => {
        if (next.open && document.activeElement instanceof HTMLElement) {
          restoreFocusRef.current = document.activeElement;
        }
        if (exitTimerRef.current !== null) {
          window.clearTimeout(exitTimerRef.current);
          exitTimerRef.current = null;
        }
        if (next.open) {
          setExiting(false);
        } else {
          // Stay mounted for the slide-out; reduced motion skips it.
          const duration = prefersReducedMotion()
            ? 0
            : (optionsRef.current.exitMs ?? EDGE_EXIT_MS);
          setExiting(duration > 0);
          if (duration > 0) {
            exitTimerRef.current = window.setTimeout(() => {
              exitTimerRef.current = null;
              setExiting(false);
            }, duration);
          }
        }
        setOpen(next.open);
        setSource(next.source);
        optionsRef.current.onOpenChange?.(next.open, next.source);
      },
    });
  }, [dwellMs, hideDelayMs]);

  useEffect(() => {
    controller.setEnabled(enabled);
    if (!enabled) {
      // A panel that docks (or loses its context) leaves without a slide-out:
      // the docked layout takes its place in the same frame.
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      setExiting(false);
    }
  }, [controller, enabled]);

  // A command reveal moves focus onto the panel so Tab continues inside it and
  // Escape can hand focus back to where it came from.
  useEffect(() => {
    if (!open || source !== "command") return;
    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, source]);

  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(
    () => () => {
      if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!enabled) return;
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const panel = panelRef.current;
      const inPanel = panel
        ? pointInRect(panel.getBoundingClientRect(), event.clientX, event.clientY)
        : false;
      controller.pointerMoved({
        inZone: pointInEdgeZone({
          side,
          clientX: event.clientX,
          clientY: event.clientY,
          viewportWidth: window.innerWidth,
          zoneWidth,
          topInset,
        }),
        inPanel,
        pressed: event.buttons !== 0,
      });
    };
    const onPointerDown = (event: PointerEvent) => {
      const panel = panelRef.current;
      pressedInsideRef.current =
        panel !== null && event.target instanceof Node && panel.contains(event.target);
    };
    const onPointerEnd = () => {
      pressedInsideRef.current = false;
    };
    const onDragStart = () => {
      draggingRef.current = true;
    };
    const onDragEnd = () => {
      draggingRef.current = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!controller.getState().open || edgePopupOpen()) return;
      if (controller.escape()) {
        returnFocus(panelRef.current, restoreFocusRef.current);
      }
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerEnd, true);
    window.addEventListener("pointercancel", onPointerEnd, true);
    window.addEventListener("dragstart", onDragStart, true);
    window.addEventListener("dragend", onDragEnd, true);
    window.addEventListener("drop", onDragEnd, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerEnd, true);
      window.removeEventListener("pointercancel", onPointerEnd, true);
      window.removeEventListener("dragstart", onDragStart, true);
      window.removeEventListener("dragend", onDragEnd, true);
      window.removeEventListener("drop", onDragEnd, true);
      window.removeEventListener("keydown", onKeyDown);
      pressedInsideRef.current = false;
      draggingRef.current = false;
    };
  }, [controller, enabled, side, topInset, zoneWidth]);

  const phase: EdgeRevealPhase = open ? "open" : exiting ? "closing" : "closed";
  return {
    enabled,
    open,
    mounted: open || exiting,
    phase,
    source,
    openPanel: controller.open,
    closePanel: controller.close,
    toggle: controller.toggle,
    panelProps: {
      ref: panelRef,
      tabIndex: -1,
      inert: phase === "closed" ? true : undefined,
      "data-edge-reveal": side,
      "data-edge-state": phase,
    },
    zoneProps: { "data-edge-zone": side, "aria-hidden": true },
  };
}

/** A menu, popover, context menu or dialog is open anywhere in the page. */
function edgePopupOpen(): boolean {
  for (const element of document.querySelectorAll(POPUP_SELECTOR)) {
    // Inline surfaces inside the conversation (a plan approval bar, for one)
    // are content, not something opened from a panel.
    if (element.closest(".main-pane, [hidden], [inert]")) continue;
    if (element.getClientRects().length > 0) return true;
  }
  return false;
}

function returnFocus(panel: HTMLElement | null, target: HTMLElement | null) {
  const active = document.activeElement;
  const focusInPanel = panel !== null && active !== null && panel.contains(active);
  if (!focusInPanel && active !== document.body) return;
  if (target?.isConnected && !panel?.contains(target)) {
    target.focus({ preventScroll: true });
    return;
  }
  if (active instanceof HTMLElement) active.blur();
}
