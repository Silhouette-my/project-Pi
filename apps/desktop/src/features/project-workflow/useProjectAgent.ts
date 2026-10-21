import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import {
  openProjectAgentConversation,
  ProjectAgentNavigationCancelled,
} from "./project-agent-navigation";
import { useProjectWorkflow } from "./useProjectWorkflow";

/** Reuse the canonical project discussion and the existing chat/queue surface. */
export function useProjectAgent(projectId: string) {
  const { t } = useTranslation();
  const { action, busy: workflowBusy } = useProjectWorkflow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<string | null>(projectId);
  const pending = useRef<Promise<void> | null>(null);
  useEffect(() => {
    current.current = projectId;
    return () => {
      current.current = null;
    };
  }, [projectId]);
  const open = useCallback(
    (prompt?: string): Promise<void> => {
      if (pending.current) return pending.current;
      setError(null);
      setBusy(true);
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
          pending.current = null;
          if (current.current === projectId) setBusy(false);
        });
      pending.current = request;
      return request;
    },
    [action, projectId, t],
  );
  return { open, busy: busy || workflowBusy, error };
}
