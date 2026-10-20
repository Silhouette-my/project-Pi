import {
  ErrorCodes, IPC, isProjectWorkflowAction, isProjectWorkflowUserCommand,
  type ProjectWorkflowHostPort, type ProjectWorkflowRuntimePort,
} from "@pi-desktop/shared";
import { workflowHost, type WorkflowHostConnection } from "../services/project-workflow-host";
import type { IpcRegistrar } from "./types";
import { openProjectWorkflowReference } from "../services/project-workflow-reference";

export type ProjectWorkflowIpcDependencies = {
  registrar: IpcRegistrar;
  host: ProjectWorkflowHostPort;
  getHost: () => WorkflowHostConnection | null;
  getRuntime: () => ProjectWorkflowRuntimePort | null;
  openPath(path: string): Promise<string>;
  openExternal(url: string): Promise<void>;
};

export function registerProjectWorkflowIpc({ registrar, host, getHost, getRuntime, openPath, openExternal }: ProjectWorkflowIpcDependencies): void {
  // These are user actions. Do not register them on the external-agent invoke map
  // or weaken the existing plugin collaboration provenance boundary.
  registrar.handleWithEvent(IPC.invoke.projectWorkflowSnapshot, async (event, input = {}) => {
    registrar.assertMainWindowSender(event);
    return workflowHost(getHost).call("project.workflow.snapshot", input);
  });
  registrar.handleWithEvent(IPC.invoke.projectWorkflowSearch, async (event, input: unknown) => {
    registrar.assertMainWindowSender(event);
    return workflowHost(getHost).call("project.workflow.search", input);
  });
  registrar.handleWithEvent(IPC.invoke.projectWorkflowOpenReference, async (event, input: unknown) => {
    registrar.assertMainWindowSender(event);
    return openProjectWorkflowReference({ host, getHost, openPath, openExternal }, input);
  });
  registrar.handleWithEvent(IPC.invoke.projectWorkflowMutate, async (event, input: unknown) => {
    registrar.assertMainWindowSender(event);
    if (!isProjectWorkflowUserCommand(input)) {
      throw Object.assign(new Error("Invalid user workflow command"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
    }
    return host.mutate(input);
  });
  registrar.handleWithEvent(IPC.invoke.projectWorkflowAction, async (event, input: unknown) => {
    registrar.assertMainWindowSender(event);
    if (!isProjectWorkflowAction(input)) {
      throw Object.assign(new Error("Invalid workflow action"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
    }
    const runtime = getRuntime();
    if (!runtime) throw Object.assign(new Error("Workflow runtime unavailable"), { errorCode: ErrorCodes.AGENT_UNAVAILABLE });
    return runtime.action(input);
  });
}
