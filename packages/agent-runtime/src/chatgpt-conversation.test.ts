import { describe, expect, it, vi } from "vitest";
import { normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import { buildChatGptConversationBody, ChatGptSseParser, createChatGptConversationStreams, type ChatGptHost, type ChatGptToolActivity } from "./chatgpt-conversation.js";
import { buildProviderModel, createProviderModels } from "./provider-binding.js";

type OpenRequest = { requestId: string; body: Record<string, unknown> };
const model = { id: "gpt-6", api: "chatgpt-conversation", provider: "chat" } as Model<Api>;
const user = (content: string) => ({ role: "user" as const, content, timestamp: 0 });
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
function hostFixture() {
  const handlers = new Set<(method: string, params: unknown) => void>();
  const closes = new Set<(error: Error) => void>();
  const host: ChatGptHost = {
    call: vi.fn(async () => ({ ok: true })) as ChatGptHost["call"],
    onNotification: (handler) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
    onClose: (handler) => { closes.add(handler); return () => { closes.delete(handler); }; },
  };
  return { host, handlers, emit: (method: string, requestId: string, extra = {}) => {
    for (const handler of [...handlers]) handler(`chatgpt.conversation.${method}`, { requestId, ...extra });
  }, close: () => { for (const handler of closes) handler(new Error("parent closed")); } };
}

describe("ChatGPT conversation", () => {
  it("uses the session browser adapter through the production model registry without an API key", async () => {
    const fixture = hostFixture();
    const provider = { id: "chat", name: "ChatGPT", modelId: "gpt-6", apiKey: "", apiStyle: "chatgpt_conversation", authKind: "none", supportsReasoning: false, supportedThinkingLevels: ["off" as const], chatGptStreams: createChatGptConversationStreams(fixture.host) };
    const boundModel = buildProviderModel(provider);
    expect(boundModel.api).toBe("chatgpt-conversation");
    const stream = createProviderModels(provider, boundModel).streamSimple(boundModel, { messages: [user("hello")] });
    // Models resolves account auth asynchronously before invoking its stream.
    await vi.waitFor(() => expect(fixture.host.call).toHaveBeenCalled());
    const request = vi.mocked(fixture.host.call).mock.calls[0][1] as OpenRequest;
    fixture.emit("chunk", request.requestId, { chunk: frame({ conversation_id: "c", message: { id: "a", author: { role: "assistant" }, content: { parts: ["Hello"] } } }) + "data: [DONE]\n\n" });
    fixture.emit("end", request.requestId);
    expect((await stream.result()).content).toEqual([{ type: "text", text: "Hello" }]);
  });
  it("omits a new conversation's parent and replays text history", () => {
    const body = buildChatGptConversationBody("gpt-6", [user("hello")]);
    expect(body).not.toHaveProperty("parent_message_id");
    expect(body.conversation_id).toBeNull();
    expect(body.messages).toEqual([expect.objectContaining({ author: { role: "user" }, content: { content_type: "text", parts: ["hello"] } })]);
  });

  it("maps desktop thinking levels onto account efforts", async () => {
    expect(buildChatGptConversationBody("gpt-6", [user("hello")], undefined, "extra_high")).toMatchObject({ thinking_effort: "extra_high" });
    const fixture = hostFixture();
    const stream = createChatGptConversationStreams(fixture.host).streamSimple(model, normalizeContext({ messages: [user("hello")] }), { reasoning: "xhigh" });
    await Promise.resolve();
    const request = vi.mocked(fixture.host.call).mock.calls[0][1] as OpenRequest;
    expect(request.body).toMatchObject({ thinking_effort: "extra_high" });
    fixture.emit("chunk", request.requestId, { chunk: frame({ conversation_id: "c", message: { id: "a", author: { role: "assistant" }, content: { parts: ["ok"] } } }) + "data: [DONE]\n\n" });
    fixture.emit("end", request.requestId);
    await stream.result();
    const plainFixture = hostFixture();
    const plain = createChatGptConversationStreams(plainFixture.host).stream(model, normalizeContext({ messages: [user("hello")] }));
    await Promise.resolve();
    const plainRequest = vi.mocked(plainFixture.host.call).mock.calls[0][1] as OpenRequest;
    expect(plainRequest.body).not.toHaveProperty("thinking_effort");
    plainFixture.close();
    await plain.result();
  });

  it("decodes fragmented CRLF SSE and inherited v1 append deltas", () => {
    const values: string[] = [];
    const parser = new ChatGptSseParser((value) => values.push((value as { message: { content: { parts: string[] } } }).message.content.parts[0]));
    const source = 'event: delta_encoding\r\ndata: "v1"\r\n\r\n' + frame({ v: { conversation_id: "c", message: { content: { parts: [""] } } }, c: 0 }) + frame({ p: "/message/content/parts/0", o: "append", v: "Hi" }) + frame({ v: " there" }) + "data: [DONE]\r\n\r\n";
    for (const char of source) parser.push(char);
    parser.finish();
    expect(values).toEqual(["", "Hi", "Hi there"]);
  });

  it("creates null containers that the consumer stream adds lazily (content.parts)", () => {
    const values: string[] = [];
    const parser = new ChatGptSseParser((value) => values.push(((value as { message: { content: { parts: unknown } } }).message.content.parts as string[] | null)?.[0] ?? ""));
    const source = frame({ conversation_id: "c", message: { id: "a", author: { role: "assistant" }, content: { content_type: "text", parts: null } } }) + frame({ p: "/message/content/parts/0", o: "add", v: "Hi" }) + frame({ p: "/message/content/parts/0", o: "append", v: " there" }) + "data: [DONE]\n\n";
    parser.push(source);
    expect(values.at(-1)).toBe("Hi there");
  });

  it("keeps channel state trees separate when the stream opens multiple channels", async () => {
    const fixture = hostFixture();
    const activities: ChatGptToolActivity[] = [];
    const stream = createChatGptConversationStreams(fixture.host, (activity) => activities.push(activity)).stream(model, normalizeContext({ messages: [user("hello")] }));
    await Promise.resolve();
    const request = vi.mocked(fixture.host.call).mock.calls[0][1] as OpenRequest;
    const answer = { conversation_id: "c", message: { id: "answer", author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: null } } };
    const connector = { message: { id: "tool", author: { role: "assistant" }, recipient: "web", content: { content_type: "text", parts: null } } };
    fixture.emit("chunk", request.requestId, { chunk: frame({ c: 0, v: answer }) + frame({ c: 1, v: connector }) + frame({ c: 0, p: "/message/content/parts/0", o: "add", v: "Hi" }) + frame({ c: 0, p: "/message/content/parts/0", o: "append", v: " there" }) + "data: [DONE]\n\n" });
    fixture.emit("end", request.requestId);
    expect((await stream.result()).content).toEqual([{ type: "text", text: "Hi there" }]);
    expect(activities).toEqual([{ type: "start", toolCallId: expect.any(String), toolName: "web" }, { type: "end", toolCallId: expect.any(String) }]);
  });

  it("rejects prototype traversal from external patch paths", () => {
    for (const path of ["/__proto__/piChatGptPolluted", "/constructor/prototype/piChatGptPolluted", "/message/__proto__/piChatGptPolluted"]) {
      const parser = new ChatGptSseParser(() => {});
      parser.push(frame({ v: { message: {} }, c: 0 }));
      expect(() => parser.push(frame({ p: path, o: "replace", v: "polluted" }))).toThrow("Unsafe ChatGPT stream patch path");
      expect(Object.prototype).not.toHaveProperty("piChatGptPolluted");
    }
    const parser = new ChatGptSseParser(() => {});
    parser.push(frame({ v: { message: {} }, c: 0 }));
    expect(() => parser.push(frame({ p: "/toString/name", o: "replace", v: "polluted" }))).toThrow("Invalid ChatGPT stream patch path");
  });

  it("applies nested v1 patch operations relative to their containing path", () => {
    const snapshots: unknown[] = [];
    const parser = new ChatGptSseParser((value) => snapshots.push(structuredClone(value)));
    parser.push(frame({ v: { message: { content: { parts: ["Hi"] }, metadata: {} } }, c: 0 }));
    parser.push(frame({ p: "/message", o: "patch", v: [{ p: "/content/parts/0", o: "append", v: " there" }, { p: "/status", o: "add", v: "finished_successfully" }, { p: "/metadata", o: "patch", v: [{ p: "/finish_details", o: "add", v: { type: "stop" } }] }] }));
    expect(snapshots.at(-1)).toEqual({ message: { content: { parts: ["Hi there"] }, status: "finished_successfully", metadata: { finish_details: { type: "stop" } } } });
  });

  it("preserves normalized system instructions and connector failures", async () => {
    expect(buildChatGptConversationBody("gpt-6", [{ role: "system", content: "", sections: { runtime: "Section-based instructions" }, timestamp: 0 }, user("hello")]).messages).toEqual([expect.objectContaining({ content: { content_type: "text", parts: [expect.stringContaining("Section-based instructions")] } }), expect.anything()]);
    const fixture = hostFixture();
    const activities: ChatGptToolActivity[] = [];
    const stream = createChatGptConversationStreams(fixture.host, (activity) => activities.push(activity)).stream(model, normalizeContext({ systemPrompt: "Be concise.", messages: [user("hello")] }));
    await Promise.resolve();
    const request = vi.mocked(fixture.host.call).mock.calls[0][1] as OpenRequest;
    expect(request.body.messages).toEqual([expect.objectContaining({ author: { role: "system" }, content: { content_type: "text", parts: ["Be concise."] } }), expect.objectContaining({ author: { role: "user" } })]);
    fixture.emit("chunk", request.requestId, { chunk: frame({ conversation_id: "c", message: { id: "a", author: { role: "assistant" }, content: { parts: ["Connector was unavailable."] }, metadata: { mcp_events: [{ tool_name: "WebCodex", status: "failed", error: { message: "Runner offline" } }] } } }) + "data: [DONE]\n\n" });
    fixture.emit("end", request.requestId);
    expect((await stream.result()).stopReason).toBe("stop");
    expect(activities).toEqual([{ type: "start", toolCallId: expect.any(String), toolName: "WebCodex" }, { type: "end", toolCallId: expect.any(String), error: "Runner offline" }]);
  });

  it("streams into pi events, exposes server tools, usage, and continues only its own session", async () => {
    const fixture = hostFixture();
    const activities: ChatGptToolActivity[] = [];
    const adapter = createChatGptConversationStreams(fixture.host, (activity) => activities.push(activity));
    const first = adapter.streamSimple(model, normalizeContext({ messages: [user("hello")] }));
    await Promise.resolve();
    const firstRequest = vi.mocked(fixture.host.call).mock.calls[0][1] as OpenRequest;
    fixture.emit("chunk", firstRequest.requestId, { chunk: frame({ v: { conversation_id: "conversation-a", message: { id: "assistant-a", author: { role: "assistant" }, content: { parts: [""] }, metadata: { tools_used: ["WebCodex"], usage: { input_tokens: 8, output_tokens: 2 } } } }, c: 0 }) + frame({ p: "/message/content/parts/0", o: "append", v: "Hello" }) + "data: [DONE]\n\n" });
    fixture.emit("end", firstRequest.requestId);
    const events = [];
    for await (const event of first) events.push(event);
    expect(activities).toEqual([{ type: "start", toolCallId: expect.any(String), toolName: "WebCodex" }, { type: "end", toolCallId: expect.any(String) }]);
    expect(events.map((event) => event.type)).not.toContain("toolcall_end");
    expect((await first.result()).usage.totalTokens).toBe(10);
    const second = adapter.streamSimple(model, normalizeContext({ messages: [user("hello"), await first.result(), user("again")] }));
    await Promise.resolve();
    const secondRequest = vi.mocked(fixture.host.call).mock.calls[1][1] as OpenRequest;
    expect(secondRequest.body).toMatchObject({ conversation_id: "conversation-a", parent_message_id: "assistant-a", messages: [{ content: { parts: ["again"] } }] });
    fixture.emit("error", secondRequest.requestId, { error: "rate limit" });
    expect((await second.result()).errorMessage).toBe("rate limit");
    expect(fixture.handlers.size).toBe(0);
    const isolated = createChatGptConversationStreams(fixture.host).stream(model, normalizeContext({ messages: [user("separate")] }));
    await Promise.resolve();
    const isolatedRequest = vi.mocked(fixture.host.call).mock.calls.filter(([method]) => method === "chatgpt.conversation.open")[2][1] as OpenRequest;
    expect(isolatedRequest.body).not.toHaveProperty("parent_message_id");
    fixture.close();
    expect((await isolated.result()).errorMessage).toBe("parent closed");
  });

  it("cancels fetch, terminates once, and releases notification listeners", async () => {
    const fixture = hostFixture();
    const controller = new AbortController();
    const stream = createChatGptConversationStreams(fixture.host).stream(model, normalizeContext({ messages: [user("hello")] }), { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    expect((await stream.result()).stopReason).toBe("aborted");
    expect(fixture.host.call).toHaveBeenLastCalledWith("chatgpt.conversation.cancel", expect.objectContaining({ requestId: expect.any(String) }));
    expect(fixture.handlers.size).toBe(0);
  });

  it("starts a new remote branch after an assistant edit and refuses local tool replay", async () => {
    const fixture = hostFixture();
    const adapter = createChatGptConversationStreams(fixture.host);
    const first = adapter.stream(model, normalizeContext({ messages: [user("hello")] }));
    await Promise.resolve();
    const request = vi.mocked(fixture.host.call).mock.calls[0][1] as OpenRequest;
    fixture.emit("chunk", request.requestId, { chunk: frame({ conversation_id: "c", message: { id: "a", author: { role: "assistant" }, content: { parts: ["Original"] } } }) + "data: [DONE]\n\n" });
    fixture.emit("end", request.requestId);
    const response = await first.result();
    const controller = new AbortController();
    const fork = adapter.stream(model, normalizeContext({ messages: [user("hello"), { ...response, content: [{ type: "text", text: "Edited" }] }, user("continue")] }), { signal: controller.signal });
    await Promise.resolve();
    const forkRequest = vi.mocked(fixture.host.call).mock.calls[1][1] as OpenRequest;
    expect(forkRequest.body).not.toHaveProperty("parent_message_id");
    expect(forkRequest.body.messages).toHaveLength(3);
    controller.abort(); await fork.result();
    expect(() => buildChatGptConversationBody("gpt-6", [{ role: "toolResult", toolCallId: "local", toolName: "Read", content: [{ type: "text", text: "local result" }], isError: false, timestamp: 0 }, user("continue")])).toThrow("cannot replay local tool results");
  });

  it("attaches a model-route diagnostic only when server STE metadata proves a different route", async () => {
    for (const [name, ste, expected] of [["downgrade", { model_slug: "gpt-5-mini", did_auto_switch_to_reasoning: false }, true], ["auto-switch", { model_slug: "gpt-6", did_auto_switch_to_reasoning: true }, true], ["matching route", { model_slug: "gpt-6", did_auto_switch_to_reasoning: false }, false]] as const) {
      const fixture = hostFixture();
      const stream = createChatGptConversationStreams(fixture.host).stream(model, normalizeContext({ messages: [user("hello")] }));
      await Promise.resolve();
      const request = vi.mocked(fixture.host.call).mock.calls[0][1] as OpenRequest;
      fixture.emit("chunk", request.requestId, { chunk: frame({ v: { conversation_id: "c", message: { id: "a", author: { role: "assistant" }, content: { parts: ["Hi"] }, metadata: { server_ste_metadata: ste } } }, c: 0 }) + "data: [DONE]\n\n" });
      fixture.emit("end", request.requestId);
      const result = await stream.result();
      const route = result.diagnostics?.find((diagnostic) => diagnostic.type === "chatgpt.model_route");
      expect({ name, attached: route !== undefined }).toEqual({ name, attached: expected });
      if (name === "downgrade") expect(route?.details).toMatchObject({ requested: "gpt-6", exec: ["gpt-5-mini"], flags: { did_auto_switch_to_reasoning: false } });
    }
  });

  it("surfaces malformed streams and incomplete responses instead of succeeding", async () => {
    for (const chunk of ["data: {bad}\n\n", frame({ type: "unrelated" }), frame({ conversation_id: "c", message: { id: "a", author: { role: "assistant" }, content: { parts: ["truncated"] } } }), frame({ conversation_id: "c", message: { id: "a", author: { role: "assistant" }, content: { content_type: "text", parts: null } } }) + "data: [DONE]\n\n"]) {
      const fixture = hostFixture();
      const stream = createChatGptConversationStreams(fixture.host).stream(model, normalizeContext({ messages: [user("hello")] }));
      await Promise.resolve();
      const request = vi.mocked(fixture.host.call).mock.calls[0][1] as OpenRequest;
      fixture.emit("chunk", request.requestId, { chunk });
      fixture.emit("end", request.requestId);
      expect((await stream.result()).stopReason).toBe("error");
    }
  });
});
