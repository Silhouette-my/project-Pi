import { useEffect } from "react";
import type { UiMessage } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";

/**
 * A session's transcript as the store holds it: the live messages for the
 * active session, the retained copy for any other. With `attach`, a missing
 * copy is requested, the same way a detached conversation reads its session;
 * the active session and the visible page are never touched.
 */
export function useSessionMessages(
  sessionId: string | undefined,
  attach = false,
): UiMessage[] | undefined {
  const messages = useAppStore((state) =>
    !sessionId
      ? undefined
      : state.activeSessionId === sessionId
        ? state.messages
        : state.retainedTranscripts[sessionId],
  );
  const attachTranscript = useAppStore((state) => state.attachSessionTranscript);
  const present = messages !== undefined;
  useEffect(() => {
    if (attach && sessionId && !present) void attachTranscript(sessionId).catch(() => {});
  }, [attach, attachTranscript, present, sessionId]);
  return messages;
}
