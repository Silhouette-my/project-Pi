/**
 * A one-line title for a conversation whose stored title is raw prompt text
 * (e.g. imported Codex sessions start with a "# Files mentioned by the user:"
 * wrapper). Keeps the user's own request when the wrapper names it, drops
 * Markdown heading markers and collapses whitespace.
 */
export function sessionDisplayTitle(title: string | undefined | null): string {
  if (!title) return "";
  let text = title;
  const request = text.match(/##\s*My request:\s*([\s\S]*)$/i);
  if (request?.[1]?.trim()) text = request[1];
  return text
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
