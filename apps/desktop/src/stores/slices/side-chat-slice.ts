import i18n from "i18next";
import { api } from "../../lib/api";
import { sessionAllows } from "../../lib/remote-session-safety";
import {
  anchorExcerptLine,
  DEFAULT_SIDE_CHAT_RETURN_MODE,
  type SideChatReturnState,
} from "../../features/chat/side-chat/side-chat-core";
import {
  patchWorkPanelTabState,
  sideChatWorkPanelTab,
} from "../../lib/work-panel-tabs";
import type { AppState } from "../app-state";
import type { SessionSliceDependencies } from "./session-slice";
import type { StoreAccess } from "./types";
import { currentWorkPanelContext } from "./work-panel-slice";

let wholeSideChatSequence = 0;

/**
 * Chat side chats (ADR side-chats-on-detached-transcripts).
 *
 * The slice owns the state transitions that need the store: opening a draft
 * tab, creating the child session on first Send, and the per-tab return state. It keeps no
 * transcript: the child is read as a detached transcript like every other
 * conversation shown outside the chat surface.
 */
export function createSideChatSlice({
  get,
  set,
  commitForkedSession,
}: StoreAccess & Pick<SessionSliceDependencies, "commitForkedSession">): Pick<
  AppState,
  | "openSideChat"
  | "createSideChatChild"
  | "setSideChatReturnMode"
  | "patchSideChatReturn"
  | "pruneSideChatReturn"
> {
  const patchReturn = (tabId: string, patch: Partial<SideChatReturnState>) =>
    set((state) => {
      const current = state.sideChatReturn[tabId] ?? {
        mode: DEFAULT_SIDE_CHAT_RETURN_MODE,
        status: "idle" as const,
      };
      return { sideChatReturn: { ...state.sideChatReturn, [tabId]: { ...current, ...patch } } };
    });
  return {
    // The return mode is renderer-only (side chats are renderer-owned forks):
    // it can change at any time, is never persisted and is dropped with the tab.
    setSideChatReturnMode: (tabId, mode) => patchReturn(tabId, { mode, error: undefined }),
    patchSideChatReturn: patchReturn,
    pruneSideChatReturn: (live) =>
      set((state) => {
        const keys = Object.keys(state.sideChatReturn);
        if (keys.every((key) => live.has(key))) return {};
        return {
          sideChatReturn: Object.fromEntries(
            keys.filter((key) => live.has(key)).map((key) => [key, state.sideChatReturn[key]]),
          ),
        };
      }),

    openSideChat: (anchorMessageId, options) => {
      const state = get();
      const parentSessionId = state.activeSessionId;
      if (!parentSessionId) return null;
      const message = state.messages.find((item) => item.id === anchorMessageId);
      const parent = state.sessions.find((session) => session.id === parentSessionId);
      if (!message || !parent || !sessionAllows(parent, "canEditMessages")) return null;
      const parentTitle = parent.title.trim() || i18n.t("chat.untitledTask");
      const whole = options?.whole === true;
      wholeSideChatSequence += whole ? 1 : 0;
      const draft = sideChatWorkPanelTab(
        {
          parentSessionId,
          anchorMessageId,
          // A side chat about the whole conversation is about its title, not one reply.
          excerpt: anchorExcerptLine(whole ? parentTitle : message.content || ""),
        },
        i18n.t("sideChat.sessionTitle", { title: parentTitle }),
        undefined,
        whole ? `whole-${Date.now().toString(36)}-${wholeSideChatSequence}` : undefined,
      );
      // Asking again from the same message reuses its tab, so a created child
      // is never forgotten by re-opening the draft.
      const existing = currentWorkPanelContext(state).tabs.find((tab) => tab.id === draft.id);
      get().openWorkPanelTabForSession(parentSessionId, existing ?? draft);
      return draft.id;
    },

    createSideChatChild: async ({ parentSessionId, anchorMessageId, title, tabId }) => {
      // The host reads the canonical prefix from the anchor id; nothing here
      // hydrates the parent, so its streaming tail is never overwritten.
      const result = await api.forkSession(parentSessionId, title, anchorMessageId);
      const child = result.session;
      // Never activate: the visible conversation is the parent's, and the
      // child is shown by the panel through a detached transcript.
      commitForkedSession(child, { activate: false, clearError: true });
      // Bind only the original tab. A close or a session switch during the
      // host call must never reopen a panel, so a missing tab is left alone.
      set((state) => {
        const bind = (tabs: AppState["workPanelTabs"]) =>
          patchWorkPanelTabState({ tabs, activeTabId: null }, tabId, { resource: child.id }).tabs;
        const context = state.workPanelContexts[parentSessionId];
        const contexts =
          context && context.tabs.some((tab) => tab.id === tabId)
            ? {
                workPanelContexts: {
                  ...state.workPanelContexts,
                  [parentSessionId]: { ...context, tabs: bind(context.tabs) },
                },
              }
            : {};
        const visible =
          state.activeSessionId === parentSessionId &&
          state.workPanelTabs.some((tab) => tab.id === tabId)
            ? { workPanelTabs: bind(state.workPanelTabs) }
            : {};
        return { ...contexts, ...visible };
      });
      return child.id;
    },
  };
}
