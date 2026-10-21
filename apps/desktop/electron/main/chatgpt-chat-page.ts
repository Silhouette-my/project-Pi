import type { ChatGptChatStatus } from "@pi-desktop/shared";
import { pageModels, parseChatGptChatModels } from "./chatgpt-chat-models";
import { conversationRequestFacts, conversationValidationErrors, sanitizeConversationRequestFacts } from "./chatgpt-chat-diagnostics";
import type { ChatGptConversationDiagnostic } from "./chatgpt-chat-diagnostics";

/** Code executed in the ChatGPT page's main world. No credentials leave it. */
export type ChatGptAuthStatus = ChatGptChatStatus;

export function authStatusScript(includeBackendDiagnostic = false, diagnoseAuthenticatedTransition = false): string {
  return `(${pageAuthStatus.toString()})(${JSON.stringify(includeBackendDiagnostic)},${JSON.stringify(diagnoseAuthenticatedTransition)})`;
}

async function pageAuthStatus(includeBackendDiagnostic: boolean, diagnoseAuthenticatedTransition: boolean): Promise<ChatGptAuthStatus> {
  const endpoint = "/api/auth/session";
  let status: number | null = null;
  let contentType: string | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let lastResult: ChatGptAuthStatus | undefined;
  const result = (state: ChatGptAuthStatus["state"], reason: string): ChatGptAuthStatus => {
    lastResult = { loggedIn: state === "signed_in", state, diagnostic: { endpoint, status, contentType, reason } };
    return lastResult;
  };
  try {
    const response = await fetch(endpoint, { credentials: "include", headers: { Accept: "application/json" }, signal: controller.signal });
    status = response.status;
    contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? null;
    if (response.redirected) return result("checking", "login_redirect");
    if (response.headers.get("cf-mitigated") === "challenge" || contentType === "text/html") return result("challenge", "html_or_challenge");
    if (status === 401 || status === 403) return result("signed_out", "unauthenticated");
    if (!response.ok) return result("error", "http_error");
    if (contentType !== "application/json") return result("error", "unexpected_content_type");
    let session: unknown;
    try { session = await response.json(); } catch { return result("error", "invalid_json"); }
    if (!session || typeof session !== "object" || Array.isArray(session)) return result("error", "invalid_session");
    const data = session as { user?: { id?: unknown; email?: unknown }; expires?: unknown };
    const user = data.user;
    if (!user || typeof user !== "object" || !([user.id, user.email].some((value) => typeof value === "string" && value.length > 0))) return result("signed_out", "no_authenticated_user");
    if (data.expires !== undefined && (typeof data.expires !== "string" || !Number.isFinite(Date.parse(data.expires)) || Date.parse(data.expires) <= Date.now())) return result("signed_out", "expired_session");
    return result("signed_in", "authenticated_session");
  } catch {
    return result("error", controller.signal.aborted ? "request_timeout" : "network_error");
  } finally {
    if ((includeBackendDiagnostic || (diagnoseAuthenticatedTransition && lastResult?.loggedIn)) && lastResult?.diagnostic) {
      const checks = [{ ...lastResult.diagnostic }];
      const probe = { endpoint: "/backend-api/me", status: null as number | null, contentType: null as string | null, reason: "network_error" };
      try {
        const response = await fetch(probe.endpoint, { credentials: "include", headers: { Accept: "application/json" }, signal: controller.signal });
        probe.status = response.status;
        probe.contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? null;
        probe.reason = response.redirected ? "login_redirect" : probe.contentType === "text/html" ? "html_response" : response.ok ? "response_observed" : "http_error";
      } catch { probe.reason = controller.signal.aborted ? "request_timeout" : "network_error"; }
      lastResult.diagnostic.checks = [...checks, probe];
    }
    clearTimeout(timer);
  }
}

export function conversationScript(requestId: string, body: Record<string, unknown>, observedHeaders: Record<string, string>): string {
  return `(${pageConversation.toString()})(${JSON.stringify(requestId)},${JSON.stringify(body)},${JSON.stringify(observedHeaders)},${pageModels.toString()},${parseChatGptChatModels.toString()},${solveProofOfWork.toString()},${conversationRequestFacts.toString()},${conversationValidationErrors.toString()})`;
}

/**
 * Mirrors the official client's chat-requirements proof-of-work: an FNV-1a
 * hash over `seed + base64(JSON.stringify(fingerprintConfig))`, where the
 * config carries the attempt counter at index 3 and elapsed time at index 9.
 * The answer is accepted when the hash's hex prefix sorts <= the server's
 * difficulty string; the submitted token is `gAAAAAB` + base64 + `~S`.
 */
function solveProofOfWork(seed: string, difficulty: string, maxAttempts = 400000): string | undefined {
  const hash = (input: string): string => {
    let h = 2166136261;
    for (let i = 0; i < input.length; i += 1) h ^= input.charCodeAt(i), h = Math.imul(h, 16777619) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 2246822507) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0).toString(16).padStart(8, "0");
  };
  const page = window as unknown as { screen?: { width?: number; height?: number } };
  const config: unknown[] = [
    (page.screen?.width ?? 0) + (page.screen?.height ?? 0),
    String(new Date()),
    (performance as unknown as { memory?: { jsHeapSizeLimit?: number } }).memory?.jsHeapSizeLimit ?? 0,
    0,
    navigator.userAgent,
    "",
    document.documentElement?.getAttribute("data-build") ?? "",
    navigator.language,
    (navigator.languages ?? []).join(","),
    0,
    "",
    "",
    "",
    performance.now(),
    crypto.randomUUID(),
    "",
    navigator.hardwareConcurrency ?? 0,
    performance.timeOrigin,
    0, 0, 0, 0, 0, 0,
  ];
  const encoder = new TextEncoder();
  const started = performance.now();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0 && (attempt & 0xffff) === 0 && performance.now() - started > 5000) break;
    config[3] = attempt;
    config[9] = Math.round(performance.now() - started);
    const bytes = encoder.encode(JSON.stringify(config));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encoded = btoa(binary);
    if (hash(seed + encoded).slice(0, difficulty.length) <= difficulty) return `gAAAAAB${encoded}~S`;
  }
  return undefined;
}

async function pageConversation(requestId: string, body: Record<string, unknown>, observedHeaders: Record<string, string>, loadModels: typeof pageModels, parseModels: typeof parseChatGptChatModels, solvePow: typeof solveProofOfWork, requestFacts: typeof conversationRequestFacts, validationErrors: typeof conversationValidationErrors) {
  const page = window as unknown as {
    SentinelSDK?: { token: (action: string) => Promise<unknown> };
    __piChatSentinelLoad?: Promise<void>;
    __piBridge: { send: (payload: unknown) => void };
    __piChatRequests?: Map<string, AbortController>;
    __piChatModelDefaults?: Map<string, { defaultEffort?: string; efforts: string[] }>;
  };
  const requests = page.__piChatRequests ??= new Map();
  const controller = new AbortController();
  requests.set(requestId, controller);
  const send = (payload: Record<string, unknown>) => page.__piBridge.send({ requestId, ...payload });
  const progress: { stage: ChatGptConversationDiagnostic["stage"] } = { stage: "session" };
  let failureReason = "session_failed";
  let httpStatus: number | undefined;
  let retryAfterSeconds: string | undefined;
  let contentType: string | null | undefined;
  let detail: string | undefined;
  let postRequestFacts: ReturnType<typeof conversationRequestFacts> | undefined;
  let postValidationErrors: ReturnType<typeof conversationValidationErrors> | undefined;
  let turnstileRequired: string | undefined;
  let powRequested = false;
  let powSolved = false;
  let requirementsResolved = false;
  const diagnostic = (outcome: ChatGptConversationDiagnostic["outcome"], reason?: string) => send({ type: "diagnostic", stage: progress.stage, outcome, ...(reason ? { reason } : {}), ...(httpStatus !== undefined ? { status: httpStatus } : {}), ...(contentType !== undefined ? { contentType } : {}), ...(detail !== undefined ? { detail } : {}), ...(postRequestFacts ? { requestFacts: postRequestFacts } : {}), ...(postValidationErrors ? { validationErrors: postValidationErrors } : {}), ...(turnstileRequired !== undefined ? { turnstileRequired } : {}), ...(powRequested ? { powRequested: true } : {}), ...(powSolved ? { powSolved: true } : {}), ...(requirementsResolved ? { requirementsResolved: true } : {}) });
  const begin = (next: ChatGptConversationDiagnostic["stage"], reason: string) => { progress.stage = next; failureReason = reason; httpStatus = undefined; retryAfterSeconds = undefined; contentType = undefined; detail = undefined; turnstileRequired = undefined; powRequested = false; powSolved = false; requirementsResolved = false; diagnostic("started"); };
  const fail: (reason: string, message: string) => never = (reason, message) => { failureReason = reason; throw new Error(message); };
  const bounded = async <T>(work: Promise<T>, timeoutReason: string, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { failureReason = timeoutReason; reject(new Error("ChatGPT browser authorization timed out. Reopen login and try again.")); }, ms);
        abort = () => reject(new Error("ChatGPT request cancelled."));
        if (controller.signal.aborted) abort(); else controller.signal.addEventListener("abort", abort, { once: true });
      })]);
    } finally { if (timer) clearTimeout(timer); if (abort) controller.signal.removeEventListener("abort", abort); }
  };
  let sessionTimedOut = false;
  try {
    begin("session", "session_failed");
    // The consumer frontend uses its session access token when available, in
    // addition to cookies. It remains local to this page execution.
    const sessionTimer = setTimeout(() => { sessionTimedOut = true; controller.abort(); }, 10000);
    let accessToken: unknown;
    try {
      const response = await fetch("/api/auth/session", { credentials: "include", headers: { Accept: "application/json" }, signal: controller.signal });
      httpStatus = response.status;
      contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? null;
      if (response.headers.get("cf-mitigated") === "challenge" || contentType === "text/html") fail("session_challenge", "Complete the ChatGPT browser challenge in login before sending a message.");
      if (!response.ok || response.redirected) fail("session_unauthorized", "ChatGPT session expired. Open login again.");
      if (contentType !== "application/json") fail("session_content_type", "ChatGPT returned an unexpected session response.");
      let session: unknown;
      try { session = await response.json(); } catch { fail("session_json", "ChatGPT returned invalid session JSON."); }
      if (!session || typeof session !== "object" || Array.isArray(session)) fail("session_invalid", "ChatGPT session is unavailable. Open login again.");
      const data = session as { user?: { id?: unknown; email?: unknown }; expires?: unknown; accessToken?: unknown };
      if (!data.user || typeof data.user !== "object" || ![data.user.id, data.user.email].some((value) => typeof value === "string" && value.length > 0)) fail("session_unauthorized", "ChatGPT session expired. Open login again.");
      if (data.expires !== undefined && (typeof data.expires !== "string" || !Number.isFinite(Date.parse(data.expires)) || Date.parse(data.expires) <= Date.now())) fail("session_unauthorized", "ChatGPT session expired. Open login again.");
      accessToken = data.accessToken;
    } finally { clearTimeout(sessionTimer); }
    diagnostic("completed");
    if (controller.signal.aborted) throw new Error("ChatGPT request cancelled.");
    begin("sdk_load", "sdk_load_failed");
    if (!page.__piChatSentinelLoad) {
      const loaded = typeof page.SentinelSDK?.token === "function";
      page.__piChatSentinelLoad = loaded ? Promise.resolve() : new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://chatgpt.com/backend-api/sentinel/sdk.js";
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("ChatGPT browser authorization SDK could not load. Reopen login and try again."));
        document.head.appendChild(script);
      });
    }
    await bounded(page.__piChatSentinelLoad, "sdk_load_timeout", 15000);
    diagnostic("completed");
    const sdk = page.SentinelSDK;
    if (!sdk || typeof sdk.token !== "function") fail("sdk_unavailable", "ChatGPT browser authorization SDK is unavailable. Reopen login.");
    // The ordinary consumer token path awaits SDK loading, then token(flow).
    // init belongs to session-observer/voice flows, not this text-chat request.
    begin("sdk_token", "sdk_token_failed");
    const token = await bounded(sdk.token("conversation"), "sdk_token_timeout", 15000);
    if (controller.signal.aborted) throw new Error("ChatGPT request cancelled.");
    if (typeof token !== "string" || !token) fail("sdk_token_invalid", "ChatGPT could not authorize this request. Open login and try again.");
    diagnostic("completed");
    const did = document.cookie.match(/(?:^|;\s*)oai-did=([^;]+)/)?.[1];
    if (!did) fail("device_missing", "ChatGPT device session is missing. Open login again.");
    if (typeof body.model === "string" && !page.__piChatModelDefaults?.has(body.model)) {
      begin("catalog", "catalog_failed");
      try {
        await loadModels(parseModels);
        if (controller.signal.aborted) throw new Error("ChatGPT request cancelled.");
        diagnostic("completed");
      } catch (error) {
        // An explicit effort from the desktop thinking selector may be sent
        // unclamped; only choosing an implicit default requires the catalog.
        if (typeof body.thinking_effort !== "string" || controller.signal.aborted) throw error;
        diagnostic("failed");
      }
    }
    // Preserve account-native efforts. The consumer thinking models advertise
    // standard/extended rather than the desktop selector's medium/high values.
    const entry = typeof body.model === "string" ? page.__piChatModelDefaults?.get(body.model) : undefined;
    let effort = typeof body.thinking_effort === "string" ? body.thinking_effort : undefined;
    if (entry) {
      if (!effort) effort = entry.efforts.includes("instant") ? "instant" : entry.defaultEffort;
      else if (entry.efforts.length > 0 && !entry.efforts.includes(effort)) {
        const mapped = effort === "high" ? "extended" : effort === "medium" ? "standard" : undefined;
        if (mapped && entry.efforts.includes(mapped)) effort = mapped;
        else {
          progress.stage = "catalog";
          postRequestFacts = requestFacts(body, body.thinking_effort, entry);
          fail("thinking_effort_unsupported", "The selected thinking level is unsupported by this ChatGPT model. Check its account model catalog.");
        }
      }
    }
    const requestBody = { ...body };
    if (effort !== undefined) requestBody.thinking_effort = effort;
    else delete requestBody.thinking_effort;
    // The consumer risk engine expects the chat-requirements token group the
    // official client prefetches (prepare -> finalize). Best-effort: any
    // failure degrades to the previous header set, mirroring the official
    // prefetch error path, and never fails the conversation request itself.
    begin("chatreq", "chatreq_failed");
    let requirementsToken: string | undefined;
    let prepareToken: string | undefined;
    let soToken: string | undefined;
    let proofToken: string | undefined;
    try {
      // prepare/finalize require the session bearer token, not just cookies
      // (the official client passes its auth option to these calls).
      const flowHeaders: Record<string, string> = { "Content-Type": "application/json", "OpenAI-Sentinel-Flow": "chat-requirements", ...observedHeaders, ...(typeof accessToken === "string" && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) };
      const preparedResponse = await bounded(fetch("/backend-api/sentinel/chat-requirements/prepare", { method: "POST", credentials: "include", headers: flowHeaders, signal: controller.signal, body: JSON.stringify({ p: typeof body.conversation_id === "string" ? body.conversation_id : null }) }), "chatreq_timeout", 10000);
      httpStatus = preparedResponse.status;
      if (preparedResponse.ok) {
        const prepared = await preparedResponse.json() as { prepare_token?: unknown; so?: unknown; turnstile?: { required?: unknown }; proofofwork?: unknown };
        if (typeof prepared.prepare_token === "string") prepareToken = prepared.prepare_token;
        if (typeof prepared.so === "string") soToken = prepared.so;
        if (prepared.turnstile && typeof prepared.turnstile.required === "string") turnstileRequired = prepared.turnstile.required;
        const pow = prepared.proofofwork as { required?: unknown; seed?: unknown; difficulty?: unknown } | null | undefined;
        powRequested = pow !== undefined && pow !== null;
        if (pow && pow.required === true && typeof pow.seed === "string" && typeof pow.difficulty === "string") {
          proofToken = solvePow(pow.seed, pow.difficulty);
          if (proofToken) powSolved = true;
        }
        if (prepareToken) {
          const finalizedResponse = await bounded(fetch("/backend-api/sentinel/chat-requirements/finalize", { method: "POST", credentials: "include", headers: flowHeaders, signal: controller.signal, body: JSON.stringify({ prepare_token: prepareToken, ...(proofToken ? { proofofwork: proofToken } : {}) }) }), "chatreq_timeout", 10000);
          httpStatus = finalizedResponse.status;
          if (finalizedResponse.ok) {
            const finalizedBody = await finalizedResponse.json() as { token?: unknown };
            if (typeof finalizedBody.token === "string") { requirementsToken = finalizedBody.token; requirementsResolved = true; }
          }
        }
      }
      diagnostic("completed", turnstileRequired === "required" || powRequested ? "chatreq_challenge" : undefined);
    } catch {
      diagnostic("failed", failureReason === "chatreq_timeout" ? "chatreq_timeout" : "chatreq_failed");
    }
    if (controller.signal.aborted) throw new Error("ChatGPT request cancelled.");
    postRequestFacts = requestFacts(requestBody, body.thinking_effort, entry);
    begin("post", "post_failed");
    const response = await fetch("/backend-api/conversation", {
      method: "POST", credentials: "include", signal: controller.signal,
      headers: {
        "Content-Type": "application/json", Accept: "text/event-stream",
        "x-openai-web-frontend": "core_web", "OAI-Product-Sku": "chatgpt_web",
        ...observedHeaders,
        ...(typeof accessToken === "string" && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        "OAI-Session-Id": crypto.randomUUID(), "OAI-Device-Id": decodeURIComponent(did),
        "OAI-Language": navigator.language, "OpenAI-Sentinel-Token": token,
        ...(requirementsToken ? { "OpenAI-Sentinel-Chat-Requirements-Token": requirementsToken } : prepareToken ? { "OpenAI-Sentinel-Chat-Requirements-Prepare-Token": prepareToken } : {}),
        ...(soToken ? { "OpenAI-Sentinel-SO-Token": soToken } : {}),
        ...(proofToken ? { "OpenAI-Sentinel-Proof-Token": proofToken } : {}),
      }, body: JSON.stringify(requestBody),
    });
    httpStatus = response.status;
    contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? null;
    if (!response.ok) {
      // Capture only the server's own error explanation for diagnostics; the
      // response body must never reach the UI stream.
      try {
        const parsed: unknown = await response.json();
        const serverDetail = (parsed as { detail?: unknown } | null)?.detail;
        if (typeof serverDetail === "string" && ["Invalid conversation body", "Unusual activity detected from your device", "Too many requests"].includes(serverDetail)) detail = serverDetail;
        postValidationErrors = validationErrors(serverDetail);
      } catch { /* unreadable or non-JSON body: keep the generic failure */ }
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        if (typeof retryAfter === "string" && /^\d{1,6}$/.test(retryAfter)) retryAfterSeconds = retryAfter;
        fail("post_rate_limited", "ChatGPT is rate limiting this account.");
      }
      fail("post_http_error", `ChatGPT request failed (HTTP ${response.status}).`);
    }
    if (response.redirected) fail("post_redirect", "ChatGPT redirected the conversation request. Reopen login.");
    if (contentType !== "text/event-stream") fail("post_content_type", "ChatGPT returned an unexpected conversation response instead of an event stream.");
    if (!response.body) fail("stream_missing", "ChatGPT returned no response stream.");
    diagnostic("completed");
    begin("stream", "stream_failed");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk) send({ type: "chunk", chunk });
    }
    const tail = decoder.decode();
    if (tail) send({ type: "chunk", chunk: tail });
    diagnostic("completed");
    send({ type: "end" });
  } catch {
    if (progress.stage === "sdk_load") page.__piChatSentinelLoad = undefined;
    const reason = sessionTimedOut ? "session_timeout" : controller.signal.aborted ? "cancelled" : failureReason;
    diagnostic("failed", reason);
    const safeHttpStatus = typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 0 && httpStatus <= 599 ? httpStatus : undefined;
    const messages: Record<string, string> = {
      cancelled: "ChatGPT request cancelled.",
      session_timeout: "ChatGPT session check timed out. Check your connection and reopen login.",
      session_failed: "Could not check the ChatGPT session. Check your connection and reopen login.",
      session_unauthorized: "ChatGPT session expired. Open login again.",
      session_challenge: "Complete the ChatGPT browser challenge in login before sending a message.",
      session_content_type: "ChatGPT returned an unexpected session response. Reopen login.",
      session_json: "ChatGPT returned invalid session JSON. Reopen login.",
      session_invalid: "ChatGPT session is unavailable. Open login again.",
      sdk_load_failed: "ChatGPT browser authorization SDK could not load. Reopen login and try again.",
      sdk_load_timeout: "ChatGPT browser authorization SDK loading timed out. Reopen login and try again.",
      sdk_unavailable: "ChatGPT browser authorization SDK is unavailable. Reopen login.",
      sdk_token_failed: "ChatGPT could not authorize this request. Open login and try again.",
      sdk_token_timeout: "ChatGPT request authorization timed out. Reopen login and try again.",
      sdk_token_invalid: "ChatGPT could not authorize this request. Open login and try again.",
      device_missing: "ChatGPT device session is missing. Open login again.",
      thinking_effort_unsupported: "The selected thinking level is unsupported by this ChatGPT model. Check its account model catalog.",
      catalog_failed: "Could not load the ChatGPT account model catalog. Refresh models in provider settings and try again.",
      post_failed: "Could not send the ChatGPT conversation request. Check your connection and login.",
      post_http_error: safeHttpStatus === undefined ? "ChatGPT rejected the conversation request." : `ChatGPT request failed (HTTP ${safeHttpStatus}).`,
      post_rate_limited: `ChatGPT is rate limiting this account (HTTP 429${retryAfterSeconds ? `, retry after ${retryAfterSeconds} seconds` : ""}). Wait before sending again.`,
      post_redirect: "ChatGPT redirected the conversation request. Reopen login.",
      post_content_type: "ChatGPT returned an unexpected conversation response instead of an event stream.",
      stream_missing: "ChatGPT returned no response stream. Try again after checking the service.",
      stream_failed: "The ChatGPT response stream was interrupted. Check your connection before trying again.",
    };
    send({ type: "error", error: messages[reason] ?? "ChatGPT request failed. Check the service and reopen login." });
  } finally {
    requests.delete(requestId);
  }
}

export function trustedChatGptUrl(raw: string): boolean {
  try { return new URL(raw).origin === "https://chatgpt.com"; } catch { return false; }
}

export function streamPayload(raw: unknown): ({ requestId: string; type: "chunk" | "end" | "error"; chunk?: string; error?: string } | (ChatGptConversationDiagnostic & { type: "diagnostic" })) | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.requestId !== "string") return null;
  if (value.type === "diagnostic") {
    if (!["session", "sdk_load", "sdk_token", "chatreq", "catalog", "post", "stream"].includes(String(value.stage)) || !["started", "completed", "failed"].includes(String(value.outcome))) return null;
    return { type: "diagnostic", requestId: value.requestId, stage: value.stage as ChatGptConversationDiagnostic["stage"], outcome: value.outcome as ChatGptConversationDiagnostic["outcome"],
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
      ...(typeof value.status === "number" && Number.isInteger(value.status) && value.status >= 0 && value.status <= 599 ? { status: value.status } : {}),
      ...(value.contentType === null || (typeof value.contentType === "string" && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value.contentType)) ? { contentType: value.contentType as string | null } : {}),
      ...(typeof value.detail === "string" && ["Invalid conversation body", "Unusual activity detected from your device", "Too many requests"].includes(value.detail) ? { detail: value.detail } : {}),
      ...(value.requestFacts ? { requestFacts: sanitizeConversationRequestFacts(value.requestFacts) } : {}),
      ...(value.validationErrors ? { validationErrors: conversationValidationErrors(value.validationErrors) } : {}),
      ...(value.turnstileRequired === "not_required" || value.turnstileRequired === "delayed" || value.turnstileRequired === "required" ? { turnstileRequired: value.turnstileRequired } : {}),
      ...(value.powRequested === true ? { powRequested: true } : {}),
      ...(value.powSolved === true ? { powSolved: true } : {}),
      ...(value.requirementsResolved === true ? { requirementsResolved: true } : {}),
    };
  }
  if (value.type === "chunk" && typeof value.chunk === "string" && value.chunk.length <= 4 * 1024 * 1024) return { requestId: value.requestId, type: "chunk", chunk: value.chunk };
  if (value.type === "end") return { requestId: value.requestId, type: "end" };
  if (value.type === "error" && typeof value.error === "string") return { requestId: value.requestId, type: "error", error: value.error.slice(0, 1000) };
  return null;
}
