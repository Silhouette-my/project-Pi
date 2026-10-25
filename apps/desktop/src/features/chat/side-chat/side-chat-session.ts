/**
 * Store-facing side-chat operations (ADR side-chats-on-detached-transcripts).
 *
 * The rules live in `side-chat-core.ts`; this module binds them to the store,
 * the per-session draft cache and the work-panel tabs.
 */
import { applyPendingConfiguration } from "../../../components/conversation/pending-configuration";
import type { SessionConfigurationInput } from "../../../stores/app-state";
import { useSyncExternalStore } from "react";
import i18n from "i18next";
import { useAppStore } from "../../../stores/app-store";
import { insertIntoComposerDraft } from "../../../lib/composer-draft-insert";
import type { WorkPanelTab } from "../../../lib/work-panel-tabs";
import { CHAT_INSTRUCTION_NONE_ID, type SessionSummary, type UiMessage } from "@pi-desktop/shared";
import {
  buildSummaryQuote,
  buildTranscriptQuote,
  createSideChatSender,
  DEFAULT_SIDE_CHAT_RETURN_MODE,
  runSideChatSummary,
  SideChatReturnError,
  sideChatReturnBlockReason,
  sideChatTurns,
  type SideChatReturnFailure,
} from "./side-chat-core";

const sender = createSideChatSender();

/** How long the summary turn may take before the return fails visibly. */
export const SIDE_CHAT_SUMMARY_TIMEOUT_MS = 120_000;
// A summary wait that must stop when its tab closes. Never persisted.
const summaryWaits = new Map<string, AbortController>();

type StoreState = ReturnType<typeof useAppStore.getState>;

/** The side chat's transcript as the store currently holds it. */
function transcriptOf(state: StoreState, sessionId: string): readonly UiMessage[] {
  return (
    (state.activeSessionId === sessionId ? state.messages : state.retainedTranscripts[sessionId]) ??
    []
  );
}

/** The tab's return mode; None until the user picks another. */
export function sideChatReturnModeOf(state: StoreState, tabId: string) {
  return state.sideChatReturn[tabId]?.mode ?? DEFAULT_SIDE_CHAT_RETURN_MODE;
}

/**
 * How many leading transcript messages are the parent prefix copied by the
 * fork. Recorded before the first prompt; otherwise derived from the anchor's
 * position in the parent transcript.
 */
function forkPrefixCount(state: StoreState, tab: WorkPanelTab): number {
  const recorded = state.sideChatReturn[tab.id]?.prefixCount;
  if (recorded !== undefined) return recorded;
  const anchor = tab.sideChat;
  if (!anchor) return 0;
  const index = transcriptOf(state, anchor.parentSessionId).findIndex(
    (message) => message.id === anchor.anchorMessageId,
  );
  return index < 0 ? 0 : index + 1;
}

/** The exchanges of the side discussion after the fork anchor (no tool rows). */
export function sideChatDiscussion(state: StoreState, tab: WorkPanelTab) {
  const childId = tab.resource;
  if (!childId) return [];
  return sideChatTurns(transcriptOf(state, childId), forkPrefixCount(state, tab));
}

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

function sideChatConfiguration(
  child: SessionSummary | undefined,
  configuration: SessionConfigurationInput | undefined,
): SessionConfigurationInput | undefined {
  if (!child) return configuration;
  return {
    mode: child.mode,
    providerId: child.providerId,
    modelId: child.modelId,
    thinkingLevel: child.thinkingLevel,
    promptPreset: CHAT_INSTRUCTION_NONE_ID,
    ...configuration,
  };
}

/** Send the draft. The first Send forks the child; later Sends reuse it. */
export async function sendSideChatMessage(
  tab: WorkPanelTab,
  text: string,
  configuration?: SessionConfigurationInput,
): Promise<void> {
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
      send: async (childId, value) => {
        // A side chat starts without a chat instruction even when its parent
        // has one (the fork copies it); a pick made before the first send wins.
        await applyPendingConfiguration(
          childId,
          sideChatConfiguration(useAppStore.getState().sessions.find((item) => item.id === childId), configuration),
        );
        // The child's transcript now holds exactly the copied parent prefix.
        const current = useAppStore.getState();
        if (current.sideChatReturn[tab.id]?.prefixCount === undefined) {
          current.patchSideChatReturn(tab.id, {
            prefixCount: transcriptOf(current, childId).length,
          });
        }
        return useAppStore.getState().sendPrompt(value, { text: value, fileReferences: [] }, childId);
      },
    },
    { known: tab.resource || undefined, rejected: i18n.t("sideChat.sendFailed") },
  );
}

/** Append a quote to the parent's composer draft. Never sends. */
function insertIntoParentDraft(parentSessionId: string, quote: string): boolean {
  const inserted = insertIntoComposerDraft(parentSessionId, quote);
  if (inserted) {
    const parent = useAppStore.getState().sessions.find((session) => session.id === parentSessionId);
    useAppStore.getState().showToast(
      i18n.t("workPanel.return.inserted", { title: parent?.title.trim() || i18n.t("chat.untitledTask") }),
      { variant: "success" },
    );
  }
  return inserted;
}

const FAILURE_KEYS: Record<SideChatReturnFailure, string> = {
  busy: "sideChat.returnBusy",
  rejected: "sideChat.summaryRejected",
  timeout: "sideChat.summaryTimeout",
  noAnswer: "sideChat.summaryNoAnswer",
};

/**
 * Return the side discussion to the main thread according to the tab's mode.
 *
 * Both modes only write the parent's per-session composer draft (D301); the
 * user reviews and sends it. Summary asks the side chat itself for a summary,
 * waits for that turn and quotes its answer; Everything quotes the exchanges
 * after the fork anchor. A second call while a summary is pending is ignored.
 */
export async function returnSideChatToMain(tab: WorkPanelTab): Promise<void> {
  const anchor = tab.sideChat;
  const childId = tab.resource;
  const store = useAppStore.getState();
  if (!anchor || !childId || store.sideChatReturn[tab.id]?.status === "running") return;
  const mode = sideChatReturnModeOf(store, tab.id);
  const blocked = sideChatReturnBlockReason({
    mode,
    hasChild: true,
    childRunning: store.runningSessions[childId] === true,
    turnCount: sideChatDiscussion(store, tab).length,
  });
  if (blocked) return;
  const title =
    store.sessions.find((session) => session.id === childId)?.title.trim() ||
    tab.label ||
    i18n.t("sideChat.title");
  const attribution = i18n.t("chat.quoteSource", { title });

  if (mode === "full") {
    insertIntoParentDraft(
      anchor.parentSessionId,
      buildTranscriptQuote(sideChatDiscussion(store, tab), {
        label: i18n.t("sideChat.returnLabelFull"),
        attribution,
        roles: { user: i18n.t("sideChat.roleUser"), assistant: i18n.t("sideChat.roleAssistant") },
        truncated: (omitted) => i18n.t("sideChat.transcriptTruncated", { count: omitted }),
      }),
    );
    return;
  }

  if (mode !== "summary") return;
  const wait = new AbortController();
  summaryWaits.set(tab.id, wait);
  store.patchSideChatReturn(tab.id, { status: "running", error: undefined });
  try {
    await store.attachSessionTranscript(childId).catch(() => {});
    const prompt = i18n.t("sideChat.summaryPrompt");
    const summary = await runSideChatSummary({
      isRunning: () => useAppStore.getState().runningSessions[childId] === true,
      messages: () => transcriptOf(useAppStore.getState(), childId),
      subscribe: (listener) => useAppStore.subscribe(listener),
      send: () =>
        useAppStore.getState().sendPrompt(prompt, { text: prompt, fileReferences: [] }, childId),
      timeoutMs: SIDE_CHAT_SUMMARY_TIMEOUT_MS,
      signal: wait.signal,
    });
    insertIntoParentDraft(
      anchor.parentSessionId,
      buildSummaryQuote(summary, { label: i18n.t("sideChat.returnLabelSummary"), attribution }),
    );
    useAppStore.getState().patchSideChatReturn(tab.id, { status: "idle", error: undefined });
  } catch (error) {
    const failure = error instanceof SideChatReturnError ? error.failure : undefined;
    const message = i18n.t(failure ? FAILURE_KEYS[failure] : "sideChat.summaryRejected");
    useAppStore.getState().patchSideChatReturn(tab.id, { status: "idle", error: message });
    // The floating control has no hint line; a failed return is a toast.
    useAppStore.getState().showToast(message, { variant: "error" });
  } finally {
    if (summaryWaits.get(tab.id) === wait) summaryWaits.delete(tab.id);
  }
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
    for (const [key, wait] of summaryWaits) {
      if (live.has(key)) continue;
      wait.abort();
      summaryWaits.delete(key);
    }
    state.pruneSideChatReturn(live);
    if (changed) emitDrafts();
  });
}
