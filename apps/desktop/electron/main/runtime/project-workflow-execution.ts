import { randomUUID } from "node:crypto";
import type { AgentHost } from "@pi-desktop/agent-host";
import type { HostRpc } from "@pi-desktop/host-runtime";
import type { UiMessage, WorkflowRun } from "@pi-desktop/shared";
import type { WorkflowExecutionPort, WorkflowObservation } from "./project-workflow-runtime";
import { DESKTOP_PRINCIPAL } from "../agent-host-bridge";
import { workflowAssignment, workflowTurnId } from "./project-workflow-receipt";

type SessionCreator = WorkflowExecutionPort["createSession"];
export type WorkflowExecutionDependencies = {
  getAgentHost: () => AgentHost;
  getHost: () => HostRpc;
  createSession: SessionCreator;
  /** Composition resolves the selected provider; consumer-only Chat is not tool execution. */
  assertExecutableSession: (sessionId: string) => Promise<void>;
  /** Flush the existing transcript queue before reading a settled outcome. */
  flushTranscript: () => Promise<boolean>;
};
const messageId = (run: WorkflowRun) => {
  if (run.executionMode !== "session") return `workflow-run:${run.id}`;
  const id = workflowAssignment(run).userMessageId;
  if (!id) throw new Error("Session workflow dispatch receipt has no user message identity");
  return id;
};
function toolEffectState(message: UiMessage, sessionExecution: boolean): WorkflowRun["effects"][number]["state"] {
  const details = (message.toolResult as { details?: { code?: unknown; approvalScope?: unknown; exitCode?: unknown } } | null)?.details;
  if (message.toolStatus === "denied" || details?.code === "WORKFLOW_RESOURCE_DENIED"
    || (details?.approvalScope === "workflow-shell" && (details.code === "TOOL_DENIED" || details.code === "TOOL_ABORTED"))) return "failed";
  // A normal nonzero exit is a completed execution receipt, not proof of a
  // passed check and not an uncertain dispatch. Signals/aborts have no exit code.
  if (message.toolName === "Bash") return typeof details?.exitCode === "number" && Number.isInteger(details.exitCode) ? "confirmed" : "unknown";
  // A failed read/search has a known outcome and no write to reconcile. Keep
  // legacy bounded observations unchanged and retain uncertainty for mutations.
  if (sessionExecution && ["Read", "Glob", "Grep", "asktool"].includes(message.toolName ?? "")
    && message.toolStatus === "error") return "failed";
  return message.toolStatus === "success" ? "confirmed" : "unknown";
}

/** Uses the existing admission, permission, queue, transcript and cancellation path. */
export function createProjectWorkflowExecution(deps: WorkflowExecutionDependencies): WorkflowExecutionPort {
  const readTurns = new Map<string, { turnId: string; messageId: string }>();
  async function observe(run: WorkflowRun): Promise<WorkflowObservation> {
    if (!await deps.flushTranscript()) throw new Error("Workflow transcript did not flush");
    const host = deps.getHost();
    const result = await host.call<{ session?: { messages?: UiMessage[] } }>("session.get", { id: run.sessionId });
    const messages = result.session?.messages ?? [];
    const agentHost = deps.getAgentHost();
    const active = await agentHost.workSnapshot(run.sessionId);
    // A session can be explicitly repurposed while its Explore turn is still
    // draining. Its transient read receipt must never identify a real Work run.
    const readTurn = run.id === `side:${run.sessionId}` ? readTurns.get(run.sessionId) : undefined;
    if (run.id === `side:${run.sessionId}` && !readTurn) {
      return { state: "unknown", content: "Explore turn identity is unavailable; inspect its session before continuing", effects: run.effects };
    }
    const userMessageId = readTurn?.messageId ?? messageId(run);
    const queueEntry = agentHost.queue.list(run.sessionId).find((entry) => entry.userMessageId === userMessageId);
    if (queueEntry) return { state: "queued", content: "", effects: run.effects };
    const expectedTurnId = workflowTurnId(run) ?? readTurn?.turnId;
    if (expectedTurnId && active.activeTurnId === expectedTurnId && active.state !== "idle") {
      return { state: "executing", content: "", effects: run.effects };
    }
    let terminal: string | undefined;
    let terminalError: string | undefined;
    if (expectedTurnId) {
      // AgentHost has no persisted event history after restart. Absence is not success.
      try {
        const turn = agentHost.getTurn(expectedTurnId);
        terminal = turn.status;
        terminalError = turn.error?.message;
      }
      catch (error) {
        if ((error as { code?: string }).code !== "NOT_FOUND") throw error;
      }
    }
    const start = messages.findIndex((message) => message.id === userMessageId);
    // Steering and promoted queued inputs belong to the current ordinary turn.
    // They cannot be used as the next-turn boundary for its final answer.
    const next = start < 0 ? -1 : messages.findIndex((message, index) => index > start && message.role === "user" && !message.steering);
    const rows = start < 0 ? [] : messages.slice(start + 1, next < 0 ? undefined : next);
    const effects: WorkflowRun["effects"] = [...run.effects.filter((effect) => !effect.action.startsWith("tool:")), ...rows.filter((message) => message.toolName).map((message) => ({
      id: message.toolCallId ?? message.id, action: `tool:${message.toolName}`, resource: `message:${message.id}`,
      state: toolEffectState(message, run.executionMode === "session"),
      detail: `Transcript ${run.sessionId}/${message.id}; tool status ${message.toolStatus ?? "unknown"}`,
    }))];
    const final = rows.filter((message) => message.role === "assistant" && message.status === "complete" && !message.parentToolCallId
      && !message.id.startsWith("workflow-context:")).at(-1);
    if (terminal === "failed" || terminal === "interrupted" || terminal === "canceled") {
      return { state: terminal === "failed" ? "failed" : terminal === "canceled" ? "cancelled" : "interrupted",
        content: terminalError ?? rows.findLast((message) => message.error)?.error?.message ?? final?.content ?? terminal, effects,
        refusedShellToolCallIds: rows.filter((message) => {
          const details = (message.toolResult as { details?: { code?: unknown; approvalScope?: unknown } } | null)?.details;
          return message.toolName === "Bash" && details?.approvalScope === "workflow-shell"
            && (details.code === "TOOL_DENIED" || details.code === "TOOL_ABORTED");
        }).map((message) => message.toolCallId ?? message.id) };
    }
    // A model's fenced string is not a terminal receipt. Recovery needs the
    // host-owned run observation persisted while the actual turn was terminal.
    if (final && (terminal === "completed" || run.state === "completed")) {
      readTurns.delete(run.sessionId);
      return { state: "completed", content: final.content, effects: terminal === "completed"
        ? effects.map((effect) => effect.id === "terminal-outcome" ? { ...effect, state: "confirmed" } : effect) : effects };
    }
    return { state: "unknown", content: "The prior dispatch has no confirmed terminal checkpoint; inspect its session and external effects before resuming",
      effects: run.effects.length ? [...effects, { id: "terminal-outcome", action: run.effects[0].action,
        resource: run.effects[0].resource, state: "unknown", detail: "No trusted terminal receipt after dispatch" }] : effects };
  }
  return {
    createSession: deps.createSession,
    appendContext: async (sessionId, content, id) => {
      const message: UiMessage = { id: `workflow-context:${id}`, role: "assistant", content, createdAt: new Date().toISOString(), status: "complete" };
      await deps.getHost().call("session.appendMessage", { sessionId, message });
    },
    start: async ({ run, content, authorization }) => {
      await deps.assertExecutableSession(run.sessionId);
      const result = await deps.getAgentHost().startTurn(DESKTOP_PRINCIPAL, { sessionId: run.sessionId,
        ...(run.executionMode === "session" ? {} : { workflowRunId: run.id, permissionCeiling: authorization!.permissionCeiling }),
        admission: "queue", idempotencyKey: run.id,
        input: { text: content, userMessageId: messageId(run) }, context: { requestId: run.id } });
      return { turnId: result.turn.id, queued: result.turn.status === "queued" };
    },
    read: async ({ sessionId, content, key, observeOutcome }) => {
      const userMessageId = randomUUID();
      const result = await deps.getAgentHost().startTurn(DESKTOP_PRINCIPAL, { sessionId, permissionCeiling: "ask", admission: "queue",
        idempotencyKey: `workflow-read:${key}`, input: { text: content, userMessageId },
        context: { requestId: key } });
      if (observeOutcome) readTurns.set(sessionId, { turnId: result.turn.id, messageId: userMessageId });
    },
    observe,
    stop: async (run, cancel, pausePendingShell) => {
      const turn = workflowTurnId(run);
      if (!turn) return { cancelledBeforeStart: false }; // Never cancel by a guessed session identity.
      try {
        if (deps.getAgentHost().getTurn(turn).status === "queued") {
          try {
            await deps.getAgentHost().cancelTurn(DESKTOP_PRINCIPAL, turn);
            return { cancelledBeforeStart: true };
          } catch (error) {
            if ((error as { code?: string }).code !== "CONFLICT") throw error;
          }
        }
        if (pausePendingShell && run.executionMode !== "session") {
          await deps.getAgentHost().stopWorkflowTurn(DESKTOP_PRINCIPAL, turn);
          return { cancelledBeforeStart: false };
        }
        if (cancel || (run.executionMode === "session" && pausePendingShell)) await deps.getAgentHost().interruptTurn(DESKTOP_PRINCIPAL, turn);
        else await deps.getAgentHost().stopTurn(DESKTOP_PRINCIPAL, turn);
      } catch (error) {
        if ((error as { code?: string }).code !== "NOT_FOUND") throw error;
        // A restarted AgentHost cannot cancel a historical turn by a guessed identity.
      }
      return { cancelledBeforeStart: false };
    },
    dispose: () => readTurns.clear(),
  };
}
