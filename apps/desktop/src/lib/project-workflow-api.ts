import { IPC, type ProjectWorkflowApi, type ProjectWorkflowChanged } from "@pi-desktop/shared";

/** Use the existing renderer invoke/error boundary; no second transport or state store. */
export function createProjectWorkflowApi(
  invoke: <T>(channel: string, input?: unknown) => Promise<T>,
  subscribe: (channel: string, listener: (...args: unknown[]) => void) => () => void,
): ProjectWorkflowApi {
  return {
    snapshot: (query = {}) => invoke(IPC.invoke.projectWorkflowSnapshot, query),
    mutate: (command) => invoke(IPC.invoke.projectWorkflowMutate, command),
    action: (action) => invoke(IPC.invoke.projectWorkflowAction, action),
    search: (request) => invoke(IPC.invoke.projectWorkflowSearch, request),
    onChanged: (listener) => subscribe(IPC.event.projectWorkflowChanged, (event) => listener(event as ProjectWorkflowChanged)),
  };
}
