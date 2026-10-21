import type { ChatGptChatStatus, ChatGptChatProbeDiagnostic } from "@pi-desktop/shared";
import type { Logger } from "./logger";

let documentLogger: Pick<Logger, "log"> | undefined;
/** Only structural facts and public model/effort identifiers cross the page bridge. */
export function conversationRequestFacts(body: Record<string, unknown>, requested: unknown, entry?: { defaultEffort?: string; efforts: string[] }) {
  const model = (value: unknown) => typeof value === "string" && /^(?:gpt-[a-z0-9.-]{1,60}|research|auto)$/.test(value) ? value : undefined;
  const effort = (value: unknown) => typeof value === "string" && ["none", "instant", "minimal", "low", "medium", "high", "xhigh", "extra_high", "extended", "standard", "heavy", "light"].includes(value) ? value : undefined;
  const shape = (value: unknown) => value === undefined ? "absent" : value === null ? "null" : typeof value === "string" ? value.length ? "nonempty_string" : "empty_string" : "other";
  return {
    ...(model(body.model) ? { model: model(body.model) } : {}),
    ...(model(body.requested_default_model) ? { requestedDefaultModel: model(body.requested_default_model) } : {}),
    ...(effort(requested) ? { requestedThinkingEffort: effort(requested) } : {}),
    ...(effort(body.thinking_effort) ? { thinkingEffort: effort(body.thinking_effort) } : {}),
    catalogPresent: entry !== undefined,
    ...(entry ? { catalogEfforts: entry.efforts.map(effort).filter((value): value is string => value !== undefined).slice(0, 16), ...(effort(entry.defaultEffort) ? { catalogDefaultEffort: effort(entry.defaultEffort) } : {}) } : {}),
    conversationId: shape(body.conversation_id), parentMessageId: shape(body.parent_message_id),
    messages: Array.isArray(body.messages) ? body.messages.slice(0, 100).map((raw: unknown) => {
      const message = raw && typeof raw === "object" ? raw as { author?: { role?: unknown }; content?: { parts?: unknown } } : {};
      const role = message.author?.role;
      const parts = message.content?.parts;
      return { role: typeof role === "string" && ["system", "developer", "user", "assistant", "tool"].includes(role) ? role : "other", content: !Array.isArray(parts) ? "other" : parts.some((part) => typeof part === "string" && part.length > 0) ? "nonempty" : parts.length === 0 || parts.every((part) => part === "") ? "empty" : "other" };
    }) : [],
  };
}

/** Pydantic locations may contain user keys: retain only known protocol fields. */
export function conversationValidationErrors(raw: unknown): Array<{ loc: Array<string | number>; type: string }> {
  if (!Array.isArray(raw)) return [];
  const fields = ["body", "messages", "author", "role", "content", "parts", "model", "requested_default_model", "thinking_effort", "conversation_id", "parent_message_id", "action", "metadata", "id", "content_type"];
  const types = ["missing", "string_type", "string_too_short", "string_too_long", "list_type", "dict_type", "model_type", "literal_error", "enum", "extra_forbidden", "uuid_parsing", "uuid_type", "int_type", "bool_type", "value_error", "type_error", "type_error.str", "type_error.list", "value_error.missing"];
  return raw.slice(0, 16).flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const value = item as { loc?: unknown; type?: unknown };
    if (!Array.isArray(value.loc) || typeof value.type !== "string" || !types.includes(value.type)) return [];
    const loc = value.loc.slice(0, 16).map((part: unknown) => typeof part === "number" && Number.isInteger(part) && part >= 0 && part <= 10000 ? part : typeof part === "string" && fields.includes(part) ? part : "unknown");
    return [{ loc, type: value.type }];
  });
}

export type ConversationRequestFacts = ReturnType<typeof conversationRequestFacts>;

export function sanitizeConversationRequestFacts(raw: unknown): ConversationRequestFacts | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as ConversationRequestFacts;
  const facts = conversationRequestFacts({ model: value.model, requested_default_model: value.requestedDefaultModel, thinking_effort: value.thinkingEffort }, value.requestedThinkingEffort, value.catalogPresent === true && Array.isArray(value.catalogEfforts) ? { efforts: value.catalogEfforts, defaultEffort: value.catalogDefaultEffort } : undefined);
  const shapes = ["absent", "null", "nonempty_string", "empty_string", "other"];
  return { ...facts, conversationId: shapes.includes(value.conversationId) ? value.conversationId : "other", parentMessageId: shapes.includes(value.parentMessageId) ? value.parentMessageId : "other", messages: Array.isArray(value.messages) ? value.messages.slice(0, 100).map((message) => ({ role: ["system", "developer", "user", "assistant", "tool"].includes(message?.role) ? message.role : "other", content: ["empty", "nonempty"].includes(message?.content) ? message.content : "other" })) : [] };
}

export type ChatGptConversationDiagnostic = {
  requestId: string;
  stage: "open" | "status" | "page" | "session" | "sdk_load" | "sdk_token" | "chatreq" | "catalog" | "post" | "stream";
  outcome: "started" | "completed" | "failed";
  reason?: string;
  status?: number;
  contentType?: string | null;
  // Fixed allowlisted server error detail, never forwarded to the UI stream.
  detail?: string;
  requestFacts?: ConversationRequestFacts;
  validationErrors?: Array<{ loc: Array<string | number>; type: string }>;
  // Safe chat-requirements shape facts (challenge mode enum, booleans) used
  // to diagnose risk-engine rejections. Never carries token values.
  turnstileRequired?: string;
  powRequested?: boolean;
  powSolved?: boolean;
  requirementsResolved?: boolean;
};

export function logChatGptConversationEvent(value: ChatGptConversationDiagnostic): void {
  const allowedReasons = ["authenticated", "not_authenticated", "cancelled", "page_execution_error", "session_timeout", "session_failed", "session_unauthorized", "session_challenge", "session_content_type", "session_json", "session_invalid", "sdk_load_failed", "sdk_load_timeout", "sdk_unavailable", "sdk_token_failed", "sdk_token_timeout", "sdk_token_invalid", "chatreq_failed", "chatreq_timeout", "chatreq_challenge", "device_missing", "catalog_failed", "thinking_effort_unsupported", "post_failed", "post_http_error", "post_rate_limited", "post_content_type", "post_redirect", "stream_missing", "stream_failed", "unknown"];
  const statusReasons = ["page_load_timeout", "page_probe_timeout", "page_execution_error", "network_error", "html_or_challenge", "unauthenticated", "no_authenticated_user", "expired_session", "invalid_session", "invalid_json", "unexpected_content_type", "http_error", "login_redirect", "page_changed", "document_http_error", "document_challenge", "document_render_gone"];
  const reason = value.reason && (allowedReasons.includes(value.reason) || statusReasons.includes(value.reason) || /^document_load_failed_-?\d+$/.test(value.reason)) ? value.reason : "unknown";
  documentLogger?.log("app", "provider", value.outcome === "failed" ? "warn" : "info", "ChatGPT conversation transport stage", {
    event: "provider.chatgpt.conversation.stage", requestId: value.requestId,
    data: {
      stage: value.stage, outcome: value.outcome,
      ...(value.reason ? { reason } : {}),
      ...(value.status !== undefined ? { status: value.status } : {}),
      ...(value.contentType !== undefined ? { contentType: value.contentType } : {}),
      ...(typeof value.detail === "string" && ["Invalid conversation body", "Unusual activity detected from your device", "Too many requests"].includes(value.detail) ? { detail: value.detail } : {}),
      ...(value.requestFacts ? { requestFacts: sanitizeConversationRequestFacts(value.requestFacts) } : {}),
      ...(value.validationErrors ? { validationErrors: conversationValidationErrors(value.validationErrors) } : {}),
      ...(value.turnstileRequired !== undefined ? { turnstileRequired: value.turnstileRequired } : {}),
      ...(value.powRequested === true ? { powRequested: true } : {}),
      ...(value.powSolved === true ? { powSolved: true } : {}),
      ...(value.requirementsResolved === true ? { requirementsResolved: true } : {}),
    },
  });
}
export type ChatGptDocumentEvent = "navigation" | "response" | "load_failed" | "render_gone" | "popup_denied" | "empty_document" | "auth_response_failed";

export function chatGptDocumentEndpoint(raw: string): string {
  try { const url = new URL(raw); return url.protocol === "https:" || url.protocol === "http:" ? `${url.origin}${url.pathname}` : "unsupported"; }
  catch { return "unknown"; }
}

export function logChatGptDocumentEvent(event: ChatGptDocumentEvent, data: { url: string; status?: number; contentType?: string | null; errorCode?: number; reason?: string }): void {
  const reason = data.reason && ["clean-exit", "abnormal-exit", "killed", "crashed", "oom", "launch-failed", "integrity-failure", "memory-eviction", "no_text_or_controls"].includes(data.reason) ? data.reason : "unknown";
  documentLogger?.log("app", "provider", event === "load_failed" || event === "render_gone" || event === "auth_response_failed" ? "warn" : "info", "ChatGPT browser document diagnostic", {
    event: `provider.chatgpt.document.${event}`,
    data: {
      endpoint: chatGptDocumentEndpoint(data.url),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.contentType !== undefined ? { contentType: data.contentType } : {}),
      ...(data.errorCode !== undefined ? { errorCode: data.errorCode } : {}),
      ...(data.reason !== undefined ? { reason } : {}),
    },
  });
}

/** Explicit projection keeps account payloads and free-form errors out of logs. */
export function createChatGptDiagnosticLogger(logger: Pick<Logger, "log">) {
  documentLogger = logger;
  let previous = "";
  const probe = (value: ChatGptChatProbeDiagnostic) => ({
    endpoint: value.endpoint, status: value.status,
    contentType: value.contentType, reason: value.reason,
  });
  return (status: ChatGptChatStatus): void => {
    const data = {
      state: status.state,
      ...(status.diagnostic ? { diagnostic: {
        ...probe(status.diagnostic),
        ...(status.diagnostic.checks ? { checks: status.diagnostic.checks.map(probe) } : {}),
      } } : {}),
    };
    const serialized = JSON.stringify(data);
    if (serialized === previous) return;
    previous = serialized;
    logger.log("app", "provider", status.state === "error" ? "warn" : "info", "ChatGPT login status changed", {
      event: "provider.chatgpt.auth.status", data,
    });
  };
}
