# Project Workflow State

## Purpose and ownership

Project Workflow adds a durable, project-oriented workstream without replacing
the existing logical project or conversation model. Rust `host-core` owns the
SQLite state and validates project/session/message identity. Electron Main
routes the typed API and connects the runtime; Node runtime owns execution
selection and lifecycle. Renderer owns presentation and user interaction. The
renderer never reads SQLite or executes agent work, and this domain is not a
plugin API.

Every workflow `projectId` references an existing `ProjectGroupRecord.id`.
Session and message IDs retain their existing meaning and transcript storage.
Workflow folders are navigation-only: moving a conversation does not change
its project binding, workspace, context, or permissions. This state is additive;
it does not create a second project identity or session hierarchy.

## Durable aggregate and revision contract

Storage schema v25 adds a workflow aggregate and command ledger. The aggregate
contains version-1 snapshots; a fresh store reads as revision 0. Each typed
command is applied to the aggregate in one SQLite transaction, with a global
`expectedRevision` compare-and-swap. A successful command increments the
revision once and records its command ID and result in the same transaction.
Repeating the same command ID and input acknowledges that result as a replay
and returns the current authoritative snapshot without increasing its revision;
reusing that ID for different input or submitting a stale revision conflicts.
Callers refresh after a conflict; they do not overwrite a newer snapshot.

Snapshots may be scoped by project or workstream while retaining the global
revision. Change events identify the committed revision, command and affected
scope; consumers reload the authoritative snapshot rather than treating events
as replacement state. Existing project groups, sessions, messages and their
IDs remain canonical.

## Typed boundary

`packages/shared/src/project-workflow.ts` defines the versioned records,
schemas, commands, results, events and ports. The public API exposes
`snapshot`, `mutate`, `action`, `search`, `openReference` and `onChanged`.
Renderer mutation accepts only `ProjectWorkflowUserCommand`; runtime-only
transitions, run observations and delivery mutations enter through the trusted
host port. Main validates the allowlisted IPC payloads and invokes the runtime
port for explicit actions. Rust RPC handles durable snapshot, mutation and
search operations.

The snapshot records workstreams and their acceptance, owner, dependencies,
blocker, next action and candidate; conversation relationships and visibility;
resources and sourced decisions; explicit authorization; runs and observed
effects; candidates, evidence, feedback and result delivery. The command
schemas are capability-specific. There is no arbitrary state replacement
command.

## Workflow invariants

- A proposal becomes effective only through an explicit adoption with a source.
  Adoption advances the workstream decision revision.
- A run records the workstream and decision revisions plus its authorization
  at start. A later decision fences conflicting stale results; stale delivery
  may be retained as evidence but cannot replace effective state.
- Authorization names a user source, action/resource scope, permission ceiling,
  run budget and stop conditions. It cannot grant more than existing host or
  tool permissions; a session transcript or model proposal is not authority.
- Run completion is not workstream acceptance. Evidence is tied to an exact
  candidate revision, environment and acceptance item. Completion requires an
  explicit acceptance update and current-candidate passed evidence for every
  condition.
- Changing the current candidate reopens satisfied acceptance. Invalidating a
  completed workstream's acceptance returns it to ready while retaining evidence.
- Produced, delivered and consumed results remain distinct. Consumption records
  whether a result was integrated, retained, stale or conflicting.
- Unknown external effects remain `unknown` for reconciliation and are not
  replayed. Pause, cancel, blocked and awaiting-user states apply to affected
  work; unrelated work remains independent.
- Startup first observes and persists all existing runs, then admits authorized
  continuations. Terminal callbacks arriving during recovery are retained and
  drained before public actions become ready. Recovery failure keeps admission
  disabled; retry preserves the accepted checkpoint's exact next step and scope.

## Opening a recorded reference

`openReference` opens a recorded artifact or resource without requiring an
active session and returns the URI and recorded revision. For local paths, Main
resolves the real path and requires containment within a registered root of the
referenced project group. HTTP(S) references use the existing host URL gate.
A workflow record is a reference, not a grant of filesystem or network access.

## Related contracts

- [Project Workflow MVP product contract](../../project-workflow-mvp/PRODUCT.md)
- [Project Workflow shared interface handoff](../../project-workflow-mvp/CONTRACT.md)
- [ADR: Durable project workflow state](../../adr/project-workflow-durable-state.md)
