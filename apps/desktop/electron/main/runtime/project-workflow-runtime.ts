import { randomUUID } from "node:crypto";
import type {
  ProjectWorkflowAction, ProjectWorkflowActionResult, ProjectWorkflowCommand, ProjectWorkflowHostPort,
  ProjectWorkflowRuntimePort, ProjectWorkflowSnapshot, WorkflowAuthorization, WorkflowConversation,
  WorkflowDelivery, WorkflowRun, WorkflowWorkstream,
} from "@pi-desktop/shared";
import { assembleWorkflowContext, WORKFLOW_CHECKPOINT_INSTRUCTIONS } from "./project-workflow-context";
import { parseWorkflowCheckpoint, type WorkflowCheckpoint, type WorkflowStep } from "./project-workflow-checkpoint";
import { workflowAssignment } from "./project-workflow-receipt";
import { conflictingWorkflowRun } from "./project-workflow-resources";

export type WorkflowObservation = { state: WorkflowRun["state"]; content: string; effects: WorkflowRun["effects"] };
export interface WorkflowExecutionPort {
  createSession(input: { projectId: string; sourceSessionId?: string; purpose: WorkflowConversation["purpose"] }): Promise<string>;
  appendContext(sessionId: string, content: string, messageId: string): Promise<void>;
  start(input: { run: WorkflowRun; content: string; authorization: WorkflowAuthorization }): Promise<{ turnId: string; queued: boolean }>;
  read(input: { sessionId: string; content: string; key: string; observeOutcome?: boolean }): Promise<void>;
  observe(run: WorkflowRun): Promise<WorkflowObservation>;
  stop(run: WorkflowRun, cancel: boolean): Promise<{ cancelledBeforeStart: boolean }>;
  dispose?(): void;
}
export type ProjectWorkflowRuntimeDependencies = {
  host: ProjectWorkflowHostPort; execution: WorkflowExecutionPort;
  now?: () => string; id?: () => string;
};
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code, errorCode: code }); }
const live = (r: WorkflowRun) => r.state === "queued" || r.state === "executing";
const scope = (w: WorkflowWorkstream) => ({ projectId: w.projectId, workstreamId: w.id });
type WithoutCommandMetadata<T> = T extends unknown ? Omit<T, "expectedRevision" | "commandId"> : never;

/** Single local coordinator; all durable transitions and conflict checks stay in Host. */
export function createProjectWorkflowRuntime(deps: ProjectWorkflowRuntimeDependencies): ProjectWorkflowRuntimePort & {
  recoverAll(): Promise<void>;
  onTurnSettled(sessionId: string): Promise<void>;
  contextForSession(sessionId: string): Promise<string | undefined>;
} {
  const now = deps.now ?? (() => new Date().toISOString());
  const id = deps.id ?? randomUUID;
  let tail: Promise<unknown> = Promise.resolve();
  let disposed = false;
  let recovering = false;
  const deferredContinuations = new Map<string, { workstreamId: string; authId?: string; next?: WorkflowStep; freshUserStart: boolean }>();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(() => { if (disposed) fail("ABORTED", "Workflow runtime is disposed"); return fn(); });
    tail = result.catch(() => undefined); // The caller still receives the original rejection.
    return result;
  }
  let state: ProjectWorkflowSnapshot;
  const reload = async () => { state = await deps.host.snapshot(); };
  async function mutate(command: WithoutCommandMetadata<ProjectWorkflowCommand>, commandId = id()) {
    const result = await deps.host.mutate({ ...command, commandId, expectedRevision: state.revision });
    state = result.snapshot;
  }
  const work = (workstreamId: string, projectId?: string): WorkflowWorkstream => {
    const found = state.workstreams.find((w) => w.id === workstreamId && (!projectId || w.projectId === projectId));
    if (!found) fail("NOT_FOUND", "Workstream not found");
    return found;
  };
  async function transition(w: WorkflowWorkstream, status: WorkflowWorkstream["status"], nextAction: string, reason?: string) {
    const current = work(w.id);
    if (current.status === status && current.nextAction === nextAction && current.blocker?.reason === reason) return;
    await mutate({ kind: "workstream.transition", ...scope(w), status, nextAction,
      ...(reason ? { blocker: { reason, owner: w.owner.ref, resumeWhen: nextAction } } : {}) });
  }
  function authorization(w: WorkflowWorkstream, authorizationId: string, step?: WorkflowStep): WorkflowAuthorization {
    const auth = state.authorizations.find((a) => a.id === authorizationId && a.projectId === w.projectId && a.workstreamId === w.id);
    if (!auth || !auth.actions.length || !auth.resources.length || auth.revoked || auth.source.kind !== "user" || (auth.expiresAt
      && (!Number.isFinite(Date.parse(auth.expiresAt)) || Date.parse(auth.expiresAt) <= Date.parse(now())))) {
      fail("UNAUTHORIZED", "A current user authorization is required");
    }
    if (state.runs.filter((r) => r.authorizationId === auth.id).length >= auth.maxRuns) fail("UNAUTHORIZED", "Authorized run budget is exhausted");
    if (step && (!auth.actions.includes(step.action) || !step.resources.every((r) => auth.resources.includes(r)))) {
      fail("UNAUTHORIZED", "The next step exceeds the authorized action/resource scope");
    }
    return auth;
  }
  function currentRuns(w: WorkflowWorkstream) { return state.runs.filter((r) => r.workstreamId === w.id && live(r)); }
  async function assertResourcesAvailable(resources: string[]) {
    const conflict = await conflictingWorkflowRun(state, resources);
    if (conflict) fail("CONFLICT", `Resource scope is owned by active run ${conflict.id} in workstream ${conflict.workstreamId}; choose an explicit disjoint authorization or wait for its checkpoint`);
  }
  function conversation(sessionId: string) { return state.conversations.find((c) => c.sessionId === sessionId); }
  async function link(w: WorkflowWorkstream, sessionId: string, overrides: Partial<WorkflowConversation> = {}) {
    await mutate({ kind: "conversation.link", conversation: {
      sessionId, ...scope(w), sourceRevision: w.decisionRevision, relation: "main", purpose: "work", visibility: "project",
      readContext: { resourceIds: state.resources.filter((r) => r.projectId === w.projectId).map((r) => r.id), includeDecisions: true, includeArtifacts: true },
      returnPolicy: "delivery", archived: false, order: state.conversations.length, ...overrides,
    } });
  }
  async function dispatch(w: WorkflowWorkstream, sessionId: string, auth: WorkflowAuthorization, step: WorkflowStep, key: string, deliveries: WorkflowDelivery[] = []) {
    if (currentRuns(w).some((r) => r.sessionId === sessionId)) return;
    const run: WorkflowRun = { id: `workflow:${key}`, ...scope(w), sessionId, executor: "agent-host",
      workstreamRevision: w.revision, decisionRevision: w.decisionRevision, authorizationId: auth.id,
      state: "queued", outcome: "", effects: step.resources.map((resource, index) => ({
        id: index === 0 ? "dispatch" : `scope:${index}`, action: step.action, resource, state: "planned",
        detail: index === 0 ? JSON.stringify({ step, deliveryIds: deliveries.map((d) => d.id) }) : "Authorized bounded assignment scope",
      })),
      startedAt: now(), updatedAt: now() };
    if (state.runs.some((r) => r.id === run.id)) return;
    await assertResourcesAvailable(step.resources);
    await mutate({ kind: "run.start", run }, `${run.id}:start`);
    const pending = deliveries.length ? `\nResults to consume:\n${JSON.stringify(deliveries)}` : "";
    let admitted = false;
    try {
      if (disposed) fail("ABORTED", "Workflow stopped before dispatch");
      await reload();
      const latestAuth = state.authorizations.find((a) => a.id === auth.id);
      const current = work(w.id);
      if (!latestAuth || latestAuth.revoked || JSON.stringify(latestAuth) !== JSON.stringify(auth)
        || current.decisionRevision !== run.decisionRevision || ["paused", "cancelled"].includes(current.status)) {
        fail("CONFLICT", "The work scope changed before dispatch");
      }
      const result = await deps.execution.start({ run, authorization: auth,
        content: assembleWorkflowContext(state, w, { conversation: conversation(sessionId), authorization: auth })
          + pending + `\nRun identity: ${run.id}\nAssigned action: ${step.action}\nAssigned resources: ${JSON.stringify(step.resources)}`
          + "\n\nAssignment:\n" + step.prompt + "\n\n" + WORKFLOW_CHECKPOINT_INSTRUCTIONS });
      admitted = true;
      await mutate({ kind: "run.observe", ...scope(w), runId: run.id, state: result.queued ? "queued" : "executing", outcome: "",
        effects: [{ ...run.effects[0], state: "confirmed", detail: JSON.stringify({ ...workflowAssignment(run), turnId: result.turnId }) }, ...run.effects.slice(1)] });
    } catch (error) {
      const code = (error as { code?: string; errorCode?: string } | null)?.errorCode ?? (error as { code?: string } | null)?.code;
      const rejected = !admitted && ["ABORTED", "FORBIDDEN", "INVALID_ARGUMENT", "NOT_FOUND", "AGENT_BUSY", "WORKSPACE_CHANGED", "IDEMPOTENCY_CONFLICT", "CONFLICT"].includes(code ?? "");
      // Explicit admission rejection did not execute; an uncertain RPC may have.
      await reload();
      const recorded = state.runs.find((record) => record.id === run.id)!;
      const effects: WorkflowRun["effects"] = recorded.effects.map((effect) => effect.id === "dispatch" && effect.state !== "confirmed"
        ? { ...effect, state: rejected ? "failed" : "unknown" } : effect);
      if (!rejected && recorded.effects[0].state === "confirmed") effects.push({ ...recorded.effects[0], id: "dispatch-outcome", state: "unknown", detail: String(error) });
      await mutate({ kind: "run.observe", ...scope(w), runId: run.id, state: rejected ? "failed" : "unknown", outcome: String(error),
        effects });
      await transition(w, "awaiting_user", rejected ? "Resolve the admission rejection before starting work" : "Reconcile the uncertain dispatch before resuming", String(error));
      throw error;
    }
  }
  async function stopRuns(w: WorkflowWorkstream, cancel: boolean) {
    for (const run of currentRuns(w)) {
      const result = await deps.execution.stop(run, cancel);
      if (result.cancelledBeforeStart && !cancel) {
        await mutate({ kind: "run.observe", ...scope(w), runId: run.id, state: "cancelled", outcome: "Paused before runtime admission; no external work executed",
          effects: run.effects, completionKey: `${run.id}:paused-before-start` });
      }
    }
  }
  async function continueWork(w: WorkflowWorkstream, authId?: string, next?: WorkflowStep, key = id(), freshUserStart = false) {
    if (recovering) {
      deferredContinuations.set(key, { workstreamId: w.id, authId, next, freshUserStart });
      return;
    }
    if (["paused", "cancelled", "completed", "draft", "awaiting_user"].includes(w.status)) return;
    if (currentRuns(w).some((r) => conversation(r.sessionId)?.relation === "main")) return;
    if (w.dependencyIds.some((dep) => state.workstreams.find((d) => d.id === dep)?.status !== "completed")) {
      await transition(w, "blocked", w.nextAction, "A workstream dependency is not complete"); return;
    }
    if (state.workstreams.some((other) => other.id !== w.id && other.owner.ref === w.owner.ref && other.owner.kind === w.owner.kind
      && state.runs.some((r) => r.workstreamId === other.id && live(r)))) {
      await transition(w, "blocked", w.nextAction, "The accountable owner is executing another workstream"); return;
    }
    const latest = state.runs.filter((r) => r.workstreamId === w.id && conversation(r.sessionId)?.relation === "main").at(-1);
    if (!next && w.status === "blocked" && latest?.state === "completed" && latest.decisionRevision === w.decisionRevision) {
      next = parseWorkflowCheckpoint(latest.outcome).next;
    }
    if (latest && ["unknown", "interrupted", "failed", "cancelled"].includes(latest.state)
      && !latest.completionKey?.endsWith(":paused-before-start")
      && (!freshUserStart || latest.state === "unknown" || latest.effects.some((effect) => effect.state === "unknown"))) {
      await transition(w, "awaiting_user", "Resolve the last execution outcome before resuming", latest.outcome); return;
    }
    const authorizationId = authId ?? latest?.authorizationId;
    if (!authorizationId) { await transition(w, "awaiting_user", "Authorize the next work step"); return; }
    let auth: WorkflowAuthorization;
    try { auth = authorization(w, authorizationId, next); }
    catch (error) { await transition(w, "awaiting_user", "Authorize the exact next action and resources", String(error)); return; }
    const pending = state.deliveries.filter((d) => d.workstreamId === w.id && d.state === "delivered" && d.disposition === "pending");
    const deliveries: WorkflowDelivery[] = [];
    for (const delivery of pending) {
      if (delivery.decisionRevision !== w.decisionRevision || delivery.kind === "proposal") {
        await mutate({ kind: "delivery.consume", ...scope(w), deliveryId: delivery.id,
          disposition: delivery.decisionRevision !== w.decisionRevision ? "stale" : "retained" });
      } else deliveries.push(delivery);
    }
    const sessionId = w.mainSessionId ?? (w.owner.kind === "session" ? w.owner.ref : undefined);
    if (!sessionId) { await transition(w, "awaiting_user", "Choose a main execution session"); return; }
    const step = next ?? { action: auth.actions[0], resources: auth.resources, prompt: w.nextAction };
    if (!step.action || !step.prompt || !step.resources.length) { await transition(w, "awaiting_user", "Specify the next bounded action"); return; }
    const conflict = await conflictingWorkflowRun(state, step.resources);
    if (conflict) { await transition(w, "blocked", step.prompt, `Resource scope is owned by active run ${conflict.id}; continue after that run checkpoints`); return; }
    await transition(w, "executing", step.prompt);
    await dispatch(work(w.id), sessionId, auth, step, key, deliveries);
  }
  async function settle(run: WorkflowRun) {
    if (run.completionKey && run.state !== "unknown") return;
    const observation = await deps.execution.observe(run);
    if (live({ ...run, state: observation.state })) return;
    const w = work(run.workstreamId);
    const completionKey = `${run.id}:terminal`;
    if (run.state === "queued" && observation.state === "completed") {
      await mutate({ kind: "run.observe", ...scope(w), runId: run.id, state: "executing", outcome: "Runtime admission confirmed before terminal receipt",
        effects: observation.effects }, `${run.id}:admitted`);
    }
    await mutate({ kind: "run.observe", ...scope(w), runId: run.id, state: observation.state,
      outcome: observation.content, effects: observation.effects }, `${run.id}:observed:${observation.state}`);
    const finish = () => mutate({ kind: "run.observe", ...scope(w), runId: run.id, state: observation.state,
      outcome: observation.content, effects: observation.effects, completionKey }, `${completionKey}:${observation.state}`);
    if (observation.state !== "completed" || observation.effects.some((effect) => effect.state === "unknown")) {
      if (!["paused", "cancelled"].includes(w.status)) await transition(w, "awaiting_user", "Reconcile the actual execution outcome", observation.content);
      await finish();
      return;
    }
    let report: WorkflowCheckpoint;
    try { report = parseWorkflowCheckpoint(observation.content); }
    catch (error) { if (!["paused", "cancelled"].includes(w.status)) await transition(w, "awaiting_user", "Review the missing or invalid work checkpoint", String(error)); await finish(); return; }
    const side = conversation(run.sessionId)?.relation !== "main";
    const stale = run.decisionRevision !== w.decisionRevision;
    const offered = workflowAssignment(run).deliveryIds;
    for (const deliveryId of report.consumedDeliveryIds) {
      if (!offered.includes(deliveryId)) fail("INVALID_ARGUMENT", "The checkpoint acknowledged a result not offered to this run");
      const delivery = state.deliveries.find((d) => d.id === deliveryId);
      if (delivery?.state === "delivered") await mutate({ kind: "delivery.consume", ...scope(w), deliveryId,
        disposition: stale || delivery.decisionRevision !== w.decisionRevision ? "stale" : "integrated" }, `${run.id}:consume:${deliveryId}`);
    }
    for (const artifact of stale ? [] : report.artifacts) {
      await mutate({ kind: "artifact.put", artifact: { ...artifact, ...scope(w), runId: run.id, source: { kind: "run", ref: run.id } } }, `${run.id}:artifact:${artifact.id}`);
    }
    const candidate = !side && !stale ? report.artifacts.filter((a) => a.kind === "candidate").at(-1) : undefined;
    if (candidate) await mutate({ kind: "workstream.update", ...scope(w), patch: { currentCandidateId: candidate.id } }, `${run.id}:candidate`);
    for (const evidence of stale ? [] : report.evidence) {
      await mutate({ kind: "evidence.add", evidence: { ...evidence, ...scope(w), source: { kind: "run", ref: run.id },
        limits: `Agent-reported checkpoint; verify against the linked source. ${evidence.limits}` } }, `${run.id}:evidence:${evidence.id}`);
    }
    await mutate({ kind: "delivery.publish", delivery: { id: `${run.id}:result`, ...scope(w), sourceRunId: run.id,
      kind: "result", summary: report.summary, artifactIds: stale ? [] : report.artifacts.map((a) => a.id), sources: [{ kind: "run", ref: run.id }],
      decisionRevision: run.decisionRevision, state: "delivered", disposition: "pending", createdAt: now() } }, `${run.id}:publish`);
    for (const c of state.conversations.filter((c) => c.workstreamId === w.id && c.relation === "branch" && c.purpose === "explore" && !c.archived)) {
      await deps.execution.appendContext(c.sessionId, "Work checkpoint since this discussion began:\n" + JSON.stringify({
        runId: run.id, decisionRevision: run.decisionRevision, summary: report.summary, effects: observation.effects,
        artifactIds: stale ? [] : report.artifacts.map((a) => a.id), stale,
      }), `${run.id}:discussion:${c.sessionId}`);
    }
    if (stale) {
      await mutate({ kind: "delivery.consume", ...scope(w), deliveryId: `${run.id}:result`, disposition: "stale" });
      if (!side) await continueWork(work(w.id), run.authorizationId, undefined, `${run.id}:decision:${w.decisionRevision}`);
      await finish();
      return;
    }
    if (side) { await continueWork(work(w.id), undefined, undefined, `${run.id}:consume`); await finish(); return; }
    // The main owner already used its own result; a side result needs actual admission above.
    await mutate({ kind: "delivery.consume", ...scope(w), deliveryId: `${run.id}:result`, disposition: "integrated" });
    const current = work(w.id);
    if (["paused", "cancelled"].includes(current.status)) { await finish(); return; }
    if (current.acceptance.length > 0 && current.acceptance.every((a) => a.status === "satisfied")) {
      await transition(current, "completed", "Acceptance satisfied"); await finish(); return;
    }
    if (offered.some((deliveryId) => !report.consumedDeliveryIds.includes(deliveryId))) {
      await transition(current, "awaiting_user", "Review the results not acknowledged by the work owner", report.summary); await finish(); return;
    }
    if (report.stop || !report.next) { await transition(current, "awaiting_user", "Review the checkpoint and choose the next action", report.summary); await finish(); return; }
    await continueWork(current, run.authorizationId, report.next, `${run.id}:next`);
    await finish();
  }
  async function reconcile(workstreamId?: string) {
    for (const run of [...state.runs].filter((r) => (live(r) || r.state === "unknown" || !r.completionKey) && (!workstreamId || r.workstreamId === workstreamId))) await settle(run);
  }
  async function action(input: ProjectWorkflowAction): Promise<ProjectWorkflowActionResult> {
    return serial(async () => {
      await reload();
      if (input.expectedRevision !== state.revision) fail("CONFLICT", "The project changed; refresh before applying this intent");
      let w = work(input.workstreamId, input.projectId);
      let sessionId: string | undefined;
      if (input.kind === "start") {
        const auth = authorization(w, input.authorizationId);
        await assertResourcesAvailable(auth.resources);
        sessionId = input.sessionId ?? w.mainSessionId ?? await deps.execution.createSession({ projectId: w.projectId, purpose: "work" });
        await link(w, sessionId);
        await mutate({ kind: "workstream.update", ...scope(w), patch: { mainSessionId: sessionId } });
        await transition(work(w.id), "ready", w.nextAction);
        await continueWork(work(w.id), input.authorizationId, undefined, input.commandId, true);
      } else if (input.kind === "discuss") {
        if (input.sessionId && input.sessionId === w.mainSessionId) fail("CONFLICT", "Discussion needs a separate session; the main session remains owned by Work");
        if (input.pause) { await transition(w, "paused", w.nextAction); await stopRuns(w, false); }
        sessionId = input.sessionId ?? await deps.execution.createSession({ projectId: w.projectId, sourceSessionId: w.mainSessionId, purpose: "explore" });
        await link(w, sessionId, { relation: "branch", purpose: "explore", returnPolicy: "proposal", parentSessionId: w.mainSessionId });
        await deps.execution.appendContext(sessionId, assembleWorkflowContext(state, work(w.id), { discussion: true }), `workflow-discuss:${input.commandId}`);
      } else if (input.kind === "side.create") {
        const auth = input.purpose === "work" ? authorization(w, input.authorizationId ?? "") : undefined;
        if (auth) await assertResourcesAvailable(auth.resources);
        sessionId = await deps.execution.createSession({ projectId: w.projectId, sourceSessionId: input.sourceSessionId ?? w.mainSessionId, purpose: input.purpose });
        await link(w, sessionId, { relation: "child", purpose: input.purpose, visibility: input.visibility,
          parentSessionId: input.sourceSessionId ?? w.mainSessionId, sourceMessageId: input.sourceMessageId, readContext: input.readContext,
          returnPolicy: input.purpose === "ask" ? "none" : input.purpose === "explore" ? "proposal" : "delivery" });
        if (auth) await dispatch(w, sessionId, auth, { action: auth.actions[0], resources: auth.resources, prompt: input.task }, input.commandId);
        else await deps.execution.read({ sessionId, key: input.commandId, observeOutcome: input.purpose === "explore" && input.visibility === "project",
          content: assembleWorkflowContext(state, w, { conversation: conversation(sessionId) }) + "\n\n" + input.task
          + (input.purpose === "explore" ? "\nThis is exploration only. Return a proposed conclusion, not adopted authority.\n" + WORKFLOW_CHECKPOINT_INSTRUCTIONS : "") });
      } else if (input.kind === "adopt") {
        await mutate({ kind: "decision.resolve", ...scope(w), decisionId: input.decisionId, resolution: "adopt", source: input.source }, input.commandId);
        await stopRuns(w, false);
        if (!currentRuns(w).length) await continueWork(work(w.id), undefined, undefined, input.commandId);
      } else if (input.kind === "pause" || input.kind === "cancel") {
        await transition(w, input.kind === "pause" ? "paused" : "cancelled", w.nextAction);
        await stopRuns(w, input.kind === "cancel");
      } else if (input.kind === "resume") {
        await reconcile(w.id);
        w = work(w.id);
        if (state.runs.some((r) => r.workstreamId === w.id && (r.state === "unknown" || r.effects.some((e) => e.state === "unknown")))) {
          fail("WORKFLOW_EFFECT_UNKNOWN", "Resolve unknown external effects before resuming");
        }
        await transition(w, "ready", w.nextAction);
        const last = state.runs.filter((r) => r.workstreamId === w.id && conversation(r.sessionId)?.relation === "main").at(-1);
        const assignment = last?.completionKey?.endsWith(":paused-before-start") ? workflowAssignment(last).step : undefined;
        const next: WorkflowStep | undefined = assignment ?? (last?.state === "completed" ? parseWorkflowCheckpoint(last.outcome).next : undefined);
        if (last?.state === "completed" && !next) await transition(work(w.id), "awaiting_user", "Choose a new bounded action after the last checkpoint");
        else await continueWork(work(w.id), undefined, next, input.commandId);
      } else await reconcile(w.id);
      return { snapshot: state, sessionId, runId: sessionId ? state.runs.findLast((r) => r.sessionId === sessionId)?.id : undefined };
    });
  }
  return {
    action,
    recoverAll: () => serial(async () => {
      // Recovery observations can settle checkpoints, but no successor may be
      // admitted until every existing run's external outcome has been checked.
      recovering = true;
      await reload();
      await reconcile();
      // A previous process may have committed completion before admitting its
      // successor. Rebuild that exact assignment from the durable checkpoint.
      for (const w of state.workstreams) {
        const latest = state.runs.filter((r) => r.workstreamId === w.id && conversation(r.sessionId)?.relation === "main").at(-1);
        if (!latest?.completionKey || latest.state !== "completed" || latest.decisionRevision !== w.decisionRevision
          || !["ready", "executing", "blocked"].includes(w.status)) continue;
        const report = parseWorkflowCheckpoint(latest.outcome);
        const key = `${latest.id}:next`;
        if (!report.stop && report.next && !deferredContinuations.has(key)) {
          deferredContinuations.set(key, { workstreamId: w.id, authId: latest.authorizationId, next: report.next, freshUserStart: false });
        }
      }
      recovering = false;
      for (const [key, continuation] of deferredContinuations) {
        await continueWork(work(continuation.workstreamId), continuation.authId, continuation.next, key, continuation.freshUserStart);
        deferredContinuations.delete(key);
      }
    }),
    onTurnSettled: (sessionId) => serial(async () => {
      await reload();
      for (const run of [...state.runs].filter((r) => r.sessionId === sessionId && (live(r) || r.state === "unknown" || !r.completionKey))) await settle(run);
      const c = conversation(sessionId);
      const proposalId = `explore:${sessionId}:conclusion`;
      if (c?.purpose === "explore" && c.visibility === "project" && c.returnPolicy === "proposal" && !state.decisions.some((d) => d.id === proposalId)) {
        const observation = await deps.execution.observe({ id: `side:${sessionId}`, ...scope(work(c.workstreamId)), sessionId,
          executor: "agent-host", workstreamRevision: 0, decisionRevision: c.sourceRevision, authorizationId: "read-only",
          state: "executing", outcome: "", effects: [], startedAt: now(), updatedAt: now() });
        if (observation.state === "completed") {
          const report = parseWorkflowCheckpoint(observation.content);
          await mutate({ kind: "decision.propose", decision: { id: proposalId, ...scope(work(c.workstreamId)), title: "Exploration conclusion",
            statement: report.summary, state: "proposed", sources: [{ kind: "session", ref: sessionId, revision: String(c.sourceRevision) }], createdAt: now() } }, proposalId);
        }
      }
    }),
    onHostChanged: (event) => serial(async () => {
      await reload();
      if (["authorization.revoke", "feedback.add"].includes(event.kind)) {
        for (const run of state.runs.filter((r) => live(r) && (!event.workstreamId || r.workstreamId === event.workstreamId))) await deps.execution.stop(run, false);
      }
      if (event.kind === "feedback.add" && event.workstreamId) {
        const w = work(event.workstreamId);
        const feedback = state.feedback.filter((f) => f.workstreamId === w.id && f.candidateId === w.currentCandidateId).at(-1);
        const mainRun = state.runs.filter((r) => r.workstreamId === w.id && conversation(r.sessionId)?.relation === "main").at(-1);
        const auth = state.authorizations.find((a) => a.id === mainRun?.authorizationId && !a.revoked);
        if (feedback && auth && !currentRuns(w).length) await continueWork(w, auth.id, { action: auth.actions[0], resources: auth.resources,
          prompt: `Address the user counterexample for acceptance ${feedback.acceptanceId}, candidate ${feedback.candidateId}@${feedback.candidateRevision}, environment ${feedback.environment}: ${feedback.comment}` }, `feedback:${feedback.id}`);
      }
      if (["workstream.update", "workstream.transition", "run.observe", "delivery.publish", "decision.resolve", "authorization.grant"].includes(event.kind)) {
        for (const w of [...state.workstreams].sort((a, b) => b.priority - a.priority || a.order - b.order)) {
          if (w.status === "blocked" || (w.id === event.workstreamId && w.status === "ready")
            || state.deliveries.some((d) => d.workstreamId === w.id && d.state === "delivered")) await continueWork(work(w.id));
        }
      }
    }),
    contextForSession: async (sessionId) => {
      const snapshot = await deps.host.snapshot();
      const c = snapshot.conversations.find((record) => record.sessionId === sessionId);
      const w = c && snapshot.workstreams.find((record) => record.id === c.workstreamId);
      return c && w ? assembleWorkflowContext(snapshot, w, { conversation: c }) : undefined;
    },
    dispose: async () => { disposed = true; await tail; deps.execution.dispose?.(); },
  };
}
