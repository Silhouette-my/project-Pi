import type { AppSettings } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { api } from "./api";

export type PanelPinKey = "sidebarPinned" | "workPanelPinned";

/** Absent means unpinned: the panel auto-hides until the user docks it. */
export function isPanelPinned(
  settings: Pick<AppSettings, PanelPinKey> | null | undefined,
  key: PanelPinKey,
): boolean {
  return settings?.[key] === true;
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
  if (!previous || isPanelPinned(previous, key) === pinned) return;
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
