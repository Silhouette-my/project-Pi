/**
 * Framework-free rules of chat side chats (ADR side-chats-on-detached-transcripts).
 *
 * Nothing here touches the store, the DOM or i18n: callers pass translated
 * strings and live state in, which keeps every rule directly testable.
 */
import type { SessionSummary, UiMessage } from "@pi-desktop/shared";

/** Longest excerpt a quote carries; longer text is cut and marked with an ellipsis. */
export const MAX_QUOTE_CHARS = 2000;
/** Longest one-line anchor excerpt the panel header shows. */
export const MAX_ANCHOR_EXCERPT_CHARS = 140;

function cutAtCodePoint(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  // Never cut between a surrogate pair: the tail would render as a lone glyph.
  const whole = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  return `${whole.trimEnd()}…`;
}

export function quoteExcerpt(text: string, limit = MAX_QUOTE_CHARS): string {
  return cutAtCodePoint(text.replace(/\r\n?/g, "\n").trim(), limit);
}

/** The collapsed single line the panel header shows for the anchored message. */
export function anchorExcerptLine(text: string): string {
  return cutAtCodePoint(text.replace(/\s+/g, " ").trim(), MAX_ANCHOR_EXCERPT_CHARS);
}

/**
 * A Markdown blockquote of the excerpt followed by its attribution line. The
 * attribution arrives translated, which keeps this module free of i18n.
 */
export function buildQuoteText(answer: string, attribution: string): string {
  const body = quoteExcerpt(answer)
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  return `${body}\n\n${attribution}`;
}

/** The newest assistant message that carries visible text, if any. */
export function newestAssistantAnswer(messages: readonly UiMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && (message.content || "").trim()) {
      return message.content;
    }
  }
  return undefined;
}

export type SideChatBlockReason = "sideChat.parentBusy" | "sideChat.readOnly";

/**
 * Why the first Send is unavailable. Only the first Send forks, so only the
 * parent's state matters; an existing child keeps its own queue and Stop rules.
 */
export function sideChatFirstSendBlockReason(
  parent: Pick<SessionSummary, "readOnlyReason" | "capabilities"> | undefined,
  parentRunning: boolean,
): SideChatBlockReason | undefined {
  if (!parent) return "sideChat.readOnly";
  if (parentRunning || parent.readOnlyReason === "busy") return "sideChat.parentBusy";
  if (parent.readOnlyReason || parent.capabilities?.canEditMessages === false) {
    return "sideChat.readOnly";
  }
  return undefined;
}

export type SideChatSendDeps = {
  /** Fork the child from the anchor without activating it. Resolves its id. */
  create: () => Promise<string>;
  /** Make the child's live transcript readable. A failure never blocks the send. */
  attach: (childId: string) => Promise<void>;
  /** Send to the named child. Resolves false when the prompt was not accepted. */
  send: (childId: string, text: string) => Promise<boolean>;
  /** Runs once per created child, before the first prompt is sent. */
  created?: (childId: string) => void;
};

/**
 * The first-send lifecycle (Issue #421 semantics).
 *
 * `key` is the tab id. The first Send creates the child; concurrent Sends share
 * that one creation. A creation that fails leaves nothing behind so the next
 * Send retries it. A creation that succeeded is remembered even when the prompt
 * is then rejected, so the retry sends to the same child instead of forking
 * another one.
 */
export function createSideChatSender() {
  const children = new Map<string, string>();
  const creating = new Map<string, Promise<string>>();

  async function ensureChild(key: string, known: string | undefined, deps: SideChatSendDeps) {
    const existing = known ?? children.get(key);
    if (existing) {
      children.set(key, existing);
      return existing;
    }
    let pending = creating.get(key);
    if (!pending) {
      const created = (async () => {
        const childId = await deps.create();
        children.set(key, childId);
        deps.created?.(childId);
        return childId;
      })();
      pending = created;
      creating.set(key, created);
      const clear = () => {
        if (creating.get(key) === created) creating.delete(key);
      };
      created.then(clear, clear);
    }
    return pending;
  }

  return {
    /** Resolves the child id once the prompt was accepted; throws otherwise. */
    async send(
      key: string,
      text: string,
      deps: SideChatSendDeps,
      options: { known?: string; rejected: string },
    ): Promise<string> {
      const childId = await ensureChild(key, options.known, deps);
      await deps.attach(childId).catch(() => {});
      if (!(await deps.send(childId, text))) throw new Error(options.rejected);
      return childId;
    },
    childOf: (key: string) => children.get(key),
    /** Forget a tab that no longer exists; the durable child session stays. */
    forget(key: string) {
      children.delete(key);
      creating.delete(key);
    },
    keys: () => [...children.keys()],
  };
}
