import { describe, expect, it } from "vitest";
import { normalizeContext } from "@earendil-works/pi-ai";
import { DesktopAgentRuntime } from "./runtime.js";
import { createChatGptConversationStreams } from "./chatgpt-conversation.js";
import { withChatWorkflowContext } from "./chat-workflow-context.js";

const commandShell = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true } as const;

describe("Chat project workflow context", () => {
  it.each([
    { discussionOnly: true, chatInstructions: undefined },
    { discussionOnly: true, chatInstructions: "" },
    { discussionOnly: false, chatInstructions: "Keep answers short." },
    { discussionOnly: false, chatInstructions: "" },
  ])("sends scoped reference data through the real request (discussion=$discussionOnly, preset=$chatInstructions)", async ({ discussionOnly, chatInstructions }) => {
    const bodies: Record<string, unknown>[] = [];
    let notify: (method: string, params: unknown) => void = () => {};
    const streams = createChatGptConversationStreams({
      call: async <T>(method: string, params: unknown): Promise<T> => {
        if (method === "chatgpt.conversation.open") {
          const request = params as { requestId: string; body: Record<string, unknown> };
          bodies.push(request.body);
          queueMicrotask(() => notify("chatgpt.conversation.error", { requestId: request.requestId, error: "Synthetic fixture complete" }));
        }
        return undefined as T;
      },
      onNotification: (handler) => { notify = handler; return () => {}; },
      onClose: () => () => {},
    });
    const runtime = new DesktopAgentRuntime({
      sessionId: "chat-workflow", mode: "agent", thinkingLevel: "off", discussionOnly,
      provider: { id: "chat", name: "ChatGPT", modelId: "fixture", apiKey: "", authKind: "none", apiStyle: "chatgpt_conversation", supportsReasoning: false, supportedThinkingLevels: ["off"], chatGptStreams: streams },
      chatInstructions,
      chatWorkflowContext: discussionOnly ? "Project constraints: preserve published APIs. Progress: deciding next milestone." : "Work item: implement shared folders. Accepted decision: folders remain stable. Continue from verified step 2.",
      projectInstructions: { entries: [{ source: "AGENTS.md", content: "ORDINARY_REPOSITORY_INSTRUCTIONS" }] },
      commandShell,
      host: { call: async <T>(): Promise<T> => undefined as T },
      onEvent: () => {},
    });
    try {
      await runtime.prompt("What should we do next?", "workflow-user");
      expect(bodies).toHaveLength(1);
      const messages = bodies[0].messages as { author: { role: string }; content: { parts: string[] } }[];
      const users = messages.filter((message) => message.author.role === "user");
      expect(users).toHaveLength(1);
      expect(users[0].content.parts.join(" ")).toContain("<project_workflow_reference>");
      expect(users[0].content.parts.join(" ")).toContain(discussionOnly ? "preserve published APIs" : "Continue from verified step 2");
      expect(users[0].content.parts.join(" ")).toContain("What should we do next?");
      expect(JSON.stringify(messages)).not.toContain("ORDINARY_REPOSITORY_INSTRUCTIONS");
      const systems = messages.filter((message) => message.author.role === "system");
      if (chatInstructions === "") expect(systems).toEqual([]);
      else expect(systems).toHaveLength(1);
    } finally { await runtime.dispose(); }
  });

  it("keeps reference placement stable across turns without modifying the transcript", () => {
    const context = normalizeContext({ messages: [{ role: "user", content: "first", timestamp: 1 }, { role: "user", content: "second", timestamp: 2 }] });
    const decorated = withChatWorkflowContext(context, "snapshot");
    expect(decorated.messages).toHaveLength(2);
    expect(decorated.messages[0].content).toContain("snapshot");
    expect(decorated.messages[1].content).toBe("second");
    expect(context.messages[0].content).toBe("first");
    expect(withChatWorkflowContext(context, undefined)).toBe(context);
  });
});
