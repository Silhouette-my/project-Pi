import { describe, expect, it } from "vitest";
import { IPC, IPC_WHITELIST } from "./protocol.js";
import { normalizeApiStyle } from "./model-catalog.js";
import { inferEndpointProfile } from "./provider-endpoint.js";

describe("ChatGPT chat provider contract", () => {
  it("allows session management IPC without exposing the conversation transport to renderer", () => {
    for (const channel of [IPC.invoke.chatgptChatStatus, IPC.invoke.chatgptChatLogin, IPC.invoke.chatgptChatLogout, IPC.invoke.chatgptChatImportLogin]) {
      expect(IPC_WHITELIST.has(channel)).toBe(true);
    }
    expect(IPC_WHITELIST.has("chatgpt.conversation.open")).toBe(false);
    expect(IPC_WHITELIST.has("chatgpt.conversation.cancel")).toBe(false);
  });

  it("preserves its own wire format when a conversation URL is pasted", () => {
    expect(normalizeApiStyle("chatgpt_conversation")).toBe("chatgpt_conversation");
    expect(inferEndpointProfile({
      baseUrl: "https://chatgpt.com/backend-api/conversation",
      apiStyle: "chatgpt_conversation",
      explicitApiStyle: true,
    })).toMatchObject({
      apiStyle: "chatgpt_conversation",
      effectiveBaseUrl: "https://chatgpt.com/backend-api",
    });
  });
});
