import { expect, it } from "vitest";
import { DesktopAgentRuntime } from "./runtime.js";

it("project discussion has no tools, extensions or delegates across mode changes", async () => {
  const provider = { id: "synthetic", name: "Synthetic", modelId: "synthetic-model",
    apiKey: "synthetic", authKind: "api_key" as const, supportsReasoning: false, supportedThinkingLevels: ["off" as const] };
  const runtime = new DesktopAgentRuntime({
    sessionId: "project-agent", mode: "plan", discussionOnly: true, provider, thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    pluginTools: [{ name: "plugin_write", description: "Mutate", parameters: { type: "object" }, risk: "low" }],
    trustedExtensions: [{ id: "must-not-load", entry: "/no/such/extension.ts", root: "/no/such", source: "plugin", label: "Must not load" }],
    host: { async call() { throw new Error("Discussion must not execute Host tools"); } },
    onEvent() {},
  });
  try {
    await runtime.loadTrustedExtensions();
    for (const mode of ["agent", "plan", "goal"] as const) {
      runtime.setMode(mode);
      expect([...(runtime as unknown as { toolCatalog: Map<string, unknown> }).toolCatalog.keys()]).toEqual([]);
    }
    expect((runtime as unknown as { extensionRunner?: unknown }).extensionRunner).toBeUndefined();
  } finally { await runtime.dispose(); }
});
