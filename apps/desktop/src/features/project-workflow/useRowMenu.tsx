import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { SidebarMenuPanel, sidebarMenuKeyDown } from "../../components/SidebarMenuPanel";
import type { SidebarMenuPanelContent } from "../../lib/sidebar-menu";
import {
  placeSidebarFloatingMenuTop,
  SIDEBAR_FLOATING_MENU_MAX_HEIGHT,
  SIDEBAR_MENU_VIEWPORT_PADDING,
} from "../../lib/sidebar-floating-menu";
import { portalToBody } from "../../lib/portal-visibility";

type Placement = { id: string; top: number; left: number; anchorTop: number; anchorBottom: number };

/**
 * One anchored row menu for a NavigationTree: the same SidebarMenuPanel and
 * placement rules Sidebar uses for session and project rows, owned locally so
 * folder rows do not need Sidebar state. Content is a function of the open id
 * so armed or busy rows re-render in place.
 */
export function useRowMenu(build: (id: string) => SidebarMenuPanelContent | null) {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const firstItemRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback((restoreFocus = true) => {
    const trigger = triggerRef.current;
    setPlacement(null);
    if (restoreFocus && trigger?.isConnected) requestAnimationFrame(() => trigger.focus());
  }, []);

  const open = useCallback(
    (id: string, anchor: HTMLElement | null, point?: { x: number; y: number }) => {
      triggerRef.current = anchor;
      const rect = anchor?.getBoundingClientRect();
      const top = point?.y ?? rect?.top ?? 0;
      const bottom = point?.y ?? rect?.bottom ?? 0;
      const left = point ? point.x + 4 : (rect?.right ?? 0) + 4;
      setPlacement({
        id,
        top: placeSidebarFloatingMenuTop(
          { top, bottom },
          SIDEBAR_FLOATING_MENU_MAX_HEIGHT,
          window.innerHeight,
        ),
        left: Math.max(SIDEBAR_MENU_VIEWPORT_PADDING, left),
        anchorTop: top,
        anchorBottom: bottom,
      });
    },
    [],
  );

  const openId = placement?.id;
  useEffect(() => {
    if (!openId) return;
    const onPointer = (event: PointerEvent) => {
      if (event.button === 2) return;
      if ((event.target as Element | null)?.closest?.(".sidebar-row-menu")) return;
      close(false);
    };
    const onResize = () => close(false);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("resize", onResize);
    requestAnimationFrame(() => firstItemRef.current?.focus());
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("resize", onResize);
    };
  }, [openId, close]);

  const anchorTop = placement?.anchorTop;
  const anchorBottom = placement?.anchorBottom;
  useLayoutEffect(() => {
    if (anchorTop === undefined || anchorBottom === undefined) return;
    const menu = menuRef.current;
    if (!menu) return;
    const top = placeSidebarFloatingMenuTop(
      { top: anchorTop, bottom: anchorBottom },
      menu.getBoundingClientRect().height,
      window.innerHeight,
    );
    setPlacement((current) => (current && current.top !== top ? { ...current, top } : current));
  }, [anchorTop, anchorBottom, openId]);

  const content = openId ? build(openId) : null;
  const menu =
    placement && content
      ? portalToBody(
          <SidebarMenuPanel
            menuRef={menuRef}
            firstItemRef={firstItemRef}
            position={{ top: placement.top, left: placement.left }}
            onKeyDown={(event) => sidebarMenuKeyDown(event, close)}
            content={content}
          />,
        )
      : null;
  return { openId, open, close, menu };
}
