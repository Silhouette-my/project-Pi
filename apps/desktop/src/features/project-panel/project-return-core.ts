/**
 * Framework-free rules of the project panel's return controls (project Agent
 * and project side conversations). Callers pass live state and translated
 * strings in; nothing here touches the store, the DOM or i18n.
 */
import type { UiMessage } from "@pi-desktop/shared";
import type { ConversationTarget } from "./project-panel-text";

/** What the project Agent hands to a target conversation. */
export type AgentReturnMode = "none" | "summary" | "full";
export const AGENT_RETURN_MODES: readonly AgentReturnMode[] = ["none", "summary", "full"];
export const DEFAULT_AGENT_RETURN_MODE: AgentReturnMode = "none";

/** Where a project side conversation's answers go (the Host's returnPolicy). */
export type SideReturnPolicy = "none" | "proposal" | "delivery";
export const SIDE_RETURN_POLICIES: readonly SideReturnPolicy[] = ["none", "proposal", "delivery"];

/**
 * The conversation the Agent returns into: the user's explicit pick while it
 * is still a project conversation, else the one the user last came from in
 * this project, else the first workstream main, else the first target.
 */
export function resolveReturnTarget(
  targets: readonly ConversationTarget[],
  preferredId: string | undefined,
  lastConversationId: string | undefined,
): ConversationTarget | undefined {
  const find = (id: string | undefined) =>
    id ? targets.find((target) => target.sessionId === id) : undefined;
  return (
    find(preferredId) ??
    find(lastConversationId) ??
    targets.find((target) => target.kind === "workstream") ??
    targets[0]
  );
}

export type ReturnBlockReason =
  | "workPanel.return.nothing"
  | "workPanel.return.busy"
  | "workPanel.return.noTarget";

/** Why "Return to conversation" is unavailable for the project Agent. */
export function agentReturnBlockReason(state: {
  hasTarget: boolean;
  running: boolean;
  hasAnswer: boolean;
}): ReturnBlockReason | undefined {
  if (state.running) return "workPanel.return.busy";
  if (!state.hasAnswer) return "workPanel.return.nothing";
  if (!state.hasTarget) return "workPanel.return.noTarget";
  return undefined;
}

/** Why "Return to conversation" is unavailable for a side conversation. */
export function sideReturnBlockReason(state: {
  running: boolean;
  hasAnswer: boolean;
}): ReturnBlockReason | undefined {
  if (state.running) return "workPanel.return.busy";
  if (!state.hasAnswer) return "workPanel.return.nothing";
  return undefined;
}

/** Longest title a returned proposal or output carries. */
export const MAX_RETURN_TITLE_CHARS = 60;

function oneLine(text: string): string {
  return text.replace(/[#>*_`]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * What a side conversation returns: its newest assistant answer as the text,
 * and that answer's first words as the title of the record it becomes.
 */
export function sideReturnContent(
  messages: readonly Pick<UiMessage, "role" | "content">[] | undefined,
): { title: string; text: string } | undefined {
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = (message.content || "").replace(/\r\n?/g, "\n").trim();
    if (!text) continue;
    const line = oneLine(text);
    const cut = line.length > MAX_RETURN_TITLE_CHARS
      ? `${Array.from(line).slice(0, MAX_RETURN_TITLE_CHARS - 1).join("").trimEnd()}…`
      : line;
    return { title: cut || text.slice(0, MAX_RETURN_TITLE_CHARS), text };
  }
  return undefined;
}

/** The pill text: "Return: Summary → Target", the target only for a mode that returns. */
export function agentReturnPillLabel(
  modeLabel: string,
  mode: AgentReturnMode,
  targetTitle: string | undefined,
  text: { pill: (mode: string) => string; pillTarget: (mode: string, target: string) => string },
): string {
  return mode !== "none" && targetTitle
    ? text.pillTarget(modeLabel, targetTitle)
    : text.pill(modeLabel);
}
