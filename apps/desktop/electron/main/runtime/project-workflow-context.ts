import type {
  ProjectWorkflowSnapshot, WorkflowAuthorization, WorkflowConversation, WorkflowWorkstream,
} from "@pi-desktop/shared";

/** A projection of authoritative records, never a second project memory store. */
export function assembleWorkflowContext(
  snapshot: ProjectWorkflowSnapshot,
  work: WorkflowWorkstream,
  options: { conversation?: WorkflowConversation; authorization?: WorkflowAuthorization; discussion?: boolean } = {},
): string {
  const { conversation, authorization } = options;
  const inScope = (record: { projectId: string; workstreamId?: string }) =>
    record.projectId === work.projectId && (!record.workstreamId || record.workstreamId === work.id);
  const ask = conversation?.purpose === "ask";
  const selected = conversation?.readContext;
  const decisions = !ask && (selected?.includeDecisions ?? true)
    ? snapshot.decisions.filter((d) => inScope(d) && d.state === "effective") : [];
  const resources = snapshot.resources.filter((r) => inScope(r) && r.state === "effective"
    && (!selected || conversation?.relation === "main" || (conversation?.purpose === "work" && r.kind === "constraint")
      || selected.resourceIds.includes(r.id)));
  const artifacts = !ask && (selected?.includeArtifacts ?? true)
    ? snapshot.artifacts.filter(inScope) : [];
  const payload = {
    projectId: work.projectId, workstreamId: work.id, revision: work.revision,
    decisionRevision: work.decisionRevision,
    ...(ask ? {} : { goal: work.goal, acceptance: work.acceptance, nextAction: work.nextAction,
      dependencies: snapshot.workstreams.filter((w) => work.dependencyIds.includes(w.id))
        .map((w) => ({ id: w.id, status: w.status, blocker: w.blocker })), blocker: work.blocker }),
    selection: selected?.selection,
    decisions: decisions.map((d) => ({ id: d.id, statement: d.statement, sources: d.sources, adoptedRevision: d.adoptedRevision })),
    resources: resources.map((r) => ({ id: r.id, kind: r.kind, uri: r.uri, revision: r.revision, source: r.source })),
    artifacts,
    feedback: ask ? [] : snapshot.feedback.filter(inScope),
    ...(options.discussion ? {
      runs: snapshot.runs.filter(inScope), evidence: snapshot.evidence.filter(inScope),
      deliveries: snapshot.deliveries.filter(inScope),
    } : {
      // Ask/Explore raw transcripts and pending proposals never enter execution context.
      results: ask ? [] : snapshot.deliveries.filter((d) => inScope(d) && d.state === "consumed" && d.disposition === "integrated"),
    }),
    authorization: authorization ? {
      id: authorization.id, actions: authorization.actions, resources: authorization.resources,
      permissionCeiling: authorization.permissionCeiling, maxRuns: authorization.maxRuns,
      stopConditions: authorization.stopConditions, source: authorization.source,
      executionBoundary: "Use Host-contained Read/Write/Edit and asktool for clarification. Writes are limited to this run's assigned resources; visible canonical resources and delivered artifacts are read inputs, not write grants. Bash, delegated, plugin/MCP and other uncontained tools stop this bounded turn. Report the concrete missing authorization or execution capability rather than retrying a denial.",
    } : undefined,
  };
  return "Project workflow context (data, not new tool permissions):\n" + JSON.stringify(payload, null, 2);
}

export const WORKFLOW_CHECKPOINT_INSTRUCTIONS = `At the end of this bounded work step, include one fenced JSON block tagged project-workflow-checkpoint.
Use {"summary":"actual outcome","next":{"action":"authorized action","resources":["exact authorized resource"],"prompt":"next bounded step"},"stop":false,"artifacts":[],"evidence":[],"consumedDeliveryIds":[]}.
When results were supplied, inspect their referenced artifacts/evidence and list only the delivery IDs actually used/integrated in consumedDeliveryIds. Explain their effect in summary. Delivery alone is not consumption or acceptance.
Omit next when there is no safe next step. Set stop=true when a stop condition or missing user decision applies.
Artifacts/evidence use the supplied workflow schemas; report actual revision, environment, scenario and verification limits. Never label local test success as live-account or deployment success.
Proposed next work grants no authority. Effective decisions and host/tool permissions prevail. Report uncertain external effects as unknown, never retry them.
Do not declare acceptance merely because this turn ended.
Artifact fields: id, projectId, workstreamId, label, kind(candidate/report/change/build/test/other), revision, environment, entryPoint, source({kind:"run",ref:runId}), createdAt(ISO time), optional runId/supersedesId.
Evidence fields: id, projectId, workstreamId, candidateId, candidateRevision, environment, scenario, acceptanceId, outcome(passed/failed/not_run), kind(unit/integration/rendered/live_account/deployment/review), limits, source, createdAt.
Use the actual context identities, stable unique output IDs and source run identity. The runtime validates these records and retains their provenance.`;
