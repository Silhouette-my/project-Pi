import type { ChatGptChatModelCatalog } from "@pi-desktop/shared";

type AccountBrowser = { executeAccountScript(script: string): Promise<unknown> };

export async function listChatGptChatModels(browser: AccountBrowser): Promise<ChatGptChatModelCatalog> {
  return await browser.executeAccountScript(chatGptChatModelsScript()) as ChatGptChatModelCatalog;
}

export function chatGptChatModelsScript(): string {
  return `(${pageModels.toString()})(${parseChatGptChatModels.toString()})`;
}

export async function pageModels(parse: typeof parseChatGptChatModels): Promise<ChatGptChatModelCatalog> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  const readJson = async (response: Response, endpoint: string): Promise<unknown> => {
    const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (response.redirected || response.headers.get("cf-mitigated") === "challenge" || contentType === "text/html") {
      throw new Error("ChatGPT verification is required. Open Log in to ChatGPT and complete verification.");
    }
    if (!response.ok) throw new Error(`ChatGPT account catalog failed (${endpoint}, HTTP ${response.status}, ${contentType ?? "no content type"}).`);
    if (contentType !== "application/json") throw new Error("ChatGPT account catalog returned an unexpected content type.");
    try { return await response.json(); }
    catch { throw new Error("ChatGPT account catalog returned invalid JSON."); }
  };
  try {
    // Match the consumer client's SendIfAvailable authentication. The token is
    // acquired and used only in this page; only projected model metadata leaves.
    const session = await readJson(await fetch("/api/auth/session", {
      credentials: "include", headers: { Accept: "application/json" }, signal: controller.signal,
    }), "/api/auth/session");
    if (!session || typeof session !== "object" || Array.isArray(session)) throw new Error("ChatGPT session is unavailable. Log in again.");
    const data = session as { user?: { id?: unknown; email?: unknown }; expires?: unknown; accessToken?: unknown };
    if (!data.user || typeof data.user !== "object" || ![data.user.id, data.user.email].some((value) => typeof value === "string" && value.length > 0)) throw new Error("ChatGPT session expired. Log in again.");
    if (data.expires !== undefined && (typeof data.expires !== "string" || !Number.isFinite(Date.parse(data.expires)) || Date.parse(data.expires) <= Date.now())) throw new Error("ChatGPT session expired. Log in again.");
    const token = data.accessToken;
    const response = await fetch("/backend-api/models?supports_model_picker_upgrade_presets=true", {
      credentials: "include", signal: controller.signal,
      headers: { Accept: "application/json", ...(typeof token === "string" && token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    const catalog = parse(await readJson(response, "/backend-api/models"));
    // Request defaults belong to this authenticated page, not persisted Host
    // configuration. Reload/logout discards them along with the page context.
    (window as unknown as { __piChatModelDefaults: Map<string, { defaultEffort?: string; efforts: string[] }> }).__piChatModelDefaults = new Map(
      catalog.models.map((model) => [model.id, { ...(model.defaultThinkingEffort ? { defaultEffort: model.defaultThinkingEffort } : {}), efforts: model.thinkingEfforts ?? [] }] as [string, { defaultEffort?: string; efforts: string[] }]),
    );
    return catalog;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("ChatGPT account model request timed out. Retry the model refresh.");
    throw error;
  } finally { clearTimeout(timeout); }
}

/** Project the account's consumer catalog; names never determine request IDs. */
export function parseChatGptChatModels(raw: unknown): ChatGptChatModelCatalog {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid ChatGPT account model catalog.");
  const catalog = raw as Record<string, unknown>;
  if (!Array.isArray(catalog.models)) throw new Error("ChatGPT account model catalog has no models list.");
  const seen = new Set<string>();
  const models: ChatGptChatModelCatalog["models"] = [];
  for (const rawModel of catalog.models) {
    if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) throw new Error("Invalid ChatGPT account model entry.");
    const model = rawModel as Record<string, unknown>;
    if (typeof model.slug !== "string" || !model.slug.trim()) throw new Error("ChatGPT account model entry has no request slug.");
    if (seen.has(model.slug)) continue;
    seen.add(model.slug);
    // Effort entries are server-shaped objects ({ thinking_effort }) in current
    // catalogs; plain strings are accepted defensively. Unknown values stay out.
    const efforts = Array.isArray(model.thinking_efforts)
      ? [...new Set(model.thinking_efforts
        .map((entry) => typeof entry === "string" ? entry : typeof (entry as Record<string, unknown> | null)?.thinking_effort === "string" ? String((entry as Record<string, unknown>).thinking_effort) : "")
        .filter((value) => value !== ""))]
      : [];
    models.push({
      id: model.slug,
      name: typeof model.title === "string" && model.title.trim() ? model.title : model.slug,
      ...(typeof model.description === "string" ? { description: model.description } : {}),
      ...(typeof model.default_thinking_effort === "string" && model.default_thinking_effort
        ? { defaultThinkingEffort: model.default_thinking_effort } : {}),
      ...(efforts.length ? { thinkingEfforts: efforts } : {}),
    });
  }
  if (models.length === 0) throw new Error("ChatGPT returned no available account models. Check your account in ChatGPT.");
  return {
    models,
    ...(typeof catalog.default_model_slug === "string" && seen.has(catalog.default_model_slug)
      ? { defaultModelId: catalog.default_model_slug } : {}),
  };
}
