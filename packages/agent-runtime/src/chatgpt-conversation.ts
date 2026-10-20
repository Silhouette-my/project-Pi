import { randomUUID } from "node:crypto";
import { appendAssistantMessageDiagnostic, createAssistantMessageEventStream, getSystemMessageText, type Api, type AssistantMessage, type Message, type Model, type ProviderStreams, type StreamOptions, type ThinkingLevel, type TranscriptContext } from "@earendil-works/pi-ai";
import { createChatGptModelRouteObserver } from "./chatgpt-model-route.js";

export interface ChatGptHost {
  call<T = unknown>(method: string, params: unknown): Promise<T>;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  onClose(handler: (error: Error) => void): () => void;
}

export type ChatGptToolActivity =
  | { type: "start"; toolCallId: string; toolName: string }
  | { type: "end"; toolCallId: string; error?: string; result?: unknown };

type Continuity = { conversationId: string; lastParentId: string; userCount: number; transcriptHistory: string[]; systemHistory: string[] };
type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const isContainer = (value: unknown): value is object => typeof value === "object" && value !== null;
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

function connectorNames(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(connectorNames);
  const entry = record(value);
  if (!entry) return [];
  const name = string(entry.tool_name) ?? string(entry.name) ?? string(entry.server_name) ?? string(entry.connector_name);
  return name ? [name] : [];
}

/** Split a v1 delta path into keys, mirroring the official decoder: purely
 *  numeric segments become numbers so container creation and array splicing
 *  can tell arrays from objects apart. */
function pathKeys(path: string): (string | number)[] {
  const keys: (string | number)[] = [];
  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  if (!trimmed) return keys;
  for (const segment of trimmed.split("/")) keys.push(/^(?:0|[1-9]\d*)$/.test(segment) ? Number(segment) : segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  return keys;
}

/** Decode SSE framing and ChatGPT's stateful v1 JSON-patch encoding.
 *  Mirrors the official consumer decoder: each channel keeps its own state
 *  tree (the stream opens channels 0..N with full-state `add` roots, then
 *  patches them independently), frames inherit channel/path/op from the
 *  previous frame (defaults channel 0 / path "" / op "add"), missing
 *  containers are created during traversal regardless of the operation,
 *  `append` falls back to assignment, and `truncate` bounds strings/arrays.
 *  The consumer stream leaves null placeholders (content.parts) where it
 *  later adds entries, so null is treated like a missing container. */
export class ChatGptSseParser {
  completed = false;
  private buffer = "";
  private channel = 0;
  private channelState = new Map<number, Json>();
  private path = "";
  private operation = "add";
  private deltaSeen = false;
  // Structural summary of recent delta frames (path/op/value type only, never
  // content) appended to decode errors so failures are diagnosable from the UI.
  private frames: string[] = [];
  constructor(private emit: (value: Json) => void) {}

  push(chunk: string): void {
    this.buffer = (this.buffer + chunk).replace(/\r\n/g, "\n");
    let end: number;
    while ((end = this.buffer.indexOf("\n\n")) >= 0) {
      const frame = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      let event = "";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        else if (line.startsWith("event:")) event = line.slice(6).trim();
      }
      const payload = data.join("\n");
      if (!payload) continue;
      if (payload === "[DONE]") { this.completed = true; continue; }
      const value = record(JSON.parse(payload) as unknown);
      // delta_encoding announces "v1" as a JSON string; keep-alives may be null.
      if (!value) continue;
      if (value.type === "message_stream_complete") this.completed = true;
      if (value.error) throw new Error(typeof value.error === "string" ? value.error : JSON.stringify(value.error));
      if (value.message || value.conversation_id) { this.logPlainFrame(value); this.emit(value); continue; }
      // Named `delta` events are authoritative; unnamed frames are recognized by shape.
      if (event === "delta" || (event !== "delta_encoding" && !value.type && "v" in value && (value.p !== undefined || value.o !== undefined || value.c !== undefined || this.deltaSeen))) {
        this.applyDelta(value);
        this.deltaSeen = true;
      } else this.emit(value);
    }
  }

  finish(): void {
    if (this.buffer.trim()) this.push("\n\n");
  }

  /** Structural summary of recent frames (roles, paths, ops, value types —
   *  never content) surfaced in decode/empty-stream errors for diagnosis. */
  frameSummary(): string {
    return this.frames.join(" | ");
  }

  private logPlainFrame(value: Json): void {
    if (this.frames.length >= 12) return;
    const message = record(value.message);
    const content = record(message?.content);
    const parts = content?.parts;
    const shape = Array.isArray(parts) ? `array[${parts.map((part) => typeof part === "string" ? `str(${part.length})` : typeof part).join(",")}]` : parts === null ? "null" : typeof parts;
    this.frames.push(`plain role=${string(record(message?.author)?.role) ?? "-"} ctype=${string(content?.content_type) ?? "-"} channel=${string(message?.channel) ?? "-"} recipient=${string(message?.recipient) ?? "-"} parts=${shape}`);
  }

  private applyDelta(delta: Json): void {
    const channel = number(delta.c) ?? this.channel;
    const path = string(delta.p) ?? this.path;
    const operation = string(delta.o) ?? this.operation;
    this.channel = channel; this.path = path; this.operation = operation;
    if (this.frames.length < 12) this.frames.push(`delta p=${path || "/"} o=${operation} c=${channel} v=${Array.isArray(delta.v) ? "array" : typeof delta.v === "string" ? `str(${delta.v.length})` : typeof delta.v}`);
    const root = { __root: this.channelState.get(channel) as unknown };
    try {
      this.apply(root, ["__root", ...pathKeys(path)], operation, delta.v, path);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} [${this.frames.join(" | ")}]`);
    }
    const next = record(root.__root);
    if (!next) throw new Error("Invalid ChatGPT stream state");
    this.channelState.set(channel, next);
    this.emit(next);
  }

  private apply(target: object, keys: (string | number)[], operation: string, value: unknown, path: string): void {
    // keys is ["__root", ...path]; the last key is the operation target and an
    // empty path operates on "__root" itself, mirroring the official decoder.
    const key = keys.at(-1)!;
    for (let i = 0; i < keys.length - 1; i += 1) {
      const step = keys[i];
      if (step === "__proto__" || step === "constructor" || step === "prototype") throw new Error("Unsafe ChatGPT stream patch path");
      const raw: unknown = Reflect.get(target, step);
      let child: object;
      if (raw === undefined || raw === null) {
        child = typeof (keys[i + 1] ?? key) === "number" ? [] : {};
        Reflect.set(target, step, child);
      } else if (isContainer(raw)) {
        child = raw;
      } else {
        throw new Error(`Invalid ChatGPT stream patch path: ${path}`);
      }
      target = child;
    }
    const current: unknown = Reflect.get(target, key);
    switch (operation) {
      case "patch": {
        if (!Array.isArray(value)) throw new Error("Invalid ChatGPT patch list");
        const nested = { __root: current };
        for (const entry of value) {
          const decoded = record(entry);
          if (!decoded) throw new Error("Invalid ChatGPT stream patch");
          const subPath = string(decoded.p) ?? "";
          this.apply(nested, ["__root", ...pathKeys(subPath)], string(decoded.o) ?? "", decoded.v, subPath);
        }
        Reflect.set(target, key, nested.__root);
        break;
      }
      case "add": if (Array.isArray(target) && typeof key === "number") target.splice(key, 0, value); else Reflect.set(target, key, value); break;
      case "remove": if (Array.isArray(target) && typeof key === "number") target.splice(key, 1); else Reflect.deleteProperty(target, key); break;
      case "replace": Reflect.set(target, key, value); break;
      case "append":
        if (typeof current === "string" && typeof value === "string") Reflect.set(target, key, current + value);
        else if (Array.isArray(current)) current.push(...(Array.isArray(value) ? value : [value]));
        else if (record(current) && record(value)) Object.assign(current as Json, value);
        else Reflect.set(target, key, value);
        break;
      case "truncate":
        if (typeof current === "string") Reflect.set(target, key, current.slice(0, number(value) ?? current.length));
        else if (Array.isArray(current) && typeof value === "number") current.length = value;
        break;
      default: throw new Error(`Unsupported ChatGPT stream patch operation: ${operation}`);
    }
  }
}

function textContent(message: Message): string {
  if (message.role === "toolResult") throw new Error("ChatGPT Chat cannot replay local tool results. Start a new conversation using account-side connectors.");
  if (message.role === "system") return getSystemMessageText(message);
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "thinking") return "";
    throw new Error("ChatGPT Chat currently supports text messages and account-side connectors only.");
  }).join("\n");
}

function transcriptHistory(messages: Message[]): string[] {
  // Thinking/tool-activity presentation may be compacted independently of the
  // visible text. Text and role identify the remote branch, not timestamps.
  return messages.filter((message) => message.role !== "system").map((message) => JSON.stringify([message.role, textContent(message)]));
}

/** Desktop thinking levels map onto the account's effort enum; "off" sends none and the page picks a safe default. */
const CHATGPT_THINKING_EFFORTS: Partial<Record<ThinkingLevel, string>> = {
  minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "extra_high", max: "extra_high",
};

export function buildChatGptConversationBody(model: string, messages: Message[], previous?: Continuity, thinkingEffort?: string): Record<string, unknown> {
  const users = messages.filter((message) => message.role === "user");
  const newMessages = previous ? users.slice(previous.userCount) : messages;
  if (!newMessages.some((message) => message.role === "user")) throw new Error("ChatGPT Chat requires a new user message; local tool continuations are unsupported.");
  return {
    action: "next",
    messages: newMessages.map((message) => ({ id: randomUUID(), author: { role: message.role }, content: { content_type: "text", parts: [textContent(message)] }, metadata: {} })),
    conversation_id: previous?.conversationId ?? null,
    ...(previous ? { parent_message_id: previous.lastParentId } : {}),
    model, requested_default_model: model, client_prepare_state: "N/A",
    timezone_offset_min: -new Date().getTimezoneOffset(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    history_and_training_disabled: false, is_do_not_remember: false, force_paragen: false,
    reset_rate_limits: false, supports_buffering: true, supported_encodings: ["v1"],
    ...(thinkingEffort ? { thinking_effort: thinkingEffort } : {}),
  };
}

/** One adapter per pi session/provider: restarts intentionally replay history into a new remote conversation. */
export function createChatGptConversationStreams(host: ChatGptHost, onToolActivity?: (activity: ChatGptToolActivity) => void): ProviderStreams {
  let previous: Continuity | undefined;
  // The agent loop selects thinking levels through SimpleStreamOptions.reasoning;
  // accepting the optional field here keeps one implementation for both entries.
  const stream = (model: Model<Api>, context: TranscriptContext, options?: StreamOptions & { reasoning?: ThinkingLevel }) => {
    const result = createAssistantMessageEventStream();
    const requestId = randomUUID();
    const output: AssistantMessage = {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    };
    let finished = false;
    let opened = false;
    let conversationId: string | undefined;
    let parentId: string | undefined;
    const texts = new Map<string, { index: number; text: string; kind: "text" | "thinking" }>();
    const activities = new Map<string, string>();
    const completedActivities = new Set<string>();
    const startActivity = (toolName: string) => {
      if (activities.has(toolName) || completedActivities.has(toolName)) return;
      const toolCallId = `${requestId}:connector:${activities.size + completedActivities.size}`;
      activities.set(toolName, toolCallId);
      onToolActivity?.({ type: "start", toolCallId, toolName });
    };
    const endActivity = (toolName: string, error?: string, result?: unknown) => {
      const toolCallId = activities.get(toolName);
      if (!toolCallId) return;
      onToolActivity?.({ type: "end", toolCallId, ...(error ? { error } : {}), ...(result !== undefined ? { result } : {}) });
      activities.delete(toolName);
      completedActivities.add(toolName);
    };
    const finishActivities = (error?: string) => {
      for (const toolName of activities.keys()) endActivity(toolName, error);
    };
    let unsubscribe = () => {};
    let unsubscribeClose = () => {};
    const cleanup = () => { unsubscribe(); unsubscribeClose(); options?.signal?.removeEventListener("abort", abort); };
    const fail = (error: Error, aborted = false) => {
      if (finished) return;
      finished = true;
      // An interrupted request may have advanced the server's branch; replay safely next time.
      previous = undefined;
      cleanup();
      finishActivities(error.message);
      if (opened) void host.call("chatgpt.conversation.cancel", { requestId }).catch((cancelError) => process.stderr.write(`[chatgpt-chat] cancel failed: ${String(cancelError)}\n`));
      output.stopReason = aborted ? "aborted" : "error";
      output.errorMessage = error.message;
      result.push({ type: "error", reason: output.stopReason, error: output }); result.end();
    };
    const abort = () => {
      fail(new Error("ChatGPT conversation aborted"), true);
    };
    const updateText = (id: string, text: string, kind: "text" | "thinking") => {
      let block = texts.get(id);
      if (!block) {
        block = { index: output.content.length, text: "", kind }; texts.set(id, block);
        output.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
        result.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: block.index, partial: output });
      }
      if (!text.startsWith(block.text)) throw new Error("ChatGPT replaced already streamed content; retry in a new conversation.");
      const delta = text.slice(block.text.length); block.text = text;
      if (!delta) return;
      const content = output.content[block.index];
      if (content.type === "text") content.text = text;
      if (content.type === "thinking") content.thinking = text;
      result.push({ type: kind === "text" ? "text_delta" : "thinking_delta", contentIndex: block.index, delta, partial: output });
    };
    const route = createChatGptModelRouteObserver();
    const parser = new ChatGptSseParser((event) => {
      route.observe(event);
      conversationId = string(event.conversation_id) ?? conversationId;
      const message = record(event.message);
      const metadata = record(message?.metadata) ?? record(event.metadata) ?? event;
      const finish = record(metadata.finish_details);
      if (message?.status === "failed" || finish?.type === "error") throw new Error(string(record(metadata.error)?.message) ?? "ChatGPT failed to complete the response.");
      if (record(message?.author)?.role === "assistant") {
        // Only visible answers anchor continuation and emit text; connector and
        // analysis channels never become the parent (mirrors the official
        // last-visible-message selection).
        const recipient = string(message?.recipient);
        const connector = recipient !== undefined && recipient !== "all";
        if (!connector && message?.channel !== "analysis") {
          parentId = string(message?.id) ?? parentId;
          output.responseId = parentId;
        }
        const parts = record(message?.content)?.parts;
        const kind = message?.channel === "analysis" || connector ? "thinking" : "text";
        if (connector) {
          startActivity(recipient!);
        } else if (Array.isArray(parts)) updateText(`${string(message?.id) ?? "assistant"}:${kind}`, parts.filter((part: unknown) => typeof part === "string").join(""), kind);
      }
      if (finish?.type === "max_tokens") output.stopReason = "length";
      const usage = record(metadata.usage) ?? record(event.usage);
      if (usage) {
        output.usage.input = number(usage.input_tokens) ?? number(usage.prompt_tokens) ?? output.usage.input;
        output.usage.output = number(usage.output_tokens) ?? number(usage.completion_tokens) ?? output.usage.output;
        output.usage.totalTokens = number(usage.total_tokens) ?? output.usage.input + output.usage.output;
      }
      for (const key of ["tools_used", "last_tool_used", "mcp_events", "codex_mcp_elicitation"]) {
        if (!metadata[key]) continue;
        const values = Array.isArray(metadata[key]) ? metadata[key] : [metadata[key]];
        for (const value of values) {
          const names = connectorNames(value);
          const activity = record(value);
          const status = string(activity?.status);
          const error = string(activity?.error) ?? string(record(activity?.error)?.message);
          for (const name of names.length ? names : ["ChatGPT account connector"]) {
            startActivity(name);
            if (error || status === "error" || status === "failed") endActivity(name, error ?? "Account connector failed", activity?.result);
            else if (status === "completed" || status === "success" || status === "done") endActivity(name, undefined, activity?.result);
          }
        }
        if (key === "codex_mcp_elicitation") updateText("connector-confirmation", "Account connector requires your confirmation in ChatGPT.", "thinking");
      }
      if (event.type === "error") throw new Error(string(event.message) ?? JSON.stringify(event));
    });
    queueMicrotask(() => {
      try {
        const users = context.messages.filter((message) => message.role === "user").length;
        const history = transcriptHistory(context.messages);
        const systemHistory = context.messages.filter((message) => message.role === "system").map(textContent);
        // A compacted/edited transcript no longer identifies the prior branch.
        if (previous && (users <= previous.userCount || previous.transcriptHistory.some((content, index) => history[index] !== content) || JSON.stringify(previous.systemHistory) !== JSON.stringify(systemHistory))) previous = undefined;
        const body = buildChatGptConversationBody(model.id, context.messages, previous, options?.reasoning ? CHATGPT_THINKING_EFFORTS[options.reasoning] : undefined);
        unsubscribe = host.onNotification((method, raw) => {
          const params = record(raw);
          if (params?.requestId !== requestId || finished) return;
          try {
            if (method === "chatgpt.conversation.chunk") {
              if (typeof params.chunk !== "string") throw new Error("Invalid ChatGPT stream chunk");
              parser.push(params.chunk);
            } else if (method === "chatgpt.conversation.error") fail(new Error(string(params.error) ?? "ChatGPT browser transport failed"));
            else if (method === "chatgpt.conversation.end") {
              parser.finish();
              if (!parser.completed) throw new Error("ChatGPT stream ended before its completion marker.");
              if (!conversationId || !parentId) throw new Error("ChatGPT stream ended without conversation and assistant IDs.");
              const visible = output.content.some((block) => block.type === "text" && block.text.trim() !== "");
              if (!visible) throw new Error(`ChatGPT stream produced no visible text [${parser.frameSummary()}]`);
              // Silent-downgrade radar: only server STE metadata proves which
              // model executed. A mismatch or auto-switch attaches a diagnostic
              // without failing the turn.
              const observed = route.result();
              if (observed.exec.length > 0 && (observed.exec.some((slug) => slug !== model.id) || observed.flags.did_auto_switch_to_reasoning === true)) {
                appendAssistantMessageDiagnostic(output, { type: "chatgpt.model_route", timestamp: Date.now(), details: { requested: model.id, exec: observed.exec, flags: observed.flags } });
              }
              for (const block of texts.values()) result.push({ type: block.kind === "text" ? "text_end" : "thinking_end", contentIndex: block.index, content: block.text, partial: output });
              previous = { conversationId, lastParentId: parentId, userCount: users, transcriptHistory: [...history, ...transcriptHistory([output])], systemHistory };
              finishActivities();
              finished = true; cleanup(); result.push({ type: "done", reason: output.stopReason === "length" ? "length" : "stop", message: output }); result.end();
            }
          } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
        });
        unsubscribeClose = host.onClose((error) => fail(error));
        options?.signal?.addEventListener("abort", abort, { once: true });
        if (options?.signal?.aborted) { abort(); return; }
        result.push({ type: "start", partial: output });
        opened = true;
        void host.call("chatgpt.conversation.open", { requestId, body }).catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
    return result;
  };
  return { stream, streamSimple: stream };
}
