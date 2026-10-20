import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  ProjectWorkflowAction,
  ProjectWorkflowActionResult,
  ProjectWorkflowMutationResult,
  ProjectWorkflowSnapshot,
  ProjectWorkflowUserCommand,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";

type WithoutRevision<T> = T extends unknown ? Omit<T, "commandId" | "expectedRevision"> : never;
export type WorkflowMutation = WithoutRevision<ProjectWorkflowUserCommand>;
export type WorkflowAction = WithoutRevision<ProjectWorkflowAction>;
type WorkflowView = {
  snapshot: ProjectWorkflowSnapshot | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  mutate: (command: WorkflowMutation) => Promise<ProjectWorkflowMutationResult | undefined>;
  action: (action: WorkflowAction) => Promise<ProjectWorkflowActionResult | undefined>;
};
const WorkflowContext = createContext<WorkflowView | null>(null);

/** A transient projection of host state. Commands and execution stay across IPC. */
export function ProjectWorkflowProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<ProjectWorkflowSnapshot | null>(null);
  const current = useRef<ProjectWorkflowSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(false);
  const accept = useCallback((next: ProjectWorkflowSnapshot) => {
    if (!alive.current || (current.current && next.revision < current.current.revision)) return;
    current.current = next;
    setSnapshot(next);
  }, []);
  const report = useCallback(
    (cause: unknown) => {
      if (!alive.current) return;
      const code =
        typeof cause === "object" && cause !== null && "code" in cause ? cause.code : null;
      setError(
        code === "CONFLICT"
          ? t("workflow.conflict")
          : t("workflow.requestFailed", {
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
      );
    },
    [t],
  );
  const refresh = useCallback(async () => {
    try {
      accept(await api.projectWorkflow.snapshot());
    } catch (cause) {
      report(cause);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [accept, report]);
  useEffect(() => {
    if (!enabled) return;
    alive.current = true;
    const dispose = api.projectWorkflow.onChanged(() => {
      void refresh();
    });
    void refresh();
    return () => {
      alive.current = false;
      dispose();
    };
  }, [refresh, enabled]);
  const execute = useCallback(
    async <T extends { snapshot: ProjectWorkflowSnapshot }>(
      send: (revision: number) => Promise<T>,
    ): Promise<T | undefined> => {
      if (!current.current) return undefined;
      setPending((count) => count + 1);
      setError(null);
      try {
        const result = await send(current.current.revision);
        accept(result.snapshot);
        return result;
      } catch (cause) {
        report(cause);
        // Refresh for the user's next decision; never replay a failed command.
        await refresh();
        return undefined;
      } finally {
        if (alive.current) setPending((count) => count - 1);
      }
    },
    [accept, refresh, report],
  );
  const mutate = useCallback(
    (command: WorkflowMutation) =>
      execute((expectedRevision) =>
        api.projectWorkflow.mutate({
          ...command,
          commandId: crypto.randomUUID(),
          expectedRevision,
        }),
      ),
    [execute],
  );
  const action = useCallback(
    (intent: WorkflowAction) =>
      execute((expectedRevision) =>
        api.projectWorkflow.action({ ...intent, commandId: crypto.randomUUID(), expectedRevision }),
      ),
    [execute],
  );
  const value = useMemo(
    () => ({ snapshot, loading, busy: pending > 0, error, refresh, mutate, action }),
    [snapshot, loading, pending, error, refresh, mutate, action],
  );
  return <WorkflowContext.Provider value={value}>{children}</WorkflowContext.Provider>;
}

export function useProjectWorkflow(): WorkflowView {
  const view = useContext(WorkflowContext);
  if (!view) throw new Error("ProjectWorkflowProvider is required");
  return view;
}
