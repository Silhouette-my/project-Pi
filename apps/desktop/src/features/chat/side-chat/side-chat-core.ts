/**
 * Framework-free rules of chat side chats (ADR side-chats-on-detached-transcripts).
 *
 * Nothing here touches the store, the DOM or i18n: callers pass translated
 * strings and live state in, which keeps every rule directly testable.
 */
import type { SessionSummary, UiMessage } from "@pi-desktop/shared";

/** Longest one-line anchor excerpt the panel header shows. */
export const MAX_ANCHOR_EXCERPT_CHARS = 140;

function cutAtCodePoint(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  // Never cut between a surrogate pair: the tail would render as a lone glyph.
  const whole = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  return `${whole.trimEnd()}…`;
}

/** The collapsed single line the panel header shows for the anchored message. */
export function anchorExcerptLine(text: string): string {
  return cutAtCodePoint(text.replace(/\s+/g, " ").trim(), MAX_ANCHOR_EXCERPT_CHARS);
}

/** What a side chat sends back to the main thread (the parent session). */
export type SideChatReturnMode = "none" | "summary" | "full";
export const SIDE_CHAT_RETURN_MODES: readonly SideChatReturnMode[] = ["none", "summary", "full"];
/** Nothing returns unless the user opts in: Ask has no automatic write-back (PRODUCT P6). */
export const DEFAULT_SIDE_CHAT_RETURN_MODE: SideChatReturnMode = "none";
/** Renderer-only return state of one side-chat tab, keyed by the tab id. */
export type SideChatReturnState = {
  mode: SideChatReturnMode;
  /** `running` while a summary turn is being waited on. */
  status: "idle" | "running";
  /** Translated message of the last failed return, shown until the next attempt. */
  error?: string;
  /** Transcript messages the fork copied from the parent; set before the first prompt. */
  prefixCount?: number;
};

/** Longest summary body a return quote carries. */
export const MAX_SUMMARY_QUOTE_CHARS = 4000;
/** Longest transcript body (all quoted exchanges together) a return quote carries. */
export const MAX_TRANSCRIPT_QUOTE_CHARS = 12000;

/** `text` cut so the result, ellipsis included, never exceeds `max` characters. */
function capWithinLimit(text: string, max: number): string {
  return text.length <= max ? text : cutAtCodePoint(text, max - 1);
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** Prefix every line with `> `; blank lines become a bare `>` to keep the quote whole. */
function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * A Markdown blockquote of a side-chat summary under a bold label, followed by
 * the attribution line. Strings arrive translated, which keeps this module free
 * of i18n. The summary body is capped at 4000 characters.
 */
export function buildSummaryQuote(
  summary: string,
  text: { label: string; attribution: string },
): string {
  const body = capWithinLimit(normalizeText(summary), MAX_SUMMARY_QUOTE_CHARS);
  return `${blockquote(`**${text.label}**\n\n${body}`)}\n\n${text.attribution}`;
}

export type SideChatTurn = { role: "user" | "assistant"; text: string };

/**
 * The user and assistant text exchanged after the fork anchor, in order. Tool
 * rows, thinking and empty messages are skipped. `prefixCount` is the number of
 * transcript messages the fork copied from the parent (fork ids are remapped,
 * so the anchor id cannot be searched in the child).
 */
export function sideChatTurns(
  messages: readonly Pick<UiMessage, "role" | "content">[],
  prefixCount: number,
): SideChatTurn[] {
  const turns: SideChatTurn[] = [];
  for (const message of messages.slice(Math.max(0, prefixCount))) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = normalizeText(message.content || "");
    if (text) turns.push({ role: message.role, text });
  }
  return turns;
}

/**
 * A quoted transcript with role labels. The quoted exchanges are capped at
 * 12000 characters in total: the newest ones are kept whole, older ones are
 * dropped and the quote says how many (`truncated`), so the cut is visible.
 */
export function buildTranscriptQuote(
  turns: readonly SideChatTurn[],
  text: {
    label: string;
    attribution: string;
    roles: Record<SideChatTurn["role"], string>;
    truncated: (omitted: number) => string;
  },
  limit = MAX_TRANSCRIPT_QUOTE_CHARS,
): string {
  const kept: string[] = [];
  let remaining = limit;
  for (let index = turns.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const block = `**${text.roles[turns[index].role]}:** ${turns[index].text}`;
    if (block.length <= remaining) {
      kept.unshift(block);
      remaining -= block.length;
      continue;
    }
    // One message larger than what is left: keep its start only if nothing
    // newer fits, otherwise stop at the previous whole message.
    if (kept.length === 0) kept.unshift(capWithinLimit(block, remaining));
    break;
  }
  const omitted = turns.length - kept.length;
  const parts = [`**${text.label}**`];
  if (omitted > 0) parts.push(`_${text.truncated(omitted)}_`);
  parts.push(...kept);
  return `${blockquote(parts.join("\n\n"))}\n\n${text.attribution}`;
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

export type SideChatReturnBlockReason =
  | "sideChat.returnNone"
  | "sideChat.returnNoChild"
  | "sideChat.returnBusy"
  | "sideChat.returnEmpty";

/**
 * Why "Return to main thread" is unavailable, in the order the user can fix
 * it: pick a mode, send a first message, wait for the reply, then say more.
 */
export function sideChatReturnBlockReason(state: {
  mode: SideChatReturnMode;
  hasChild: boolean;
  childRunning: boolean;
  turnCount: number;
}): SideChatReturnBlockReason | undefined {
  if (state.mode === "none") return "sideChat.returnNone";
  if (!state.hasChild) return "sideChat.returnNoChild";
  if (state.childRunning) return "sideChat.returnBusy";
  if (state.turnCount === 0) return "sideChat.returnEmpty";
  return undefined;
}

export type SideChatReturnFailure = "busy" | "rejected" | "timeout" | "noAnswer";

export class SideChatReturnError extends Error {
  readonly failure: SideChatReturnFailure;
  constructor(failure: SideChatReturnFailure) {
    super(`side chat return failed: ${failure}`);
    this.name = "SideChatReturnError";
    this.failure = failure;
  }
}

export type SideChatSummaryDeps = {
  /** Whether the side chat's own turn is running right now. */
  isRunning: () => boolean;
  /** The side chat's live transcript. */
  messages: () => readonly UiMessage[];
  /** Notify on every store change; returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** Send the summary prompt into the side chat. Resolves false when it was not accepted. */
  send: () => Promise<boolean>;
  timeoutMs: number;
  /** Injectable for tests. */
  timers?: {
    set: (callback: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  };
  /** Stops waiting (the tab closed); the promise then never settles. */
  signal?: AbortSignal;
};

/**
 * Ask the side chat for a summary and wait for that turn: `running` must go
 * true and then false, and the newest assistant answer must be a new one.
 * Rejects with a `SideChatReturnError` (busy / rejected / timeout / noAnswer).
 * The subscription is taken before the prompt is sent so a fast turn is seen.
 */
export function runSideChatSummary(deps: SideChatSummaryDeps): Promise<string> {
  if (deps.isRunning()) return Promise.reject(new SideChatReturnError("busy"));
  const timers = deps.timers ?? {
    set: (callback, ms) => setTimeout(callback, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const newest = (messages: readonly UiMessage[]) => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant" && (message.content || "").trim()) return message;
    }
    return undefined;
  };
  const before = newest(deps.messages());
  return new Promise<string>((resolve, reject) => {
    let sawRunning = false;
    let settled = false;
    let unsubscribe = () => {};
    let timer: unknown;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      timers.clear(timer);
      deps.signal?.removeEventListener("abort", onAbort);
      finish();
    };
    const onAbort = () => settle(() => {});
    const check = () => {
      if (settled) return;
      if (deps.isRunning()) {
        sawRunning = true;
        return;
      }
      if (!sawRunning) return;
      const answer = newest(deps.messages());
      if (!answer || (before && answer.id === before.id && answer.content === before.content)) {
        settle(() => reject(new SideChatReturnError("noAnswer")));
        return;
      }
      settle(() => resolve(answer.content));
    };
    if (deps.signal?.aborted) return;
    deps.signal?.addEventListener("abort", onAbort, { once: true });
    unsubscribe = deps.subscribe(check);
    timer = timers.set(
      () => settle(() => reject(new SideChatReturnError("timeout"))),
      deps.timeoutMs,
    );
    deps.send().then(
      (accepted) => {
        if (!accepted) settle(() => reject(new SideChatReturnError("rejected")));
        else check();
      },
      (error) => settle(() => reject(error)),
    );
  });
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
