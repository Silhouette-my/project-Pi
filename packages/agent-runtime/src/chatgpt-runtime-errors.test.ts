import { expect, it, vi } from "vitest";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { createChatGptConversationStreams } from "./chatgpt-conversation.js";
import { DesktopAgentRuntime } from "./runtime.js";

it.each([
  "ChatGPT conversation HTTP 429: rate limit exceeded",
  "ChatGPT conversation HTTP 503: service unavailable",
  "ChatGPT browser transport failed: fetch failed",
  "ChatGPT stream ended before its completion marker.",
])("surfaces the first consumer failure without resending: %s", async (failure) => {
  const events: AgentEventEnvelope["event"][] = [];
  let notify: (method: string, params: unknown) => void = () => {};
  const call = vi.fn(async (method: string, params: unknown) => {
    if (method === "chatgpt.conversation.open") {
      const { requestId } = params as { requestId: string };
      queueMicrotask(() => notify("chatgpt.conversation.error", { requestId, error: failure }));
    }
  });
  const streams = createChatGptConversationStreams({
    call: call as never,
    onNotification: (handler) => { notify = handler; return () => {}; },
    onClose: () => () => {},
  });
  const runtime = new DesktopAgentRuntime({
    sessionId: "chatgpt-errors", mode: "agent", thinkingLevel: "off",
    provider: {
      id: "chat", name: "ChatGPT", modelId: "fixture-consumer", apiKey: "",
      authKind: "none", apiStyle: "chatgpt_conversation", supportsReasoning: false,
      supportedThinkingLevels: ["off"], chatGptStreams: streams,
    },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async <T>(): Promise<T> => undefined as T },
    onEvent: ({ event }) => events.push(event),
  });
  // Exercise the real provider binding, pi-agent event lifecycle, and transcript
  // projection rather than injecting a synthetic message_end into the runtime.
  try {
    runtime.setInfiniteProviderRetry(true);
    await runtime.prompt("synthetic fixture", "fixture-user");
    expect(call.mock.calls.filter(([method]) => method === "chatgpt.conversation.open")).toHaveLength(1);
    expect(events.filter((event) => event.type === "status" && event.status.activity?.phase === "retrying")).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "message_end", message: expect.objectContaining({
        status: "error", isError: true,
        error: expect.objectContaining({ message: failure, retriable: false }),
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "error", error: expect.objectContaining({ message: failure, retriable: false }),
    }));
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
  } finally { await runtime.dispose(); }
});
