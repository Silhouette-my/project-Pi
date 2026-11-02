import type { AppSettings } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { api } from "./api";

export type PanelPinKey = "sidebarPinned" | "workPanelPinned";

export type PanelPinMode = "auto" | "pinned" | "hidden";

/**
 * Window widths from which an "auto" panel docks. Below them the panel
 * auto-hides and reveals from its edge, so the main pane keeps a usable width
 * (the 450px MainChat floor plus the sidebar's 275px default, and for the
 * right panel its 360px default on top).
 */
export const PANEL_AUTO_DOCK_MIN_WIDTH: Record<PanelPinKey, number> = {
  sidebarPinned: 960,
  workPanelPinned: 1280,
};

/** Absent means "auto": the panel follows the window width. */
export function panelPinMode(
  settings: Pick<AppSettings, PanelPinKey> | null | undefined,
  key: PanelPinKey,
): PanelPinMode {
  const value = settings?.[key];
  return value === true ? "pinned" : value === false ? "hidden" : "auto";
}

/** Whether the panel is docked now: an explicit choice wins, else the width decides. */
export function isPanelPinned(
  settings: Pick<AppSettings, PanelPinKey> | null | undefined,
  key: PanelPinKey,
  viewportWidth: number,
): boolean {
  const mode = panelPinMode(settings, key);
  if (mode !== "auto") return mode === "pinned";
  return viewportWidth >= PANEL_AUTO_DOCK_MIN_WIDTH[key];
}

/** Persist a mode; "auto" removes the explicit choice. */
export async function setPanelPinMode(key: PanelPinKey, mode: PanelPinMode): Promise<void> {
  const previous = useAppStore.getState().settings;
  if (!previous || panelPinMode(previous, key) === mode) return;
  const next: AppSettings = { ...previous };
  if (mode === "auto") delete next[key];
  else next[key] = mode === "pinned";
  useAppStore.setState({ settings: next });
  try {
    await api.setSettings(next);
  } catch (error) {
    useAppStore.setState({ settings: previous });
    useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), {
      variant: "error",
    });
  }
}

/**
 * Persist a panel's pin state through the regular settings save path. The
 * store updates first so the layout answers the click in the same frame; a
 * failed save restores the previous value and says so.
 */
export async function setPanelPinned(
  key: PanelPinKey,
  pinned: boolean,
): Promise<void> {
  const previous = useAppStore.getState().settings;
  if (!previous || panelPinMode(previous, key) === (pinned ? "pinned" : "hidden")) return;
  const next: AppSettings = { ...previous, [key]: pinned };
  useAppStore.setState({ settings: next });
  try {
    await api.setSettings(next);
  } catch (error) {
    useAppStore.setState((state) =>
      state.settings
        ? { settings: { ...state.settings, [key]: previous[key] } }
        : {},
    );
    useAppStore.getState().showToast(
      error instanceof Error ? error.message : String(error),
      { variant: "error" },
    );
  }
}
