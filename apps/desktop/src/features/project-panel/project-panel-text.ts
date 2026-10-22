import type { ProjectWorkflowSnapshot, SessionSummary, UiMessage } from "@pi-desktop/shared";

/**
 * Framework-free rules for moving words between the project Agent and the
 * project's conversation threads. Everything here is user-initiated and
 * UI-mediated: the Agent has no tools, so nothing in this module lets it reach
 * a thread by itself. Callers pass translated strings and live state in.
 */

/** Longest quote or forwarded block; longer text is cut and marked with an ellipsis. */
export const MAX_FORWARD_CHARS = 8000;

export type ExchangeCount = 1 | 3 | "all";
export type SendContent = { kind: "latest" } | { kind: "exchanges"; count: ExchangeCount };

export type Exchange = { user: string; assistant: string };

function visible(message: UiMessage): string {
  return (message.content || "").replace(/\r\n?/g, "\n").trim();
}

function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  // Never cut inside a surrogate pair: the tail would render as a lone glyph.
  const whole = /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
  return `${whole.trimEnd()}…`;
}

/** The newest assistant message that carries visible text. */
export function latestAnswer(messages: readonly UiMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && visible(message)) return visible(message);
  }
  return undefined;
}

/**
 * The transcript as user/assistant exchanges. A user message opens one;
 * assistant messages that follow (a turn can produce several) join it, so one
 * exchange is one thing the user asked and everything said back.
 */
export function exchangesOf(messages: readonly UiMessage[]): Exchange[] {
  const exchanges: Exchange[] = [];
  for (const message of messages) {
    const text = visible(message);
    if (!text) continue;
    if (message.role === "user") {
      exchanges.push({ user: text, assistant: "" });
    } else if (message.role === "assistant") {
      const last = exchanges[exchanges.length - 1];
      if (last) last.assistant = last.assistant ? `${last.assistant}\n\n${text}` : text;
      else exchanges.push({ user: "", assistant: text });
    }
  }
  return exchanges;
}

export function lastExchanges(messages: readonly UiMessage[], count: ExchangeCount): Exchange[] {
  const all = exchangesOf(messages);
  return count === "all" ? all : all.slice(-count);
}

export function renderExchanges(
  exchanges: readonly Exchange[],
  labels: { user: string; agent: string },
): string {
  return exchanges
    .map((exchange) =>
      [
        exchange.user ? `${labels.user}: ${exchange.user}` : "",
        exchange.assistant ? `${labels.agent}: ${exchange.assistant}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
    .filter(Boolean)
    .join("\n\n");
}

/** What the dialog previews: the latest answer, or the last N exchanges. */
export function buildSendContent(
  messages: readonly UiMessage[],
  content: SendContent,
  labels: { user: string; agent: string },
): string {
  const body =
    content.kind === "latest"
      ? (latestAnswer(messages) ?? "")
      : renderExchanges(lastExchanges(messages, content.count), labels);
  return cut(body, MAX_FORWARD_CHARS);
}

/** The message a thread receives: a short attribution line, then the content. */
export function withAttribution(attribution: string, body: string): string {
  const text = body.trim();
  return text ? `${attribution.trim()}\n\n${text}` : "";
}

/** A Markdown blockquote of an answer followed by its attribution line. */
export function buildQuotedAnswer(answer: string, attribution: string): string {
  const body = cut(answer.replace(/\r\n?/g, "\n").trim(), MAX_FORWARD_CHARS)
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  return `${body}\n\n${attribution}`;
}

export type ConversationTarget = {
  sessionId: string;
  title: string;
  kind: "workstream" | "side" | "chat";
  /** Workstream title for a main or side thread. */
  workstream?: string;
  purpose?: "ask" | "explore" | "work";
};

/**
 * Threads a project Agent answer can be sent to or read from: workstream main
 * sessions, side conversations, and the project's other chats. The Agent's own
 * session and archived threads are never offered.
 */
export function listConversationTargets({
  snapshot,
  projectId,
  sessions,
  inProject,
  untitled,
}: {
  snapshot: ProjectWorkflowSnapshot | null;
  projectId: string;
  sessions: readonly Pick<SessionSummary, "id" | "title" | "projectPath">[];
  /** Whether a session's project path lies in this project's roots. */
  inProject: (projectPath: string | undefined) => boolean;
  untitled: string;
}): ConversationTarget[] {
  if (!snapshot) return [];
  const agentIds = new Set((snapshot.projectAgents ?? []).map((agent) => agent.sessionId));
  const titleOf = (id: string) => sessions.find((session) => session.id === id)?.title?.trim();
  const seen = new Set<string>(agentIds);
  const targets: ConversationTarget[] = [];
  const add = (target: ConversationTarget) => {
    if (seen.has(target.sessionId)) return;
    seen.add(target.sessionId);
    targets.push(target);
  };
  const workstreams = snapshot.workstreams
    .filter((item) => item.projectId === projectId)
    .sort((left, right) => left.order - right.order);
  for (const workstream of workstreams) {
    if (!workstream.mainSessionId) continue;
    add({
      sessionId: workstream.mainSessionId,
      title: titleOf(workstream.mainSessionId) || workstream.title || untitled,
      kind: "workstream",
      workstream: workstream.title,
    });
  }
  const sides = snapshot.conversations
    .filter((item) => item.projectId === projectId && !item.archived)
    .sort((left, right) => left.order - right.order);
  for (const side of sides) {
    add({
      sessionId: side.sessionId,
      title: titleOf(side.sessionId) || untitled,
      kind: side.relation === "main" ? "workstream" : "side",
      workstream: workstreams.find((item) => item.id === side.workstreamId)?.title,
      purpose: side.purpose,
    });
  }
  for (const session of sessions) {
    if (!inProject(session.projectPath)) continue;
    add({ sessionId: session.id, title: session.title?.trim() || untitled, kind: "chat" });
  }
  return targets;
}
