import { useEffect, type RefObject } from "react";

/**
 * Expanded top-level folders and projects (the shaded blocks) are height-limited
 * and scroll inside; their header rows stay outside the scroll area. CSS owns
 * the limit (navigation-styles.css); this module owns the behaviour CSS cannot
 * express: edge fades on the sides that hide content, scrolling the active row
 * into view, and auto-scroll while dragging near an edge.
 */
export const BLOCK_SCROLL_SELECTOR =
  ".workflow-tree-node.is-block > .workflow-tree-children, .workflow-tree-node.is-block > .workflow-tree-row .sidebar-project-body";
const EDGE = 28;
const MAX_STEP = 14;

export type FadeSides = "none" | "top" | "bottom" | "both";
export function fadeSides(scrollTop: number, clientHeight: number, scrollHeight: number): FadeSides {
  const top = scrollTop > 1;
  const bottom = scrollTop + clientHeight < scrollHeight - 1;
  return top && bottom ? "both" : top ? "top" : bottom ? "bottom" : "none";
}

/** Scroll step (px, signed) for a pointer `y` near the edges of `rect`; 0 away from them. */
export function edgeScrollStep(y: number, top: number, bottom: number): number {
  if (y < top + EDGE) return -Math.ceil((MAX_STEP * Math.min(EDGE, top + EDGE - y)) / EDGE);
  if (y > bottom - EDGE) return Math.ceil((MAX_STEP * Math.min(EDGE, y - (bottom - EDGE))) / EDGE);
  return 0;
}

/** Minimal scrollTop that shows `row` fully inside `block`, without touching outer scrollers. */
export function scrollRowIntoBlock(block: HTMLElement, row: Element) {
  const box = block.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  if (rect.top < box.top) block.scrollTop -= box.top - rect.top;
  else if (rect.bottom > box.bottom) block.scrollTop += rect.bottom - box.bottom;
}

function updateFade(block: HTMLElement) {
  const sides = fadeSides(block.scrollTop, block.clientHeight, block.scrollHeight);
  if (block.dataset.fade !== sides) block.dataset.fade = sides;
}

const ACTIVE_ROW = ".thread-item.active, [aria-current='page']";

export function useBlockScroll(rootRef: RefObject<HTMLElement | null>, enabled: boolean) {
  // Runs after every render: new blocks (just expanded) are observed, and the
  // active row is revealed only when it changed, so scrolling by hand is never undone.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) return;
    const blocks = [...root.querySelectorAll<HTMLElement>(BLOCK_SCROLL_SELECTOR)];
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver((entries) => {
            for (const entry of entries) updateFade(entry.target as HTMLElement);
          });
    for (const block of blocks) {
      const active = block.querySelector(ACTIVE_ROW);
      if (active && revealed.get(block) !== active) scrollRowIntoBlock(block, active);
      if (active) revealed.set(block, active);
      else revealed.delete(block);
      updateFade(block);
      observer?.observe(block);
      block.addEventListener("scroll", onScroll, { passive: true });
    }
    return () => {
      observer?.disconnect();
      for (const block of blocks) block.removeEventListener("scroll", onScroll);
    };
  });
  // Keyboard focus moving to a hidden row reveals it inside its block.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) return;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Element | null;
      const block = target?.closest<HTMLElement>(BLOCK_SCROLL_SELECTOR);
      if (block && target && block !== target) scrollRowIntoBlock(block, target);
    };
    root.addEventListener("focusin", onFocusIn);
    return () => root.removeEventListener("focusin", onFocusIn);
  }, [rootRef, enabled]);
}

const revealed = new WeakMap<HTMLElement, Element>();
function onScroll(event: Event) {
  updateFade(event.currentTarget as HTMLElement);
}

/** Auto-scrolls the block under a dragged pointer when it is near the block's top or bottom edge. */
export function autoScrollBlock(event: { target: EventTarget | null; clientY: number }) {
  const block = (event.target as Element | null)?.closest?.<HTMLElement>(BLOCK_SCROLL_SELECTOR);
  if (!block || block.scrollHeight <= block.clientHeight) return;
  const rect = block.getBoundingClientRect();
  const step = edgeScrollStep(event.clientY, rect.top, rect.bottom);
  if (step) block.scrollTop += step;
}
