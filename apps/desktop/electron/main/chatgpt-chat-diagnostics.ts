import type { ChatGptChatStatus, ChatGptChatProbeDiagnostic } from "@pi-desktop/shared";
import type { Logger } from "./logger";

let documentLogger: Pick<Logger, "log"> | undefined;
export type ChatGptConversationDiagnostic = {
  requestId: string;
  stage: "open" | "status" | "page" | "session" | "sdk_load" | "sdk_token" | "chatreq" | "catalog" | "post" | "stream";
  outcome: "started" | "completed" | "failed";
  reason?: string;
  status?: number;
  contentType?: string | null;
  // Server-provided error detail (e.g. the JSON "detail" field of a rejected
  // POST). Diagnostics only: never forwarded to the UI stream.
  detail?: string;
  // Safe chat-requirements shape facts (challenge mode enum, booleans) used
  // to diagnose risk-engine rejections. Never carries token values.
  turnstileRequired?: string;
  powRequested?: boolean;
  powSolved?: boolean;
  requirementsResolved?: boolean;
};

export function logChatGptConversationEvent(value: ChatGptConversationDiagnostic): void {
  const allowedReasons = ["authenticated", "not_authenticated", "cancelled", "page_execution_error", "session_timeout", "session_failed", "session_unauthorized", "session_challenge", "session_content_type", "session_json", "session_invalid", "sdk_load_failed", "sdk_load_timeout", "sdk_unavailable", "sdk_token_failed", "sdk_token_timeout", "sdk_token_invalid", "chatreq_failed", "chatreq_timeout", "chatreq_challenge", "device_missing", "catalog_failed", "post_failed", "post_http_error", "post_rate_limited", "post_content_type", "post_redirect", "stream_missing", "stream_failed", "unknown"];
  const statusReasons = ["page_load_timeout", "page_probe_timeout", "page_execution_error", "network_error", "html_or_challenge", "unauthenticated", "no_authenticated_user", "expired_session", "invalid_session", "invalid_json", "unexpected_content_type", "http_error", "login_redirect", "page_changed", "document_http_error", "document_challenge", "document_render_gone"];
  const reason = value.reason && (allowedReasons.includes(value.reason) || statusReasons.includes(value.reason) || /^document_load_failed_-?\d+$/.test(value.reason)) ? value.reason : "unknown";
  documentLogger?.log("app", "provider", value.outcome === "failed" ? "warn" : "info", "ChatGPT conversation transport stage", {
    event: "provider.chatgpt.conversation.stage", requestId: value.requestId,
    data: {
      stage: value.stage, outcome: value.outcome,
      ...(value.reason ? { reason } : {}),
      ...(value.status !== undefined ? { status: value.status } : {}),
      ...(value.contentType !== undefined ? { contentType: value.contentType } : {}),
      ...(typeof value.detail === "string" && value.detail ? { detail: value.detail.slice(0, 200).replace(/[\r\n\t]+/g, " ") } : {}),
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
