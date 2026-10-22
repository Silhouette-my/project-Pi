import { useSyncExternalStore } from "react";

const subscribe = (listener: () => void) => {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
};

/** Window inner width, re-rendering on resize (layout-level decisions only). */
export function useViewportWidth(): number {
  return useSyncExternalStore(
    subscribe,
    () => window.innerWidth,
    () => 1280,
  );
}
