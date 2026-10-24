import { useLayoutEffect, useRef, type RefObject } from "react";
import { findMentionSpans, type MentionRef } from "./mention-core";
import "./mention.css";

const COPIED = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "letterSpacing",
  "lineHeight",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "boxSizing",
] as const;

/** Paints the quiet tile behind each `@title` token of a plain textarea. */
export function MentionMirror({
  textareaRef,
  value,
  mentions,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  mentions: readonly MentionRef[];
}) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const spans = findMentionSpans(value, mentions);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!textarea || !mirror) return;
    const style = getComputedStyle(textarea);
    for (const name of COPIED) mirror.style[name] = style[name];
    mirror.style.left = `${textarea.offsetLeft}px`;
    mirror.style.top = `${textarea.offsetTop}px`;
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.style.height = `${textarea.clientHeight}px`;
    mirror.scrollTop = textarea.scrollTop;
    const sync = () => {
      mirror.scrollTop = textarea.scrollTop;
    };
    textarea.addEventListener("scroll", sync);
    return () => textarea.removeEventListener("scroll", sync);
  });
  if (!spans.length) return null;
  const parts: React.ReactNode[] = [];
  let at = 0;
  spans.forEach((span, index) => {
    if (span.start > at) parts.push(value.slice(at, span.start));
    parts.push(<mark key={index}>{value.slice(span.start, span.end)}</mark>);
    at = span.end;
  });
  parts.push(value.slice(at), "\n");
  return (
    <div ref={mirrorRef} className="mention-mirror" aria-hidden="true">
      {parts}
    </div>
  );
}
