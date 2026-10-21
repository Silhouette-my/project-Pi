import { describe, expect, it } from "vitest";
import { DesktopAgentRuntime, type RuntimeMatchConfig } from "./runtime.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import {
  DEFAULT_CHAT_SYSTEM_PROMPT,
  DEFAULT_RUNTIME_SYSTEM_PROMPT,
} from "./mode-prompts.js";

const chatProvider: RuntimeProviderConfig = {
  id: "chat",
  name: "ChatGPT",
  modelId: "gpt-6",
  apiKey: "",
  authKind: "none",
  apiStyle: "chatgpt_conversation",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};

const commandShell = {
  id: "bash",
  label: "Bash",
  dialect: "posix",
  available: true,
  isDefault: true,
} as const;

function makeRuntime(options: {
  provider?: RuntimeProviderConfig;
  chatInstructions?: string;
  chatWorkflowContext?: string;
}): DesktopAgentRuntime {
  return new DesktopAgentRuntime({
    sessionId: "chat-instr",
    mode: "agent",
    thinkingLevel: "off",
    history: [],
    provider: options.provider ?? chatProvider,
    commandShell: { ...commandShell },
    host: { call: async <T>(): Promise<T> => ({}) as T },
    onEvent: () => {},
    chatWorkflowContext: options.chatWorkflowContext,
    ...(options.chatInstructions !== undefined
      ? { chatInstructions: options.chatInstructions }
      : {}),
  });
}

function internals(runtime: DesktopAgentRuntime): {
  composedSystemPrompt?: string;
  composedSections: Record<string, string>;
} {
  return runtime as unknown as {
    composedSystemPrompt?: string;
    composedSections: Record<string, string>;
  };
}

function matchConfig(overrides: { chatInstructions?: string } = {}): RuntimeMatchConfig {
  return {
    mode: "agent",
    provider: chatProvider,
    thinkingLevel: "off",
    commandShell: { ...commandShell },
    ...(overrides.chatInstructions !== undefined
      ? { chatInstructions: overrides.chatInstructions }
      : {}),
  };
}

describe("chat instruction system prompt gating", () => {
  it("uses the built-in chat persona when no chat instruction is set", async () => {
    const runtime = makeRuntime({});
    try {
      const prompt = internals(runtime).composedSystemPrompt;
      expect(prompt).toBe(DEFAULT_CHAT_SYSTEM_PROMPT);
      // The desktop agent prompt (persona, tool rules, context sections) is
      // gone entirely for chat mode.
      expect(prompt).not.toContain(DEFAULT_RUNTIME_SYSTEM_PROMPT);
      expect(prompt).not.toMatch(/\btools?\b/i);
    } finally {
      await runtime.dispose();
    }
  });

  it("sends the selected preset content verbatim", async () => {
    const runtime = makeRuntime({ chatInstructions: "Answer in haiku." });
    try {
      expect(internals(runtime).composedSystemPrompt).toBe("Answer in haiku.");
      expect(internals(runtime).composedSections).toEqual({
        runtime: "Answer in haiku.",
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("the empty-string encoding composes no system prompt at all", async () => {
    const runtime = makeRuntime({ chatInstructions: "" });
    try {
      expect(internals(runtime).composedSystemPrompt).toBe("");
      expect(internals(runtime).composedSections).toEqual({});
    } finally {
      await runtime.dispose();
    }
  });

  it("leaves non-chat providers composing the desktop agent prompt", async () => {
    const runtime = makeRuntime({
      provider: { ...chatProvider, apiStyle: undefined },
      chatInstructions: "Answer in haiku.",
    });
    try {
      const prompt = internals(runtime).composedSystemPrompt ?? "";
      expect(prompt).toContain(DEFAULT_RUNTIME_SYSTEM_PROMPT);
      expect(prompt).not.toBe("Answer in haiku.");
    } finally {
      await runtime.dispose();
    }
  });

  it("retires a reusable runtime when the chat instruction changes", async () => {
    const runtime = makeRuntime({ chatInstructions: "Answer in haiku." });
    try {
      expect(
        runtime.matches(matchConfig({ chatInstructions: "Answer in haiku." })),
      ).toBe(true);
      expect(runtime.matches(matchConfig({ chatInstructions: "" }))).toBe(false);
      expect(
        runtime.matches(matchConfig({ chatInstructions: "Other preset." })),
      ).toBe(false);
      const unconfigured = makeRuntime({});
      try {
        expect(unconfigured.matches(matchConfig())).toBe(true);
        expect(unconfigured.matches(matchConfig({ chatInstructions: "x" }))).toBe(
          false,
        );
      } finally {
        await unconfigured.dispose();
      }
    } finally {
      await runtime.dispose();
    }
  });
  it("retires the runtime when the host workflow reference changes", async () => {
    const runtime = makeRuntime({ chatInstructions: "", chatWorkflowContext: "decision 1" });
    try {
      expect(runtime.matches({ ...matchConfig({ chatInstructions: "" }), chatWorkflowContext: "decision 1" })).toBe(true);
      expect(runtime.matches({ ...matchConfig({ chatInstructions: "" }), chatWorkflowContext: "decision 2" })).toBe(false);
    } finally { await runtime.dispose(); }
  });

});
