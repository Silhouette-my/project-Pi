/**
 * Model-route observation for ChatGPT consumer streams (silent-downgrade radar).
 * Mid-stream `message.metadata.model_slug` values are request-side echoes and
 * stay constant for the whole turn; only a `server_ste_metadata` node proves
 * which model actually executed. Mirrors the exec/echo split validated by the
 * chatgpt-model-meter userscript: identification is triple-fold (containing
 * path, node type, or STE's own characteristic fields), and content fields are
 * skipped so long answers are never walked.
 */
export const STE_NAME = /server_ste_metadata|ste_metadata/;
const STE_HINTS = ["requested_model_experience", "did_auto_switch_to_reasoning", "is_autoswitcher_enabled", "server_ttfvt_ms", "turn_use_case"];
const FLAG_KEYS = ["product_experience", "requested_model_experience", "did_auto_switch_to_reasoning", "is_autoswitcher_enabled", "auto_switcher_race_winner", "turn_use_case", "plan_type", "server_ttfvt_ms", "cluster_region"];
const SKIP = new Set(["content", "parts", "text", "prompt", "tools", "attachments", "safe_urls", "citations", "thoughts", "search_result_groups", "image_results", "finished_text", "initial_text", "blocked_urls", "aggregate_result"]);
const SLUG = /^[\w.:+-]{1,80}$/;
const MAX_DEPTH = 14;

export type ChatGptModelRoute = { exec: string[]; flags: Record<string, string | number | boolean | null> };

export function createChatGptModelRouteObserver(): { observe(value: unknown): void; result(): ChatGptModelRoute } {
  const exec = new Set<string>();
  const flags: Record<string, string | number | boolean | null> = {};
  const walk = (node: unknown, depth: number, path: string, inherited: boolean): void => {
    if (depth > MAX_DEPTH || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 200)) walk(item, depth + 1, `${path}[]`, inherited);
      return;
    }
    const record = node as Record<string, unknown>;
    const ste = inherited || STE_NAME.test(path) || (typeof record.type === "string" && STE_NAME.test(record.type)) || STE_HINTS.some((hint) => hint in record);
    if (ste) {
      for (const key of FLAG_KEYS) {
        const value = record[key];
        if (key in record && (value === null || typeof value !== "object")) flags[key] = value as string | number | boolean | null;
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (SKIP.has(key)) continue;
      if (key === "model_slug") {
        // Echo slugs outside an STE context replay the request and are never
        // execution evidence.
        if (ste && typeof value === "string" && SLUG.test(value)) exec.add(value);
        continue;
      }
      if (typeof value === "object" && value !== null) walk(value, depth + 1, path ? `${path}.${key}` : key, ste);
    }
  };
  return {
    observe: (value: unknown) => { walk(value, 0, "", false); },
    result: () => ({ exec: [...exec], flags }),
  };
}
