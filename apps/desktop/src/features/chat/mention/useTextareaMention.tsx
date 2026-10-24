/**
 * Conversation mentions for a composer built on a plain `<textarea>` (the
 * detached conversations: side chats, project side conversations, project
 * Agent). The draft stays a string; the mention list rides beside it and the
 * tokens become session links only when the prompt is sent.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { MentionMirror } from "./MentionMirror";
import { MentionPopover } from "./MentionPopover";
import { textareaCaretPoint, type CaretPoint } from "./caret-position";
import {
  backspaceMention,
  detectMentionTrigger,
  flattenMentionGroups,
  insertMention,
  reconcileMentions,
  serializeMentions,
  type MentionRef,
  type MentionRow,
} from "./mention-core";
import { useMentionGroups } from "./useMentionGroups";

type OpenTrigger = { tokenStart: number; query: string; point: CaretPoint };

// Mentions of unsent drafts survive a remount of the surface (a tab switch),
// like the draft text itself. Renderer memory only, never persisted.
const draftMentions = new Map<string, MentionRef[]>();

export type TextareaMention = {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** The textarea's event handlers; `onKeyDown` returns true when it took the key. */
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onSelect: (event: React.SyntheticEvent<HTMLTextAreaElement>) => void;
  onBlur: () => void;
  onCompositionStart: () => void;
  onCompositionEnd: (event: React.CompositionEvent<HTMLTextAreaElement>) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** The draft as the prompt: tokens replaced by session links. */
  serialize: (text: string) => string;
  /** The tile highlight and the popover; render beside the textarea. */
  overlay: ReactNode;
};

export function useTextareaMention({
  draft,
  onDraftChange,
  draftKey,
  sessionId,
  projectPath,
}: {
  draft: string;
  onDraftChange: (text: string) => void;
  /** Names the draft across remounts; the session id, or a caller's own key. */
  draftKey: string;
  /** The conversation being written in; it is never offered. */
  sessionId?: string;
  projectPath?: string;
}): TextareaMention {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mentions, setMentions] = useState<MentionRef[]>(() =>
    reconcileMentions(draft, draftMentions.get(draftKey) ?? []),
  );
  const [trigger, setTrigger] = useState<OpenTrigger | null>(null);
  const [highlight, setHighlight] = useState(0);
  const dismissedAt = useRef<number | null>(null);
  const composing = useRef(false);
  const pendingCaret = useRef<number | null>(null);

  useEffect(() => {
    setMentions((current) => {
      const next = reconcileMentions(draft, current);
      return next.length === current.length ? current : next;
    });
    if (!draft) setTrigger(null);
  }, [draft]);
  useEffect(() => {
    if (mentions.length) draftMentions.set(draftKey, mentions);
    else draftMentions.delete(draftKey);
  }, [draftKey, mentions]);

  const groups = useMentionGroups({
    enabled: trigger !== null,
    query: trigger?.query ?? "",
    currentSessionId: sessionId,
    currentProjectPath: projectPath,
  });
  const rows = useMemo(() => flattenMentionGroups(groups), [groups]);
  const queryKey = trigger ? `${trigger.tokenStart}:${trigger.query}` : "";
  useEffect(() => setHighlight(0), [queryKey]);

  const evaluate = useCallback((textarea: HTMLTextAreaElement) => {
    if (composing.current) return;
    const caret = textarea.selectionStart;
    const found =
      textarea.selectionEnd === caret ? detectMentionTrigger(textarea.value, caret) : null;
    if (!found || dismissedAt.current === found.tokenStart) {
      if (!found) dismissedAt.current = null;
      setTrigger(null);
      return;
    }
    setTrigger({ ...found, point: textareaCaretPoint(textarea, found.tokenStart) });
  }, []);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (pendingCaret.current === null || !textarea) return;
    textarea.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [draft]);

  const close = useCallback(() => {
    if (trigger) dismissedAt.current = trigger.tokenStart;
    setTrigger(null);
  }, [trigger]);

  const pick = (row: MentionRow) => {
    const textarea = textareaRef.current;
    if (!trigger || !textarea) return;
    const edit = insertMention(
      draft,
      trigger,
      textarea.selectionStart,
      { id: row.id, title: row.title },
      mentions,
    );
    pendingCaret.current = edit.caret;
    setMentions(edit.mentions);
    setTrigger(null);
    onDraftChange(edit.text);
    textarea.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.nativeEvent.isComposing) return false;
    if (trigger) {
      const take = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        take();
        if (rows.length) {
          const step = event.key === "ArrowDown" ? 1 : rows.length - 1;
          setHighlight((highlight + step) % rows.length);
        }
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        take();
        const row = rows[Math.min(highlight, rows.length - 1)];
        if (row) pick(row);
        else close();
        return true;
      }
      if (event.key === "Escape") {
        take();
        close();
        return true;
      }
    }
    if (event.key === "Backspace" && mentions.length) {
      const textarea = event.currentTarget;
      if (textarea.selectionStart === textarea.selectionEnd) {
        const edit = backspaceMention(draft, textarea.selectionStart, mentions);
        if (edit) {
          event.preventDefault();
          pendingCaret.current = edit.caret;
          setMentions(edit.mentions);
          onDraftChange(edit.text);
          return true;
        }
      }
    }
    return false;
  };

  const overlay = (
    <>
      <MentionMirror textareaRef={textareaRef} value={draft} mentions={mentions} />
      {trigger ? (
        <MentionPopover
          point={trigger.point}
          groups={groups}
          highlight={Math.min(highlight, Math.max(0, rows.length - 1))}
          onHighlight={setHighlight}
          onPick={pick}
          onClose={close}
        />
      ) : null}
    </>
  );

  return {
    textareaRef,
    onChange: (event) => {
      const textarea = event.target;
      onDraftChange(textarea.value);
      setMentions((current) => reconcileMentions(textarea.value, current));
      evaluate(textarea);
    },
    onSelect: (event) => evaluate(event.currentTarget),
    onBlur: () => setTrigger(null),
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: (event) => {
      composing.current = false;
      evaluate(event.currentTarget);
    },
    handleKeyDown,
    serialize: (text) => serializeMentions(text, mentions),
    overlay,
  };
}
