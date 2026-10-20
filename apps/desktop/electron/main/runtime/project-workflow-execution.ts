import type { AgentHost } from "@pi-desktop/agent-host";
import type { HostRpc } from "@pi-desktop/host-runtime";
import type { UiMessage, WorkflowRun } from "@pi-desktop/shared";
import type { WorkflowExecutionPort, WorkflowObservation } from "./project-workflow-runtime";
import { DESKTOP_PRINCIPAL } from "../agent-host-bridge";
import { workflowTurnId } from "./project-workflow-receipt";

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
const messageId = (runId: string) => `workflow-run:${runId}`;

/** Uses the existing admission, permission, queue, transcript and cancellation path. */
export function createProjectWorkflowExecution(deps: WorkflowExecutionDependencies): WorkflowExecutionPort {
  const readTurns = new Map<string, string>();
  async function observe(run: WorkflowRun): Promise<WorkflowObservation> {
    if (!await deps.flushTranscript()) throw new Error("Workflow transcript did not flush");
    const host = deps.getHost();
    const result = await host.call<{ session?: { messages?: UiMessage[] } }>("session.get", { id: run.sessionId });
    const messages = result.session?.messages ?? [];
    const agentHost = deps.getAgentHost();
    const active = await agentHost.workSnapshot(run.sessionId);
    const queueEntry = agentHost.queue.list(run.sessionId).find((entry) => entry.userMessageId === messageId(run.id));
    if (queueEntry) return { state: "queued", content: "", effects: run.effects };
    const expectedTurnId = workflowTurnId(run) ?? readTurns.get(run.sessionId);
    if (expectedTurnId && active.activeTurnId === expectedTurnId && active.state !== "idle") {
      return { state: "executing", content: "", effects: run.effects };
    }
    let terminal: string | undefined;
    if (expectedTurnId) {
      // AgentHost has no persisted event history after restart. Absence is not success.
      try { terminal = agentHost.getTurn(expectedTurnId).status; }
      catch (error) {
        if ((error as { code?: string }).code !== "NOT_FOUND") throw error;
      }
    }
    const start = messages.findIndex((message) => message.id === messageId(run.id));
    const next = start < 0 ? -1 : messages.findIndex((message, index) => index > start && message.role === "user");
    const rows = start < 0 ? [] : messages.slice(start + 1, next < 0 ? undefined : next);
    const effects: WorkflowRun["effects"] = [...run.effects.filter((effect) => !effect.action.startsWith("tool:")), ...rows.filter((message) => message.toolName).map((message) => ({
      id: message.toolCallId ?? message.id, action: `tool:${message.toolName}`, resource: `message:${message.id}`,
      state: message.toolStatus === "success" ? "confirmed" as const : message.toolStatus === "denied" ? "failed" as const : "unknown" as const,
      detail: `Transcript ${run.sessionId}/${message.id}; tool status ${message.toolStatus ?? "unknown"}`,
    }))];
    const final = rows.filter((message) => message.role === "assistant" && message.status === "complete" && !message.parentToolCallId).at(-1);
    if (terminal === "failed" || terminal === "interrupted" || terminal === "canceled") {
      return { state: terminal === "failed" ? "failed" : terminal === "canceled" ? "cancelled" : "interrupted",
        content: final?.content ?? terminal, effects };
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
      const message: UiMessage = { id, role: "assistant", content, createdAt: new Date().toISOString(), status: "complete" };
      await deps.getHost().call("session.appendMessage", { sessionId, message });
    },
    start: async ({ run, content, authorization }) => {
      await deps.assertExecutableSession(run.sessionId);
      const result = await deps.getAgentHost().startTurn(DESKTOP_PRINCIPAL, { sessionId: run.sessionId,
        permissionCeiling: authorization.permissionCeiling, admission: "queue", idempotencyKey: run.id,
        input: { text: content, userMessageId: messageId(run.id) }, context: { requestId: run.id } });
      return { turnId: result.turn.id, queued: result.turn.status === "queued" };
    },
    read: async ({ sessionId, content, key, observeOutcome }) => {
      const result = await deps.getAgentHost().startTurn(DESKTOP_PRINCIPAL, { sessionId, permissionCeiling: "ask", admission: "queue",
        idempotencyKey: `workflow-read:${key}`, input: { text: content, userMessageId: messageId(`side:${sessionId}`) },
        context: { requestId: key } });
      if (observeOutcome) readTurns.set(sessionId, result.turn.id);
    },
    observe,
    stop: async (run, cancel) => {
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
        if (cancel) await deps.getAgentHost().interruptTurn(DESKTOP_PRINCIPAL, turn);
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
