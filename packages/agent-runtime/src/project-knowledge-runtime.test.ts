import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import type { ProjectKnowledgeSnapshot } from "@pi-desktop/shared";
import { DesktopAgentRuntime, type AgentRuntimeOptions } from "./runtime.js";

const knowledge: ProjectKnowledgeSnapshot = {
  version: 1, projectId: "project", revision: 1,
  entries: [{id:"current",kind:"knowledge",title:"Current architecture",content:"Use the existing adapter.",status:"active",
    source:{sessionId:"previous",messageId:"finding",turnId:"old-turn"},createdAt:1,updatedAt:1}],
};

function options(overrides: Partial<AgentRuntimeOptions> = {}): AgentRuntimeOptions {
  return {
    sessionId:"session",mode:"agent",thinkingLevel:"off",host:{call:vi.fn()},
    commandShell:{id:"bash",label:"Bash",dialect:"posix",available:true,isDefault:true},
    provider:{id:"local",name:"Local",baseUrl:"http://127.0.0.1:11434/v1",modelId:"local-model",apiKey:"",authKind:"none",supportsReasoning:false,supportedThinkingLevels:["off"]},
    projectPath:"/project",projectKnowledge:knowledge,onEvent:vi.fn(),...overrides,
  };
}

function state(runtime: DesktopAgentRuntime): Agent["state"] {
  return (runtime as unknown as {agent:Agent}).agent.state;
}

describe("project knowledge runtime wiring", () => {
  it("exposes real Host-backed tools and refreshes its effective notes after a correction", async () => {
    const updated: ProjectKnowledgeSnapshot = {...knowledge,revision:2,entries:[{...knowledge.entries[0],id:"corrected",content:"Use the corrected adapter."}]};
    const call = vi.fn(async (_method:string,_params?:unknown) => ({ok:true,content:updated}));
    const input = options({host:{call:async <T>(method:string,params?:unknown) => await call(method,params) as T}});
    const runtime = new DesktopAgentRuntime(input);
    expect(state(runtime).systemPrompt).toContain("Use the existing adapter.");
    const tool = state(runtime).tools.find((entry:AgentTool) => entry.name === "ProjectKnowledgeWrite")!;
    expect(tool).toBeDefined();
    await tool.execute("write-note",{action:"replace",expectedProjectId:"project",expectedRevision:1,entryId:"current",kind:"knowledge",title:"Current architecture",content:"Use the corrected adapter."});
    expect(call).toHaveBeenCalledWith("tools.execute",expect.objectContaining({sessionId:"session",toolName:"ProjectKnowledgeWrite"}));
    expect(state(runtime).systemPrompt).toContain("Use the corrected adapter.");
    expect(state(runtime).systemPrompt).not.toContain("Use the existing adapter.");
    expect(runtime.matches({...input,projectKnowledge:knowledge})).toBe(false);
    expect(runtime.matches({...input,projectKnowledge:updated})).toBe(true);
    await runtime.dispose();
  });

  for (const variant of [{mode:"plan" as const},{discussionOnly:true}]) {
    it(`keeps notes read-only for ${"mode" in variant ? variant.mode : "Project Agent discussion"}`, async () => {
      const runtime = new DesktopAgentRuntime(options(variant));
      expect(state(runtime).systemPrompt).toContain("Use the existing adapter.");
      expect(state(runtime).systemPrompt).toContain("read-only reference context");
      expect(state(runtime).systemPrompt).not.toContain("use ProjectKnowledgeRead/ProjectKnowledgeWrite");
      expect(state(runtime).tools.some((tool:AgentTool) => tool.name === "ProjectKnowledgeWrite")).toBe(false);
      await runtime.dispose();
    });
  }
});
