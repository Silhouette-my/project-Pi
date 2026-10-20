import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Mode } from "@pi-desktop/shared";

/** Known editing/delegation names stay declared across contract-mode changes. */
const RETAINED_MODE_TOOLS = new Set(["Write", "Edit", "Task", "TaskWait", "TaskList", "TaskStop"]);

export function retainModeToolDeclaration(name: string): boolean {
  return RETAINED_MODE_TOOLS.has(name);
}

export function modeToolDenial(name: string, mode: Mode): string {
  return `${name} is not allowed in ${mode} mode. No action was performed. Continue read-only inspection and planning with the permitted tools; implementation requires Agent mode or approval of the submitted plan or goal.`;
}

/**
 * A workflow has no OS sandbox around local processes or extension providers.
 * File effects stay contained by Host. Foreground Bash is a separate authority:
 * Host requires a new exact-call user approval, never an inherited scope grant.
 */
const WORKFLOW_CONTAINABLE_TOOLS = new Set(["Read", "Write", "Edit", "asktool"]);

export function workflowToolDenial(name: string, params?: unknown): string | undefined {
  if (name === "Bash") {
    return (params as { runInBackground?: unknown } | null)?.runInBackground === true
      ? "Workflow Bash must run in the foreground with a separate one-time user approval. Background execution is not authorized."
      : undefined;
  }
  if (WORKFLOW_CONTAINABLE_TOOLS.has(name)) return undefined;
  return `Workflow runs cannot execute ${name}: its effects are not contained by the assigned resource scope. Use Read, Write, or Edit on assigned resources; for an uncontained effect, choose a contained execution capability instead of broadening resource authorization.`;
}

/**
 * Declarations are not grants. Recheck immediately before execution, including
 * references retained from an earlier mode. Throwing here uses pi's existing
 * tool-error channel and the real call id, without inventing transcript items.
 */
export function withModeExecutionGuard(
  tool: AgentTool,
  denial: (params?: unknown) => string | undefined,
  onDenial?: (reason: string, toolCallId?: string, params?: unknown) => void,
): AgentTool {
  const currentDenial = denial();
  return {
    ...tool,
    description: currentDenial ? `${tool.description}\n\n${currentDenial}` : tool.description,
    execute: async (...args) => {
      const reason = denial(args[1]);
      if (reason) {
        onDenial?.(reason, typeof args[0] === "string" ? args[0] : undefined, args[1]);
        throw new Error(reason);
      }
      return tool.execute(...args);
    },
  };
}
