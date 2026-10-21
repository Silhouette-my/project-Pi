import Type from "typebox";
import * as Value from "typebox/value";

/** Additive host-owned workflow records; existing sessions and ProjectGroups remain canonical. */
export const PROJECT_WORKFLOW_VERSION = 1 as const;
const id = Type.String({ minLength: 1, maxLength: 512 });
const text = Type.String({ maxLength: 100000 });
const revision = Type.Integer({ minimum: 0 });
const optionalId = Type.Optional(id);
const strings = Type.Array(id, { maxItems: 1000 });
const object = <T extends Type.TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
const literals = <const T extends string[]>(...values: T) =>
  Type.Union<{ [K in keyof T]: Type.TLiteral<T[K]> }>(
    values.map((value) => Type.Literal(value)) as [...{ [K in keyof T]: Type.TLiteral<T[K]> }],
  );

export const WorkflowSourceSchema = object({
  kind: literals("user", "session", "message", "file", "run"),
  ref: id,
  revision: Type.Optional(text),
});
export type WorkflowSource = Type.Static<typeof WorkflowSourceSchema>;

export const WorkflowAcceptanceSchema = object({
  id, title: id, status: literals("pending", "satisfied", "reopened"), evidenceIds: strings,
});
export const WorkflowOwnerSchema = object({ kind: literals("user", "session", "agent"), ref: id });
export const WorkflowWorkstreamSchema = object({
  id, projectId: id, title: id, goal: text, acceptance: Type.Array(WorkflowAcceptanceSchema),
  owner: WorkflowOwnerSchema,
  status: literals("draft", "ready", "executing", "paused", "blocked", "awaiting_user", "completed", "cancelled"),
  priority: Type.Integer(), order: Type.Number(), dependencyIds: strings,
  blocker: Type.Optional(object({ reason: text, owner: id, resumeWhen: text })),
  nextAction: text, currentCandidateId: optionalId, mainSessionId: optionalId,
  revision, decisionRevision: revision, createdAt: id, updatedAt: id,
});
export type WorkflowWorkstream = Type.Static<typeof WorkflowWorkstreamSchema>;
export type WorkflowStatus = WorkflowWorkstream["status"];

export const WorkflowTreeScopeSchema = literals("chats", "projects", "project");
export type WorkflowTreeScope = Type.Static<typeof WorkflowTreeScopeSchema>;
export const WorkflowFolderSchema = object({ id, name: id, parentId: optionalId, order: Type.Number(),
  scope: Type.Optional(WorkflowTreeScopeSchema), projectId: optionalId });
export type WorkflowFolder = Type.Static<typeof WorkflowFolderSchema>;
export const WorkflowProjectNavigationSchema = object({ projectId: id, folderId: optionalId, order: Type.Number() });
export type WorkflowProjectNavigation = Type.Static<typeof WorkflowProjectNavigationSchema>;
export const WorkflowConversationSchema = object({
  sessionId: id, projectId: id, workstreamId: id,
  parentSessionId: optionalId, sourceMessageId: optionalId, sourceRevision: revision,
  relation: literals("main", "branch", "child"), purpose: literals("ask", "explore", "work"),
  visibility: literals("project", "side_only"),
  readContext: object({ selection: Type.Optional(text), resourceIds: strings, includeDecisions: Type.Boolean(), includeArtifacts: Type.Boolean() }),
  returnPolicy: literals("none", "proposal", "delivery"), archived: Type.Boolean(), order: Type.Number(),
});
export type WorkflowConversation = Type.Static<typeof WorkflowConversationSchema>;

export const WorkflowResourceSchema = object({
  id, projectId: id, workstreamId: optionalId, label: id, uri: id,
  kind: literals("doc", "constraint", "skill", "source"),
  revision: text, updatedAt: id, state: literals("effective", "superseded"), source: WorkflowSourceSchema,
});
export type WorkflowResource = Type.Static<typeof WorkflowResourceSchema>;
export const WorkflowDecisionSchema = object({
  id, projectId: id, workstreamId: id, title: id, statement: text,
  state: literals("proposed", "effective", "superseded", "dismissed", "alternative"),
  sources: Type.Array(WorkflowSourceSchema), supersedesId: optionalId,
  adoptedRevision: Type.Optional(revision), adoptedBy: Type.Optional(WorkflowSourceSchema), createdAt: id,
});
export type WorkflowDecision = Type.Static<typeof WorkflowDecisionSchema>;

export const WorkflowAuthorizationSchema = object({
  id, projectId: id, workstreamId: id, actions: strings, resources: strings,
  source: WorkflowSourceSchema, permissionCeiling: literals("ask", "accept-edits", "auto"),
  maxRuns: Type.Integer({ minimum: 1 }), stopConditions: Type.Array(text),
  expiresAt: Type.Optional(id), revoked: Type.Boolean(),
});
export type WorkflowAuthorization = Type.Static<typeof WorkflowAuthorizationSchema>;
export const WorkflowEffectSchema = object({
  id, action: id, resource: id, state: literals("planned", "confirmed", "unknown", "failed"), detail: text,
});
export const WorkflowRunSchema = object({
  id, projectId: id, workstreamId: id, sessionId: id, executor: id,
  workstreamRevision: revision, decisionRevision: revision, authorizationId: id,
  state: literals("queued", "executing", "paused", "completed", "failed", "cancelled", "interrupted", "unknown"),
  outcome: text, effects: Type.Array(WorkflowEffectSchema),
  startedAt: id, updatedAt: id, completionKey: optionalId,
});
export type WorkflowRun = Type.Static<typeof WorkflowRunSchema>;
export const WorkflowArtifactSchema = object({
  id, projectId: id, workstreamId: id, runId: optionalId, label: id,
  kind: literals("candidate", "report", "change", "build", "test", "other"),
  revision: id, environment: text, entryPoint: id, source: WorkflowSourceSchema,
  supersedesId: optionalId, createdAt: id,
});
export type WorkflowArtifact = Type.Static<typeof WorkflowArtifactSchema>;
export const WorkflowEvidenceSchema = object({
  id, projectId: id, workstreamId: id, candidateId: id, candidateRevision: id,
  environment: text, scenario: id, acceptanceId: id,
  outcome: literals("passed", "failed", "not_run"),
  kind: literals("unit", "integration", "rendered", "live_account", "deployment", "review"),
  limits: text, source: WorkflowSourceSchema, createdAt: id,
});
export type WorkflowEvidence = Type.Static<typeof WorkflowEvidenceSchema>;
export const WorkflowFeedbackSchema = object({
  id, projectId: id, workstreamId: id, candidateId: id, candidateRevision: id,
  environment: text, acceptanceId: id, comment: text, source: WorkflowSourceSchema, createdAt: id,
});
export type WorkflowFeedback = Type.Static<typeof WorkflowFeedbackSchema>;
export const WorkflowDeliverySchema = object({
  id, projectId: id, workstreamId: id, sourceRunId: id,
  kind: literals("proposal", "evidence", "result"), summary: text,
  artifactIds: strings, sources: Type.Array(WorkflowSourceSchema), decisionRevision: revision,
  state: literals("produced", "delivered", "consumed"),
  disposition: literals("pending", "integrated", "stale", "conflict", "retained"),
  createdAt: id, consumedAt: Type.Optional(id),
});
export type WorkflowDelivery = Type.Static<typeof WorkflowDeliverySchema>;
export const WorkflowNavigationSchema = object({
  sessionId: id, folderId: optionalId, order: Type.Number(), favorite: Type.Boolean(),
  lastAccessedAt: Type.Optional(id), lastMessageId: optionalId,
});
export type WorkflowNavigation = Type.Static<typeof WorkflowNavigationSchema>;
export const ProjectAgentSchema = object({ projectId: id, sessionId: id });
export type ProjectAgent = Type.Static<typeof ProjectAgentSchema>;

export const ProjectWorkflowSnapshotSchema = object({
  schemaVersion: Type.Literal(PROJECT_WORKFLOW_VERSION), revision,
  projectAgents: Type.Optional(Type.Array(ProjectAgentSchema)),
  projectNavigation: Type.Optional(Type.Array(WorkflowProjectNavigationSchema)),
  folders: Type.Array(WorkflowFolderSchema), navigation: Type.Array(WorkflowNavigationSchema),
  expandedIds: strings, workstreams: Type.Array(WorkflowWorkstreamSchema),
  conversations: Type.Array(WorkflowConversationSchema), resources: Type.Array(WorkflowResourceSchema),
  decisions: Type.Array(WorkflowDecisionSchema), authorizations: Type.Array(WorkflowAuthorizationSchema),
  runs: Type.Array(WorkflowRunSchema), artifacts: Type.Array(WorkflowArtifactSchema),
  evidence: Type.Array(WorkflowEvidenceSchema), feedback: Type.Array(WorkflowFeedbackSchema),
  deliveries: Type.Array(WorkflowDeliverySchema),
});
export type ProjectWorkflowSnapshot = Type.Static<typeof ProjectWorkflowSnapshotSchema>;
export type ProjectWorkflowQuery = { projectId?: string; workstreamId?: string };

const common = { commandId: id, expectedRevision: revision };
const command = <T extends Type.TProperties, K extends string>(kind: K, properties: T) =>
  object({ ...common, kind: Type.Literal(kind), ...properties });
const scope = { projectId: id, workstreamId: id };
const treeTarget = object({ kind: literals("folder", "session", "project"), id });
export const ProjectWorkflowUserCommandSchema = Type.Union([
  command("folder.create", { folder: WorkflowFolderSchema }),
  command("folder.update", { folder: WorkflowFolderSchema }),
  command("folder.remove", { folderId: id }),
  command("navigation.move", { sessionIds: strings, folderId: optionalId }),
  command("navigation.update", { navigation: WorkflowNavigationSchema }),
  command("navigation.expand", { expandedIds: strings }),
  command("tree.move", { target: treeTarget,
    scope: WorkflowTreeScopeSchema, projectId: optionalId, folderId: optionalId, order: Type.Number(),
    siblingOrder: Type.Optional(Type.Array(treeTarget, { maxItems: 1000 })) }),
  command("workstream.create", { workstream: WorkflowWorkstreamSchema }),
  command("workstream.update", { ...scope, patch: object({
    title: Type.Optional(id), goal: Type.Optional(text), acceptance: Type.Optional(Type.Array(WorkflowAcceptanceSchema)),
    owner: Type.Optional(WorkflowOwnerSchema), priority: Type.Optional(Type.Integer()), order: Type.Optional(Type.Number()),
    dependencyIds: Type.Optional(strings), nextAction: Type.Optional(text),
    blocker: Type.Optional(Type.Union([WorkflowWorkstreamSchema.properties.blocker, Type.Null()])),
    currentCandidateId: Type.Optional(Type.Union([id, Type.Null()])), mainSessionId: optionalId,
  }) }),
  command("conversation.link", { conversation: WorkflowConversationSchema }),
  command("resource.put", { resource: WorkflowResourceSchema }),
  command("decision.propose", { decision: WorkflowDecisionSchema }),
  command("decision.resolve", { ...scope, decisionId: id, resolution: literals("adopt", "dismiss", "alternative"), source: WorkflowSourceSchema }),
  command("authorization.grant", { authorization: WorkflowAuthorizationSchema }),
  command("authorization.revoke", { ...scope, authorizationId: id }),
  command("artifact.put", { artifact: WorkflowArtifactSchema }),
  command("evidence.add", { evidence: WorkflowEvidenceSchema }),
  command("feedback.add", { feedback: WorkflowFeedbackSchema }),
]);
export type ProjectWorkflowUserCommand = Type.Static<typeof ProjectWorkflowUserCommandSchema>;
export const ProjectWorkflowRuntimeCommandSchema = Type.Union([
  command("agent.create", { projectId: id }),
  command("agent.link", { agent: ProjectAgentSchema }),
  command("workstream.transition", { ...scope, status: WorkflowWorkstreamSchema.properties.status, nextAction: text,
    blocker: Type.Optional(WorkflowWorkstreamSchema.properties.blocker) }),
  command("run.start", { run: WorkflowRunSchema }),
  command("run.observe", { ...scope, runId: id, state: WorkflowRunSchema.properties.state, outcome: text,
    effects: Type.Array(WorkflowEffectSchema), completionKey: optionalId }),
  command("delivery.publish", { delivery: WorkflowDeliverySchema }),
  command("delivery.consume", { ...scope, deliveryId: id, disposition: WorkflowDeliverySchema.properties.disposition }),
]);
export type ProjectWorkflowRuntimeCommand = Type.Static<typeof ProjectWorkflowRuntimeCommandSchema>;
export const ProjectWorkflowCommandSchema = Type.Union([ProjectWorkflowUserCommandSchema, ProjectWorkflowRuntimeCommandSchema]);
export type ProjectWorkflowCommand = Type.Static<typeof ProjectWorkflowCommandSchema>;
export type ProjectWorkflowMutationResult = { snapshot: ProjectWorkflowSnapshot; replayed: boolean };
export type ProjectWorkflowErrorCode = "INVALID_ARGUMENT" | "NOT_FOUND" | "CONFLICT" | "UNAUTHORIZED" | "WORKFLOW_EFFECT_UNKNOWN" | "WORKFLOW_RESOURCE_DENIED";
export type ProjectWorkflowConflict = { expectedRevision: number; actualRevision: number };
export type ProjectWorkflowChanged = { revision: number; commandId: string; kind: ProjectWorkflowCommand["kind"]; projectId?: string; workstreamId?: string };

const actionBase = { ...common, ...scope };
export const ProjectWorkflowActionSchema = Type.Union([
  object({ ...common, kind: Type.Literal("agent.open"), projectId: id }),
  object({ ...actionBase, kind: Type.Literal("start"), sessionId: optionalId, authorizationId: id }),
  object({ ...actionBase, kind: Type.Literal("discuss"), sessionId: optionalId, pause: Type.Boolean() }),
  object({ ...actionBase, kind: Type.Literal("adopt"), decisionId: id, source: WorkflowSourceSchema }),
  object({ ...actionBase, kind: Type.Literal("pause") }),
  object({ ...actionBase, kind: Type.Literal("resume") }),
  object({ ...actionBase, kind: Type.Literal("cancel") }),
  object({ ...actionBase, kind: Type.Literal("side.create"), purpose: WorkflowConversationSchema.properties.purpose,
    visibility: WorkflowConversationSchema.properties.visibility, readContext: WorkflowConversationSchema.properties.readContext,
    sourceSessionId: optionalId, sourceMessageId: optionalId, task: text, authorizationId: optionalId }),
  object({ ...actionBase, kind: Type.Literal("reconcile") }),
]);
export type ProjectWorkflowAction = Type.Static<typeof ProjectWorkflowActionSchema>;
export type ProjectWorkflowActionResult = { snapshot: ProjectWorkflowSnapshot; sessionId?: string; runId?: string };

export type ProjectWorkflowSearchRequest = { query: string; projectId?: string; workstreamId?: string; sessionId?: string; limit?: number };
export type ProjectWorkflowSearchHit = {
  kind: "message" | "workstream" | "decision" | "artifact"; id: string; label: string; excerpt: string;
  projectId?: string; workstreamId?: string; sessionId?: string; messageId?: string; artifactId?: string;
  breadcrumb: string[];
};
export type ProjectWorkflowOpenReference = { projectId: string; kind: "artifact" | "resource"; id: string };
export type ProjectWorkflowOpenedReference = { opened: true; uri: string; revision: string };
/** Runtime uses this port; renderer receives only user mutations and explicit actions. */
export interface ProjectWorkflowHostPort {
  snapshot(query?: ProjectWorkflowQuery): Promise<ProjectWorkflowSnapshot>;
  mutate(command: ProjectWorkflowCommand): Promise<ProjectWorkflowMutationResult>;
}
export interface ProjectWorkflowRuntimePort {
  action(action: ProjectWorkflowAction): Promise<ProjectWorkflowActionResult>;
  onHostChanged?(event: ProjectWorkflowChanged): void | Promise<void>;
  dispose?(): void | Promise<void>;
}
export interface ProjectWorkflowApi {
  snapshot(query?: ProjectWorkflowQuery): Promise<ProjectWorkflowSnapshot>;
  mutate(command: ProjectWorkflowUserCommand): Promise<ProjectWorkflowMutationResult>;
  action(action: ProjectWorkflowAction): Promise<ProjectWorkflowActionResult>;
  search(request: ProjectWorkflowSearchRequest): Promise<{ hits: ProjectWorkflowSearchHit[] }>;
  openReference(request: ProjectWorkflowOpenReference): Promise<ProjectWorkflowOpenedReference>;
  onChanged(listener: (event: ProjectWorkflowChanged) => void): () => void;
}

export function isProjectWorkflowCommand(value: unknown): value is ProjectWorkflowCommand {
  return Value.Check(ProjectWorkflowCommandSchema, value);
}
export function isProjectWorkflowUserCommand(value: unknown): value is ProjectWorkflowUserCommand {
  return Value.Check(ProjectWorkflowUserCommandSchema, value);
}
export function isProjectWorkflowAction(value: unknown): value is ProjectWorkflowAction {
  return Value.Check(ProjectWorkflowActionSchema, value);
}
export function emptyProjectWorkflowSnapshot(): ProjectWorkflowSnapshot {
  return { schemaVersion: PROJECT_WORKFLOW_VERSION, revision: 0, folders: [], navigation: [], expandedIds: [],
    workstreams: [], conversations: [], resources: [], decisions: [], authorizations: [], runs: [],
    artifacts: [], evidence: [], feedback: [], deliveries: [] };
}
