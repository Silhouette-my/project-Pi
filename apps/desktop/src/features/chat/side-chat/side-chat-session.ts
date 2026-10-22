/**
 * Store-facing side-chat operations (ADR side-chats-on-detached-transcripts).
 *
 * The rules live in `side-chat-core.ts`; this module binds them to the store,
 * the per-session draft cache and the work-panel tabs.
 */
import { useSyncExternalStore } from "react";
import i18n from "i18next";
import { useAppStore } from "../../../stores/app-store";
import {
  appendComposerDraftText,
  draftKeyForSession,
} from "../../../lib/composer-draft-cache";
import type { WorkPanelTab } from "../../../lib/work-panel-tabs";
import {
  buildQuoteText,
  createSideChatSender,
  newestAssistantAnswer,
} from "./side-chat-core";

const sender = createSideChatSender();

// Unsent side-chat text lives only in renderer memory (never on disk) and only
// while its tab exists. It is kept apart from per-session composer drafts.
const drafts = new Map<string, string>();
const draftListeners = new Set<() => void>();

function emitDrafts() {
  for (const listener of draftListeners) listener();
}

export function useSideChatDraft(tabId: string) {
  const text = useSyncExternalStore(
    (listener) => {
      draftListeners.add(listener);
      return () => draftListeners.delete(listener);
    },
    () => drafts.get(tabId) ?? "",
  );
  return [
    text,
    (next: string) => {
      if (next) drafts.set(tabId, next);
      else drafts.delete(tabId);
      emitDrafts();
    },
  ] as const;
}

/** Send the draft. The first Send forks the child; later Sends reuse it. */
export async function sendSideChatMessage(tab: WorkPanelTab, text: string): Promise<void> {
  const anchor = tab.sideChat;
  if (!anchor) return;
  const store = useAppStore.getState();
  await sender.send(
    tab.id,
    text,
    {
      create: () =>
        store.createSideChatChild({
          parentSessionId: anchor.parentSessionId,
          anchorMessageId: anchor.anchorMessageId,
          title: tab.label ?? i18n.t("sideChat.title"),
          tabId: tab.id,
        }),
      attach: (childId) => useAppStore.getState().attachSessionTranscript(childId),
      send: (childId, value) =>
        useAppStore.getState().sendPrompt(value, { text: value, fileReferences: [] }, childId),
    },
    { known: tab.resource || undefined, rejected: i18n.t("sideChat.sendFailed") },
  );
}

/**
 * Quote the side chat's newest answer into the parent's composer draft.
 * Writes the per-session draft (D301) and never sends.
 */
export function addSideChatAnswerToMain(tab: WorkPanelTab): boolean {
  const anchor = tab.sideChat;
  const childId = tab.resource;
  if (!anchor || !childId) return false;
  const state = useAppStore.getState();
  const messages =
    state.activeSessionId === childId ? state.messages : state.retainedTranscripts[childId];
  const answer = newestAssistantAnswer(messages ?? []);
  if (!answer) return false;
  const title =
    state.sessions.find((session) => session.id === childId)?.title.trim() ||
    tab.label ||
    i18n.t("sideChat.title");
  const quote = buildQuoteText(answer, i18n.t("chat.quoteSource", { title }));
  const snapshot = appendComposerDraftText(draftKeyForSession(anchor.parentSessionId), quote);
  // A mounted Composer adopts the new draft through its ordinary prefill path.
  if (snapshot && state.activeSessionId === anchor.parentSessionId) {
    useAppStore.setState({
      composerPrefill: {
        sessionId: anchor.parentSessionId,
        text: snapshot.text,
        fileReferences: snapshot.fileReferences,
      },
    });
  }
  return Boolean(snapshot);
}

/** Close the tab and release its unsent draft. The child session is untouched. */
export function closeSideChat(tab: WorkPanelTab) {
  useAppStore.getState().closeWorkPanelTab(tab.id);
}

/** Select the child through the normal path, then drop the tab. */
export async function openSideChatAsConversation(tab: WorkPanelTab): Promise<void> {
  const childId = tab.resource;
  if (!childId) return;
  closeSideChat(tab);
  await useAppStore.getState().selectSession(childId);
}

let lifecycleInstalled = false;

/**
 * Release draft text and creation memory for tabs that no longer exist in any
 * session's panel context. A single store subscription covers every way a tab
 * can disappear (its close button, middle click, neighbor close, deletion).
 */
export function installSideChatLifecycle() {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;
  useAppStore.subscribe((state, previous) => {
    if (
      state.workPanelContexts === previous.workPanelContexts &&
      state.workPanelTabs === previous.workPanelTabs
    ) {
      return;
    }
    const live = new Set<string>();
    const collect = (tabs: readonly WorkPanelTab[]) => {
      for (const tab of tabs) if (tab.kind === "sidechat") live.add(tab.id);
    };
    collect(state.workPanelTabs);
    for (const context of Object.values(state.workPanelContexts)) collect(context.tabs);
    let changed = false;
    for (const key of [...drafts.keys()]) {
      if (live.has(key)) continue;
      drafts.delete(key);
      changed = true;
    }
    for (const key of sender.keys()) if (!live.has(key)) sender.forget(key);
    if (changed) emitDrafts();
  });
}
