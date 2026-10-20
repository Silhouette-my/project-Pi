import { expect, it, vi } from "vitest";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import type { Agent } from "@earendil-works/pi-agent-core";

it("projects server-owned connectors into existing tool UI events without executing a local tool", async () => {
  const events: AgentEventEnvelope["event"][] = [];
  const call = vi.fn();
  const runtime = new DesktopAgentRuntime({
    sessionId: "chatgpt-tools", mode: "agent", thinkingLevel: "off",
    history: [{ id: "server-row", role: "tool", content: "", toolCallId: "old-server-call", toolName: "WebCodex", toolArgs: { execution: "ChatGPT account connector" }, toolStatus: "success", createdAt: new Date().toISOString() }],
    provider: { id: "chat", name: "ChatGPT", modelId: "gpt-6", apiKey: "", authKind: "none", apiStyle: "chatgpt_conversation", supportsReasoning: false, supportedThinkingLevels: ["off"] },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: { call: async <T>(): Promise<T> => { call(); throw new Error("Local tools must not be called"); } }, onEvent: ({ event }) => events.push(event),
  });
  try {
    runtime.emitHostedToolActivity({ type: "start", toolCallId: "server-1", toolName: "WebCodex" });
    runtime.emitHostedToolActivity({ type: "end", toolCallId: "server-1" });
    expect(events).toEqual([
      { type: "tool_start", toolCallId: "server-1", toolName: "WebCodex", args: { execution: "ChatGPT account connector" } },
      { type: "tool_end", toolCallId: "server-1", result: { content: [{ type: "text", text: "Completed by ChatGPT account connector" }] }, isError: false },
    ]);
    expect(call).not.toHaveBeenCalled();
    expect((runtime as unknown as { agent: Agent }).agent.state.messages.filter((message) => message.role !== "system")).toEqual([]);
  } finally { await runtime.dispose(); }
});
