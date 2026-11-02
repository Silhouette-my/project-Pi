/**
 * Framework-free rules of conversation mentions (ADR conversation-mention).
 *
 * A mention is the way a Composer draft names another conversation: the user
 * types `@`, picks a row, and the draft holds an atomic `@<title>` token. What
 * the model receives is not this module's business: at send time the token
 * becomes the existing `pi-desktop://session/<id>` link, and Electron main
 * attaches the bounded excerpt (`electron/main/session-references.ts`).
 *
 * Nothing here touches the store, the DOM or i18n. Callers pass sessions and
 * translated strings in, which keeps every rule directly testable.
 */
import { formatSessionLink, type SessionSummary } from "@pi-desktop/shared";
import { isRemoteSession } from "../../../lib/remote-session-safety";

/** A conversation a draft mentions. The title is what the token shows. */
export type MentionRef = { id: string; title: string };

export type MentionGroupId = "project" | "recent" | "other";

export type MentionRow = {
  id: string;
  title: string;
  /** Muted second column: the project name, or the side chat's parent. */
  secondary: string;
  group: MentionGroupId;
};

export type MentionGroup = { id: MentionGroupId; rows: MentionRow[] };

/** Rows the list holds before the user has to narrow the query. */
export const MENTION_ROW_LIMIT = 40;
/** Rows the popover shows before it scrolls. */
export const MENTION_VISIBLE_ROWS = 8;

export type MentionSource = Pick<
  SessionSummary,
  "id" | "title" | "projectPath" | "updatedAt" | "source" | "scheduledRun"
>;

export const MENTION_GROUP_ORDER: readonly MentionGroupId[] = ["project", "recent", "other"];

function projectKey(path: string | undefined | null): string {
  const value = path?.trim();
  if (!value) return "";
  return value.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

function projectLabel(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function updatedTime(session: MentionSource): number {
  const time = Date.parse(session.updatedAt);
  return Number.isFinite(time) ? time : 0;
}

/**
 * The conversations the user can mention from `current`, grouped like the
 * sidebar: this project, plain chats, other projects. Remote and automation
 * transcripts are never offered, and neither is the conversation being
 * written in. Empty groups are dropped.
 */
export function buildMentionCandidates({
  sessions,
  currentSessionId,
  currentProjectPath,
  query,
  sideChatParents = {},
  sideLabel,
}: {
  sessions: readonly MentionSource[];
  currentSessionId?: string | null;
  currentProjectPath?: string | null;
  query: string;
  /** Side chat session id → its parent's session id. */
  sideChatParents?: Readonly<Record<string, string>>;
  /** `侧聊 · <parent>`, translated by the caller. */
  sideLabel: (parentTitle: string) => string;
}): MentionGroup[] {
  const needle = query.trim().toLowerCase();
  const currentKey = projectKey(currentProjectPath);
  const titleOf = new Map<string, string>();
  for (const session of sessions) titleOf.set(session.id, session.title.trim());
  const buckets: Record<MentionGroupId, MentionRow[]> = { project: [], recent: [], other: [] };
  const ordered = [...sessions].sort((a, b) => updatedTime(b) - updatedTime(a));
  for (const session of ordered) {
    if (session.id === currentSessionId) continue;
    if (isRemoteSession(session) || session.scheduledRun === true) continue;
    const title = session.title.trim() || session.id.slice(0, 8);
    if (needle && !title.toLowerCase().includes(needle)) continue;
    const key = projectKey(session.projectPath);
    const group: MentionGroupId = !key ? "recent" : key === currentKey ? "project" : "other";
    const parentTitle = titleOf.get(sideChatParents[session.id] ?? "");
    const secondary = parentTitle
      ? sideLabel(parentTitle)
      : session.projectPath && key
        ? projectLabel(session.projectPath)
        : "";
    buckets[group].push({ id: session.id, title, secondary, group });
  }
  const groups: MentionGroup[] = [];
  let remaining = MENTION_ROW_LIMIT;
  for (const id of MENTION_GROUP_ORDER) {
    const rows = buckets[id].slice(0, remaining);
    if (!rows.length) continue;
    remaining -= rows.length;
    groups.push({ id, rows });
  }
  return groups;
}

export function flattenMentionGroups(groups: readonly MentionGroup[]): MentionRow[] {
  return groups.flatMap((group) => group.rows);
}

export type MentionTrigger = {
  /** Index of the `@` in the draft. */
  tokenStart: number;
  /** The text typed after it. */
  query: string;
};

/**
 * The open `@` token before the caret: `@` at the start or after whitespace,
 * followed by no whitespace and no second `@`. `@` inside a word (an email
 * address) is text, not a trigger.
 */
export function detectMentionTrigger(value: string, caret: number): MentionTrigger | null {
  if (caret < 0 || caret > value.length) return null;
  let index = caret;
  while (index > 0) {
    const char = value[index - 1];
    if (/\s/.test(char)) return null;
    if (char === "@") {
      const before = index - 2;
      if (before >= 0 && !/\s/.test(value[before])) return null;
      return { tokenStart: index - 1, query: value.slice(index, caret) };
    }
    index -= 1;
  }
  return null;
}

export type MentionEdit = { text: string; caret: number; mentions: MentionRef[] };

const tokenOf = (ref: MentionRef) => `@${ref.title}`;

/** Replace the open `@query` with the picked conversation's token. */
export function insertMention(
  text: string,
  trigger: MentionTrigger,
  caret: number,
  ref: MentionRef,
  mentions: readonly MentionRef[],
): MentionEdit {
  const insert = `${tokenOf(ref)} `;
  const next = text.slice(0, trigger.tokenStart) + insert + text.slice(caret);
  return {
    text: next,
    caret: trigger.tokenStart + insert.length,
    mentions: mentions.some((item) => item.id === ref.id) ? [...mentions] : [...mentions, ref],
  };
}

/** Drop mentions whose token the user has edited away. */
export function reconcileMentions(text: string, mentions: readonly MentionRef[]): MentionRef[] {
  const kept = mentions.filter((ref) => text.includes(tokenOf(ref)));
  return kept.length === mentions.length ? [...mentions] : kept;
}

/**
 * Backspace right after a token (or after the space the picker adds) removes
 * the whole token. `null` leaves the key to the textarea.
 */
export function backspaceMention(
  text: string,
  caret: number,
  mentions: readonly MentionRef[],
): MentionEdit | null {
  const before = text.slice(0, caret);
  for (const ref of mentions) {
    for (const token of [`${tokenOf(ref)} `, tokenOf(ref)]) {
      if (!before.endsWith(token)) continue;
      const start = before.length - token.length;
      if (start > 0 && !/\s/.test(before[start - 1])) continue;
      const next = before.slice(0, start) + text.slice(caret);
      return { text: next, caret: start, mentions: reconcileMentions(next, mentions) };
    }
  }
  return null;
}

/** Text and mention tokens as they sit in `text`, in order. */
export type MentionSpan = { start: number; end: number; ref: MentionRef };

export function findMentionSpans(text: string, mentions: readonly MentionRef[]): MentionSpan[] {
  const spans: MentionSpan[] = [];
  // Longest title first, so `@Plan` never claims the front of `@Plan B`.
  const refs = [...mentions].sort((a, b) => b.title.length - a.title.length);
  for (const ref of refs) {
    const token = tokenOf(ref);
    let from = 0;
    for (;;) {
      const start = text.indexOf(token, from);
      if (start === -1) break;
      from = start + token.length;
      const end = start + token.length;
      if (start > 0 && !/\s/.test(text[start - 1])) continue;
      if (spans.some((span) => start < span.end && end > span.start)) continue;
      spans.push({ start, end, ref });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * The prompt text for a draft with mentions: each token becomes the session
 * link main resolves into the model's context. A separating space keeps the
 * link from fusing with the word after it.
 */
export function serializeMentions(text: string, mentions: readonly MentionRef[]): string {
  const spans = findMentionSpans(text, mentions);
  if (!spans.length) return text;
  let out = "";
  let at = 0;
  for (const span of spans) {
    out += text.slice(at, span.start) + formatSessionLink(span.ref.id);
    at = span.end;
    const next = text[at];
    if (next && !/\s/.test(next)) out += " ";
  }
  return out + text.slice(at);
}
