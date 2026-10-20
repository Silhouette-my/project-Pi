import { useCallback } from "react";
import { useAppStore } from "../../stores/app-store";
import type { AppState } from "../../stores/app-state";
import { useProjectWorkflow } from "./useProjectWorkflow";

/** Global creation preserves the existing workspace contract, not a reused folder. */
export function useUnfiledNewSession() {
  const { snapshot, mutate } = useProjectWorkflow();
  return useCallback(
    async (options?: Parameters<AppState["newSession"]>[0]) => {
      const sessionId = await useAppStore.getState().newSession(options);
      if (
        sessionId &&
        snapshot?.navigation.find((item) => item.sessionId === sessionId)?.folderId
      ) {
        await mutate({ kind: "navigation.move", sessionIds: [sessionId] });
      }
      return sessionId;
    },
    [mutate, snapshot],
  );
}
