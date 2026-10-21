import type { AgentHost } from "@pi-desktop/agent-host";
import type { HostRpc } from "@pi-desktop/host-runtime";
import { ErrorCodes, type AppSettings, type ProjectGroupRecord, type ProjectWorkflowHostPort, type ProjectWorkflowRuntimePort,
  type ProviderPublic, type SessionDetail } from "@pi-desktop/shared";
import { createProjectWorkflowExecution } from "../runtime/project-workflow-execution";
import { assembleProjectAgentContext } from "../runtime/project-workflow-context";
import { createProjectWorkflowRuntime, type WorkflowExecutionPort } from "../runtime/project-workflow-runtime";

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code, errorCode: code });
}

export type ProjectWorkflowDesktopDependencies = {
  host: ProjectWorkflowHostPort;
  getHost(): HostRpc;
  getAgentHost(): AgentHost;
  flushTranscript(): Promise<boolean>;
  onSessionsChanged(): void;
};

/** Production session creation retains existing project/provider/permission paths. */
export function createWorkflowSessionFactory(deps: Pick<ProjectWorkflowDesktopDependencies, "getHost" | "onSessionsChanged">) {
  const readSession = async (sessionId: string): Promise<SessionDetail> => {
    const { session } = await deps.getHost().call<{ session?: SessionDetail }>("session.get", { id: sessionId });
    if (!session) fail(ErrorCodes.NOT_FOUND, "Workflow session not found");
    return session;
  };
  const assertExecutable = async (session: Pick<SessionDetail, "mode" | "providerId">) => {
    if (session.mode !== "agent") fail(ErrorCodes.INVALID_ARGUMENT, "Choose an Agent session for project execution");
    const host = deps.getHost();
    const [settings, { providers }] = await Promise.all([
      host.call<AppSettings>("settings.get"), host.call<{ providers: ProviderPublic[] }>("providers.list"),
    ]);
    const provider = providers.find((record) => record.id === (session.providerId || settings.defaultProviderId));
    if (!provider || provider.enabled === false) fail(ErrorCodes.INVALID_ARGUMENT, "Choose a configured Agent model before starting project work");
    if (provider.apiStyle === "chatgpt_conversation") {
      fail(ErrorCodes.INVALID_ARGUMENT, "Consumer Chat is discussion-only; choose an executable Agent session for project work");
    }
  };
  const createSession: WorkflowExecutionPort["createSession"] = async ({ projectId, sourceSessionId, purpose }) => {
    const host = deps.getHost();
    const { groups } = await host.call<{ groups: ProjectGroupRecord[] }>("project.groups.list");
    const group = groups.find((record) => record.id === projectId);
    if (!group) fail(ErrorCodes.NOT_FOUND, "Workflow project not found");
    if (group.remote) fail(ErrorCodes.UNSUPPORTED, "Project workflow execution currently requires a local project");
    const source = sourceSessionId ? await readSession(sourceSessionId) : undefined;
    if (source?.projectPath && !group.roots.some((root) => root.path === source.projectPath)) {
      fail(ErrorCodes.INVALID_ARGUMENT, "Source session belongs to another project");
    }
    const mode = purpose === "work" ? "agent" : "plan";
    if (purpose === "work") await assertExecutable({ mode, providerId: source?.providerId });
    const { session } = await host.call<{ session: SessionDetail }>("session.create", {
      title: source?.title || group.name, mode, projectPath: source?.projectPath || group.primaryPath,
      ...(source?.providerId ? { providerId: source.providerId } : {}),
      ...(source?.modelId ? { modelId: source.modelId } : {}),
      ...(source?.thinkingLevel ? { thinkingLevel: source.thinkingLevel } : {}),
      ...(source ? { inheritPermissionFromSessionId: source.id } : {}),
    });
    deps.onSessionsChanged();
    return session.id;
  };
  return { createSession, assertExecutable: async (sessionId: string) => {
    const snapshot = await deps.getHost().call<import("@pi-desktop/shared").ProjectWorkflowSnapshot>("project.workflow.snapshot", {});
    if (snapshot.projectAgents?.some((agent) => agent.sessionId === sessionId)) {
      fail(ErrorCodes.INVALID_ARGUMENT, "Project Agent discussion cannot become an execution session");
    }
    await assertExecutable(await readSession(sessionId));
  } };
}

/** One lifecycle owner: startup reconciliation precedes any workflow dispatch. */
export function createDesktopProjectWorkflow(deps: ProjectWorkflowDesktopDependencies) {
  let ready = false;
  let disposed = false;
  const pendingSettlements = new Set<string>();
  const sessions = createWorkflowSessionFactory(deps);
  const execution = createProjectWorkflowExecution({ ...deps, createSession: sessions.createSession,
    assertExecutableSession: sessions.assertExecutable });
  const coordinator = createProjectWorkflowRuntime({ host: deps.host, execution });
  let openTail: Promise<unknown> = Promise.resolve();
  const openAgent: ProjectWorkflowRuntimePort["action"] = (input) => {
    const opened = openTail.then(async () => {
      if (input.kind !== "agent.open") fail(ErrorCodes.INVALID_ARGUMENT, "Invalid Project Agent action");
      // Action results replace the renderer's global workflow projection, just
      // like mutation results. Never return a project-filtered snapshot here.
      const snapshot = await deps.host.snapshot();
      const linked = snapshot.projectAgents?.find((agent) => agent.projectId === input.projectId);
      if (linked) {
        const { session } = await deps.getHost().call<{ session?: SessionDetail }>("session.get", { id: linked.sessionId });
        if (session) return { snapshot, sessionId: session.id };
      }
      if (input.expectedRevision !== snapshot.revision) fail(ErrorCodes.CONFLICT, "The project changed; refresh before opening its Agent");
      const result = await deps.host.mutate({ kind: "agent.create", projectId: input.projectId,
        commandId: input.commandId, expectedRevision: snapshot.revision });
      const sessionId = result.snapshot.projectAgents!.find((agent) => agent.projectId === input.projectId)!.sessionId;
      deps.onSessionsChanged();
      return { snapshot: result.snapshot, sessionId };
    });
    openTail = opened.catch(() => undefined);
    return opened;
  };
  const runtime: ProjectWorkflowRuntimePort = {
    async action(input) {
      if (!ready) fail(ErrorCodes.AGENT_UNAVAILABLE, "Project workflow is not ready");
      if (input.kind === "agent.open") return openAgent(input);
      if (input.kind === "start") {
        const snapshot = await deps.host.snapshot({ projectId: input.projectId, workstreamId: input.workstreamId });
        const sessionId = input.sessionId || snapshot.workstreams[0]?.mainSessionId;
        if (sessionId) await sessions.assertExecutable(sessionId);
      }
      return coordinator.action(input);
    },
    onHostChanged: (event) => ready ? coordinator.onHostChanged?.(event) : undefined,
  };
  return {
    runtime,
    async initialize() {
      await coordinator.recoverAll();
      while (!disposed && pendingSettlements.size) {
        for (const sessionId of [...pendingSettlements]) {
          if (disposed) break;
          pendingSettlements.delete(sessionId);
          try { await coordinator.onTurnSettled(sessionId); }
          catch (error) {
            if (!disposed) pendingSettlements.add(sessionId);
            throw error;
          }
        }
      }
      if (!disposed) ready = true;
    },
    onTurnSettled: (sessionId: string) => {
      if (disposed) return Promise.resolve();
      if (!ready) { pendingSettlements.add(sessionId); return Promise.resolve(); }
      return coordinator.onTurnSettled(sessionId);
    },
    async isProjectAgentSession(sessionId: string) {
      const snapshot = await deps.host.snapshot();
      return snapshot.projectAgents?.some((agent) => agent.sessionId === sessionId) ?? false;
    },
    async contextForSession(sessionId: string) {
      if (!ready) return undefined;
      const snapshot = await deps.host.snapshot();
      const agent = snapshot.projectAgents?.find((agent) => agent.sessionId === sessionId);
      return agent ? assembleProjectAgentContext(snapshot, agent.projectId) : coordinator.contextForSession(sessionId);
    },
    async dispose() { disposed = true; ready = false; pendingSettlements.clear(); await coordinator.dispose?.(); },
  };
}
