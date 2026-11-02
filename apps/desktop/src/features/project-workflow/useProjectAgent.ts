import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import {
  openProjectAgentConversation,
  ProjectAgentNavigationCancelled,
} from "./project-agent-navigation";
import { useProjectWorkflow } from "./useProjectWorkflow";

const requests = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Reuse the canonical project discussion and the existing chat/queue surface. */
export function useProjectAgent(projectId: string) {
  const { t } = useTranslation();
  const { action, busy: workflowBusy } = useProjectWorkflow();
  const busy = useSyncExternalStore(subscribe, () => requests.has(projectId));
  const [error, setError] = useState<string | null>(null);
  const current = useRef<string | null>(projectId);
  useEffect(() => {
    current.current = projectId;
    return () => {
      current.current = null;
    };
  }, [projectId]);
  const open = useCallback(
    (prompt?: string): Promise<void> => {
      const existing = requests.get(projectId);
      if (existing) return existing;
      setError(null);
      const request = openProjectAgentConversation({
        open: () => action({ kind: "agent.open", projectId }),
        getState: useAppStore.getState,
        isCurrent: () => current.current === projectId,
        prompt,
        openError: t("workflow.agentOpenFailed"),
        sendError: t("workflow.agentSendFailed"),
      })
        .catch((cause: unknown) => {
          if (!(cause instanceof ProjectAgentNavigationCancelled)) {
            const message = cause instanceof Error ? cause.message : String(cause);
            if (current.current === projectId) setError(message);
            else useAppStore.getState().showToast(message, { variant: "error" });
          }
          throw cause;
        })
        .finally(() => {
          requests.delete(projectId);
          notify();
        });
      requests.set(projectId, request);
      notify();
      return request;
    },
    [action, projectId, t],
  );
  return { open, busy: busy || workflowBusy, error };
}
