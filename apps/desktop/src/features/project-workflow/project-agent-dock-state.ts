import { useSyncExternalStore } from "react";

/**
 * Per-project preference for the docked Agent. An explicit choice is
 * remembered across navigation and launches; without one the dock is open
 * whenever the console is wide enough to dock it. Narrow consoles overlay the
 * dock on request instead and do not consult this preference.
 */
const STORAGE_KEY = "pi-desktop.project-agent-dock";
const listeners = new Set<() => void>();
let choices: Record<string, boolean> = read();

function read(): Record<string, boolean> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
      ),
    );
  } catch {
    return {};
  }
}

function write(projectId: string, open: boolean) {
  choices = { ...choices, [projectId]: open };
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // Storage is a convenience; the in-memory choice still applies this session.
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useProjectAgentDockState(projectId: string, wide: boolean) {
  const choice = useSyncExternalStore(subscribe, () => choices[projectId]);
  const open = choice ?? wide;
  return [open, (next: boolean) => write(projectId, next)] as const;
}
