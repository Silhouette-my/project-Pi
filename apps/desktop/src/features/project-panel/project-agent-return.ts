/**
 * Renderer state and the return action of the project Agent tab.
 *
 * The Agent has no tools, so handing its discussion to a project conversation
 * is done here by the user: the quote only lands in the target's composer draft
 * and is never sent. State is renderer memory (like the panel contexts): the
 * mode and target survive switching tabs, not an app restart.
 */
import { useSyncExternalStore } from "react";
import i18n from "i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { insertIntoComposerDraft } from "../../lib/composer-draft-insert";
import {
  buildSummaryQuote,
  buildTranscriptQuote,
  runSideChatSummary,
  SideChatReturnError,
  sideChatTurns,
} from "../chat/side-chat/side-chat-core";
import { appendProjectAgentDraft } from "../project-workflow/project-agent-draft";
import {
  DEFAULT_AGENT_RETURN_MODE,
  type AgentReturnMode,
} from "./project-return-core";
import type { ConversationTarget } from "./project-panel-text";

type AgentReturnState = {
  mode: AgentReturnMode;
  /** The user's explicit target; empty means "the conversation they came from". */
  targetId?: string;
  status: "idle" | "running";
};

const IDLE: AgentReturnState = { mode: DEFAULT_AGENT_RETURN_MODE, status: "idle" };
const states = new Map<string, AgentReturnState>();
const listeners = new Set<() => void>();
const lastConversation = new Map<string, string>();

function emit() {
  for (const listener of listeners) listener();
}

function patch(projectId: string, next: Partial<AgentReturnState>) {
  states.set(projectId, { ...(states.get(projectId) ?? IDLE), ...next });
  emit();
}

export function useAgentReturnState(projectId: string): AgentReturnState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => states.get(projectId) ?? IDLE,
    () => IDLE,
  );
}

export function setAgentReturnMode(projectId: string, mode: AgentReturnMode) {
  patch(projectId, { mode });
}

export function setAgentReturnTarget(projectId: string, targetId: string) {
  patch(projectId, { targetId });
}

/** Remember the project conversation the user is in, so the Agent can default to it. */
export function noteProjectConversation(projectId: string, sessionId: string) {
  if (lastConversation.get(projectId) === sessionId) return;
  lastConversation.set(projectId, sessionId);
  emit();
}

export function useLastProjectConversation(projectId: string): string | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => lastConversation.get(projectId),
    () => undefined,
  );
}

/** How long the summary turn may take before the return fails visibly. */
const SUMMARY_TIMEOUT_MS = 120_000;

function transcriptOf(sessionId: string): readonly UiMessage[] {
  const state = useAppStore.getState();
  return (
    (state.activeSessionId === sessionId ? state.messages : state.retainedTranscripts[sessionId]) ??
    []
  );
}

/** Whether the Agent has said anything the user could return. */
export function agentHasAnswer(messages: readonly UiMessage[] | undefined): boolean {
  return Boolean(messages?.some((m) => m.role === "assistant" && (m.content || "").trim()));
}

const FAILURES = {
  busy: "workPanel.return.busy",
  rejected: "sideChat.summaryRejected",
  timeout: "sideChat.summaryTimeout",
  noAnswer: "sideChat.summaryNoAnswer",
} as const;

/**
 * Quote the Agent's discussion into the target conversation's draft: its
 * summary (the Agent is asked for one and awaited) or the whole discussion. The
 * quote is a blockquote, a blank line, then the attribution line. Never sends.
 */
export async function returnAgentToTarget(input: {
  projectId: string;
  projectName: string;
  agentSessionId: string;
  mode: AgentReturnMode;
  target: ConversationTarget;
}): Promise<void> {
  const { projectId, projectName, agentSessionId, mode, target } = input;
  if (mode === "none" || (states.get(projectId) ?? IDLE).status === "running") return;
  const attribution = i18n.t("projectPanel.agentQuote", { project: projectName });
  const store = useAppStore.getState();
  let quote: string;
  patch(projectId, { status: "running" });
  try {
    if (mode === "full") {
      quote = buildTranscriptQuote(sideChatTurns(transcriptOf(agentSessionId), 0), {
        label: i18n.t("projectPanel.discussionLabel"),
        attribution,
        roles: { user: i18n.t("sideChat.roleUser"), assistant: i18n.t("sideChat.roleAssistant") },
        truncated: (omitted) => i18n.t("sideChat.transcriptTruncated", { count: omitted }),
      });
    } else {
      await store.attachSessionTranscript(agentSessionId).catch(() => {});
      const prompt = i18n.t("projectPanel.summaryPrompt");
      const summary = await runSideChatSummary({
        isRunning: () => useAppStore.getState().runningSessions[agentSessionId] === true,
        messages: () => transcriptOf(agentSessionId),
        subscribe: (listener) => useAppStore.subscribe(listener),
        send: () =>
          useAppStore
            .getState()
            .sendPrompt(prompt, { text: prompt, fileReferences: [] }, agentSessionId),
        timeoutMs: SUMMARY_TIMEOUT_MS,
      });
      quote = buildSummaryQuote(summary, { label: i18n.t("sideChat.returnLabelSummary"), attribution });
    }
    // A side conversation's composer is a panel tab with its own draft slot.
    if (target.kind === "side") appendProjectAgentDraft(`side:${target.sessionId}`, quote);
    else insertIntoComposerDraft(target.sessionId, quote);
    useAppStore
      .getState()
      .showToast(i18n.t("workPanel.return.inserted", { title: target.title }), { variant: "success" });
  } catch (error) {
    const failure = error instanceof SideChatReturnError ? error.failure : undefined;
    useAppStore.getState().showToast(i18n.t(failure ? FAILURES[failure] : "workPanel.return.failed"), {
      variant: "error",
    });
  } finally {
    patch(projectId, { status: "idle" });
  }
}
