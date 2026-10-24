import { useAppStore } from "../stores/app-store";
import { appendComposerDraftText, draftKeyForSession } from "./composer-draft-cache";

/**
 * Append text to a conversation's composer draft. Never sends: the user reviews
 * and sends it. A mounted Composer adopts the new draft through its ordinary
 * prefill path, so the text shows up without a remount.
 */
export function insertIntoComposerDraft(sessionId: string, text: string): boolean {
  const snapshot = appendComposerDraftText(draftKeyForSession(sessionId), text);
  const state = useAppStore.getState();
  if (snapshot && state.activeSessionId === sessionId) {
    useAppStore.setState({
      composerPrefill: {
        sessionId,
        text: snapshot.text,
        fileReferences: snapshot.fileReferences,
      },
    });
  }
  return Boolean(snapshot);
}
