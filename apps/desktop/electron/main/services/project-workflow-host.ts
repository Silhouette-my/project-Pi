import {
  ErrorCodes, isProjectWorkflowCommand, type ProjectWorkflowChanged, type ProjectWorkflowCommand,
  type ProjectWorkflowHostPort, type ProjectWorkflowMutationResult, type ProjectWorkflowSnapshot,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";

export type WorkflowHostConnection = Pick<HostProcess, "call">;
export function workflowHost(getHost: () => WorkflowHostConnection | null): WorkflowHostConnection {
  const host = getHost();
  if (!host) throw Object.assign(new Error("Host unavailable"), { errorCode: ErrorCodes.HOST_UNAVAILABLE });
  return host;
}

export function workflowChange(command: ProjectWorkflowCommand, revision: number): ProjectWorkflowChanged {
  const event: ProjectWorkflowChanged = { revision, commandId: command.commandId, kind: command.kind };
  if ("projectId" in command) return { ...event, projectId: command.projectId, workstreamId: command.workstreamId };
  for (const record of [
    "workstream" in command ? command.workstream : undefined,
    "conversation" in command ? command.conversation : undefined,
    "resource" in command ? command.resource : undefined,
    "decision" in command ? command.decision : undefined,
    "authorization" in command ? command.authorization : undefined,
    "artifact" in command ? command.artifact : undefined,
    "evidence" in command ? command.evidence : undefined,
    "feedback" in command ? command.feedback : undefined,
    "run" in command ? command.run : undefined,
    "delivery" in command ? command.delivery : undefined,
  ]) {
    if (record) return { ...event, projectId: record.projectId,
      workstreamId: "workstreamId" in record ? record.workstreamId : record.id };
  }
  return event;
}

/** All runtime and user writes pass the same durable mutation and event path. */
export function createProjectWorkflowHostPort(
  getHost: () => WorkflowHostConnection | null,
  publish: (event: ProjectWorkflowChanged) => void,
): ProjectWorkflowHostPort {
  return {
    snapshot: (query = {}) => workflowHost(getHost).call<ProjectWorkflowSnapshot>("project.workflow.snapshot", query),
    async mutate(command) {
      if (!isProjectWorkflowCommand(command)) {
        throw Object.assign(new Error("Invalid workflow command"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
      }
      const result = await workflowHost(getHost).call<ProjectWorkflowMutationResult>("project.workflow.mutate", command);
      if (!result.replayed) publish(workflowChange(command, result.snapshot.revision));
      return result;
    },
  };
}
