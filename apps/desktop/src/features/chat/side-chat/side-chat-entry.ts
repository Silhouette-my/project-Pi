/**
 * The conversation-level entry into side chats (the topbar's "New side chat"):
 * a side chat about the whole conversation. The per-message entry lives in
 * `SideChatAction`; both open the same draft tab, so the first Send forks.
 */
import type { UiMessage } from "@pi-desktop/shared";
import { messageHasTranscriptContent } from "../../../lib/chat-launch-error";
import { sessionAllows } from "../../../lib/remote-session-safety";
import { useAppStore } from "../../../stores/app-store";

/** The newest message that has something to read; an empty conversation has none. */
export function lastSideChatAnchor(messages: readonly UiMessage[]): UiMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messageHasTranscriptContent(messages[index])) return messages[index];
  }
  return undefined;
}

/** Id of the anchor a whole-conversation side chat would fork from, or "" when empty. */
export function selectSideChatAnchorId(state: {
  messages: readonly UiMessage[];
}): string {
  return lastSideChatAnchor(state.messages)?.id ?? "";
}

/** Whether the visible conversation may start a side chat at all. */
export function selectCanOpenSideChat(state: ReturnType<typeof useAppStore.getState>): boolean {
  const id = state.activeSessionId;
  if (!id || id.startsWith("remote:")) return false;
  return sessionAllows(
    state.sessions.find((session) => session.id === id),
    "canEditMessages",
  );
}

/**
 * Put the caret in a side chat's composer once the panel has mounted it. An
 * auto-hidden panel that is sliding in refuses focus, and revealing it moves
 * focus onto the panel itself, so focus is claimed again for a short settle
 * window instead of once.
 */
export function focusSideChatComposer(tabId: string, settleMs = 700): void {
  const selector = `[data-side-chat-form="${tabId.replace(/["\\]/g, "\\$&")}"] textarea`;
  const started = performance.now();
  const tryFocus = () => {
    const input = document.querySelector<HTMLTextAreaElement>(selector);
    if (input && document.activeElement !== input) input.focus({ preventScroll: true });
    if (performance.now() - started < settleMs) requestAnimationFrame(tryFocus);
  };
  requestAnimationFrame(tryFocus);
}

/**
 * Open a new side chat about the whole conversation, reveal the panel and
 * focus its composer. Returns the tab id, or null when there is nothing to
 * anchor to (an empty conversation) or the conversation cannot fork.
 */
export function openWholeConversationSideChat(): string | null {
  const state = useAppStore.getState();
  const anchor = lastSideChatAnchor(state.messages);
  if (!anchor || !selectCanOpenSideChat(state)) return null;
  const tabId = state.openSideChat(anchor.id, { whole: true });
  if (tabId) focusSideChatComposer(tabId);
  return tabId;
}
