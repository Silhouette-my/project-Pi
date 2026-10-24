/**
 * Pure rules of the work panel's Chrome-like tab strip: how wide tabs are, when
 * inactive tabs fall back to their icon, which tab a shortcut moves to, and how
 * widths hold still while the pointer closes several tabs in a row.
 *
 * Nothing here touches the DOM or the store, so each rule is directly testable.
 */

/** A tab never grows past this. */
export const TAB_MAX_WIDTH = 170;
/** The active tab keeps its icon, title and close button at no less than this. */
export const ACTIVE_TAB_MIN_WIDTH = 104;
/** An inactive tab shows its title only at or above this width. */
export const TAB_TITLE_MIN_WIDTH = 72;
/** The smallest an inactive, icon-only tab gets before the strip scrolls. */
export const TAB_ICON_ONLY_WIDTH = 36;

export type TabStripLayout = {
  activeWidth: number;
  inactiveWidth: number;
  /** Inactive tabs show their icon only. */
  inactiveIconOnly: boolean;
  /** Even the narrowest tabs do not fit: the strip scrolls horizontally. */
  overflow: boolean;
};

/**
 * Widths for `count` tabs in `available` pixels (the strip minus the sticky
 * "+"). Tabs shrink evenly from the maximum; the active tab is protected down
 * to its minimum, so the inactive ones give way first and turn into icons
 * (never narrower than 36px) before the strip overflows.
 */
export function tabStripLayout(available: number, count: number): TabStripLayout {
  if (count <= 0) {
    return { activeWidth: TAB_MAX_WIDTH, inactiveWidth: TAB_MAX_WIDTH, inactiveIconOnly: false, overflow: false };
  }
  const room = Math.max(0, Math.floor(available));
  if (count === 1) {
    return {
      activeWidth: Math.min(TAB_MAX_WIDTH, Math.max(ACTIVE_TAB_MIN_WIDTH, room)),
      inactiveWidth: TAB_MAX_WIDTH,
      inactiveIconOnly: false,
      overflow: room < ACTIVE_TAB_MIN_WIDTH,
    };
  }
  const even = Math.min(TAB_MAX_WIDTH, Math.floor(room / count));
  if (even >= ACTIVE_TAB_MIN_WIDTH) {
    return { activeWidth: even, inactiveWidth: even, inactiveIconOnly: false, overflow: false };
  }
  const activeWidth = ACTIVE_TAB_MIN_WIDTH;
  const inactiveRoom = Math.floor((room - activeWidth) / (count - 1));
  if (inactiveRoom < TAB_ICON_ONLY_WIDTH) {
    return {
      activeWidth,
      inactiveWidth: TAB_ICON_ONLY_WIDTH,
      inactiveIconOnly: true,
      overflow: true,
    };
  }
  return {
    activeWidth,
    inactiveWidth: inactiveRoom,
    inactiveIconOnly: inactiveRoom < TAB_TITLE_MIN_WIDTH,
    overflow: false,
  };
}

/** Width of one tab under a layout, honoring widths frozen after a close. */
export function tabWidth(
  layout: TabStripLayout,
  active: boolean,
  frozen?: number,
): number {
  if (frozen !== undefined) return frozen;
  return active ? layout.activeWidth : layout.inactiveWidth;
}

/**
 * Widths to hold after a tab's close button was pressed: the rendered widths of
 * the tabs that stay, so the next close button lands under the pointer. Released
 * when the pointer leaves the strip.
 */
export function freezeTabWidths(
  rendered: Readonly<Record<string, number>>,
  closedTabId: string,
): Record<string, number> {
  const frozen: Record<string, number> = {};
  for (const [id, width] of Object.entries(rendered)) {
    if (id !== closedTabId && Number.isFinite(width) && width > 0) frozen[id] = Math.round(width);
  }
  return frozen;
}

/** The tab a Ctrl+Tab / Ctrl+Shift+Tab step lands on, wrapping around. */
export function adjacentTabId(
  tabIds: readonly string[],
  activeId: string | null,
  step: 1 | -1,
): string | null {
  if (tabIds.length === 0) return null;
  const index = activeId ? tabIds.indexOf(activeId) : -1;
  if (index < 0) return tabIds[step === 1 ? 0 : tabIds.length - 1];
  return tabIds[(index + step + tabIds.length) % tabIds.length];
}

export type WorkPanelShortcut = "close-tab" | "next-tab" | "previous-tab";

type KeyEventLike = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/**
 * The panel-scoped tab shortcut a key event asks for, if any: Cmd+W (Ctrl+W
 * off macOS) closes the active tab, Ctrl+Tab and Ctrl+Shift+Tab cycle. The
 * caller applies them only while focus is inside the panel, so no global
 * binding is spent.
 */
export function workPanelShortcut(
  event: KeyEventLike,
  platform: string,
): WorkPanelShortcut | null {
  if (event.altKey) return null;
  const mac = platform === "darwin";
  if (event.key === "Tab" && event.ctrlKey && !event.metaKey) {
    return event.shiftKey ? "previous-tab" : "next-tab";
  }
  const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (primary && !event.shiftKey && event.key.toLowerCase() === "w") return "close-tab";
  return null;
}
