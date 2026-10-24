/**
 * Where the caret sits on screen for a plain `<textarea>`, which exposes no
 * geometry of its own. A hidden twin with the same box and text metrics is
 * laid out and the caret's marker measured in it.
 */
const COPIED_STYLES = [
  "boxSizing",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
] as const;

export type CaretPoint = { x: number; y: number; height: number };

/** Viewport coordinates of the top of the caret's line at `index`. */
export function textareaCaretPoint(textarea: HTMLTextAreaElement, index: number): CaretPoint {
  const rect = textarea.getBoundingClientRect();
  const style = getComputedStyle(textarea);
  const twin = document.createElement("div");
  for (const name of COPIED_STYLES) twin.style[name] = style[name];
  twin.style.position = "fixed";
  twin.style.left = `${rect.left}px`;
  twin.style.top = `${rect.top}px`;
  twin.style.width = `${rect.width}px`;
  twin.style.visibility = "hidden";
  twin.style.whiteSpace = "pre-wrap";
  twin.style.overflowWrap = "break-word";
  twin.textContent = textarea.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = "​";
  twin.appendChild(marker);
  document.body.appendChild(twin);
  const point = marker.getBoundingClientRect();
  twin.remove();
  const lineHeight = Number.parseFloat(style.lineHeight);
  return {
    x: point.left,
    y: point.top - textarea.scrollTop,
    height: Number.isFinite(lineHeight) ? lineHeight : point.height,
  };
}
