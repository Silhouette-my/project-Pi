import type { HostProcess } from "../host-process";

/** How long a quit waits for host-core to describe its running work. */
export const QUIT_WORK_PROBE_TIMEOUT_MS = 1_000;

export type QuitWorkDependencies = {
  activeTurns: ReadonlyMap<string, string>;
  getHost: () => Pick<HostProcess, "call"> | null;
  /** Main-side voice session registry: true while a call slot is held. */
  liveCallService?: { hasActiveCall(): boolean };
  timeoutMs?: number;
};

/**
 * True when quitting would interrupt work a person started: an agent turn, a
 * live voice call, a background task (dev server, watcher) or a project
 * workflow run. Turns and the voice call are main-side state and answered
 * immediately. Background tasks and workflow runs only exist in host-core, so
 * they are asked with a short budget; an unavailable or slow host counts as
 * "nothing running" because a quit must never hang on this question.
 */
export async function hasRunningWork({
  activeTurns,
  getHost,
  liveCallService,
  timeoutMs = QUIT_WORK_PROBE_TIMEOUT_MS,
}: QuitWorkDependencies): Promise<boolean> {
  if (activeTurns.size > 0) return true;
  try {
    if (liveCallService?.hasActiveCall()) return true;
  } catch {
    // An unreadable voice registry must not block the quit.
  }
  const host = getHost();
  if (!host) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const probe = async (method: string, params: unknown, running: (result: any) => boolean) => {
    try {
      return running(await host.call(method, params as never));
    } catch {
      return false;
    }
  };
  try {
    const answers = await Promise.race([
      Promise.all([
        probe("backgroundTasks.list", undefined, (result) =>
          Array.isArray(result?.tasks) && result.tasks.some((task: { state?: string }) => task.state === "running")),
        probe("project.workflow.snapshot", {}, (result) =>
          Array.isArray(result?.workstreams) && result.workstreams.some((item: { status?: string }) => item.status === "executing")),
      ]).then((flags) => flags.some(Boolean)),
      budget,
    ]);
    return answers;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
