/**
 * Parsing for the ` ```visualize ` fence an assistant message uses to place a
 * visualization card in the transcript.
 *
 * Grammar (deliberately a fenced block, not the official host's inline
 * `visualize{…}` syntax, which would collide with ordinary prose):
 *
 *   ```visualize
 *   {"path":"/absolute/path/to/visual.html","mode":"wide"}
 *   ```
 *
 * The fence body is one JSON object. `path` is required and absolute;
 * `mode` is optional and only `"wide"` is meaningful; `title` is an optional
 * display label. Anything else falls back to a plain code block, which is
 * also what a half-typed fence shows while streaming.
 */

export type VisualizeFenceSpec = {
  path: string;
  mode: "wide" | undefined;
  title: string | undefined;
};

/** True when the fence payload names an absolute file path. */
function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value);
}

/**
 * Parse one fence body, or return null when it is not a valid reference.
 * Callers must only invoke this once the fence is closed; an unclosed fence
 * is still streaming text.
 */
export function parseVisualizeFence(source: string): VisualizeFenceSpec | null {
  let record: unknown;
  try {
    record = JSON.parse(source);
  } catch {
    return null;
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }
  const { path, mode, title } = record as Record<string, unknown>;
  if (typeof path !== "string" || !path.trim() || !isAbsolutePath(path)) {
    return null;
  }
  return {
    path: path.trim(),
    mode: mode === "wide" ? "wide" : undefined,
    title:
      typeof title === "string" && title.trim() ? title.trim() : undefined,
  };
}
