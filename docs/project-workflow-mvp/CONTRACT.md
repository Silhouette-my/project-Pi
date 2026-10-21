# Interface Handoff — Owner A

## C0 executable symbol map

`packages/shared/src/project-workflow.ts` (exported from the shared package root)
is the cross-process schema/type authority. `ProjectWorkflowSnapshotSchema` and
`ProjectWorkflowSnapshot` contain folders/navigation, workstreams, conversations,
resources, decisions, authorizations, runs, artifacts, evidence, feedback and
deliveries. All records use the existing `ProjectGroupRecord.id` as `projectId`;
session and message IDs retain their existing meaning.

| Consumer | Symbol / path | Use |
| --- | --- | --- |
| B renderer | `api.projectWorkflow` in `apps/desktop/src/lib/api.ts` | `snapshot`, `mutate`, `action`, `search`, `openReference`, `onChanged` |
| B/C fixtures | `packages/shared/src/project-workflow-fixtures.ts` | Synthetic `projectWorkflowFixture`, `workflowFixtureWorkstream`; never production defaults |
| Host commands | `ProjectWorkflowUserCommandSchema` / `ProjectWorkflowRuntimeCommandSchema` | Closed, capability-specific discriminated unions; no arbitrary JSON state replacement |
| C runtime persistence | `ProjectWorkflowHostPort` | `snapshot(query?)`, `mutate(command)` returning `{ snapshot, replayed }` |
| A/C runtime composition | `ProjectWorkflowRuntimePort` | `action`, optional `onHostChanged`, `dispose`; C supplies implementation to A |
| Runtime intents | `ProjectWorkflowActionSchema` / `ProjectWorkflowAction` | `start`, `discuss`, `adopt`, `pause`, `resume`, `cancel`, `side.create`, `reconcile` |
| IPC | `IPC.invoke.projectWorkflow{Snapshot,Mutate,Action,Search}` | Named preload allowlist; user mutation endpoint excludes runtime-only commands |
| Updates | `IPC.event.projectWorkflowChanged` / `ProjectWorkflowChanged` | Revision, command identity and affected project/workstream; reload snapshot after event |
| Rust RPC | `project.workflow.snapshot`, `.mutate`, `.search` | A implements durable state; Main invokes runtime port for actions |
| Project-scoped open | `api.projectWorkflow.openReference({projectId, kind: "artifact" \| "resource", id})` | Opens the recorded URI in the OS, not the active session; local paths must resolve inside that group's registered roots; HTTP(S) uses existing URL gate. Returns recorded revision. |

### Revisions, authority and errors

- Empty state has `schemaVersion: 1`, global `revision: 0`. Every accepted mutation
  requires a unique `commandId` and current `expectedRevision`; one atomic mutation
  increments the global revision. Repeating the same command returns `replayed: true`
  without applying it twice, returning the current authoritative snapshot. Reusing
  its ID with different input is a conflict.
- Filtered snapshots retain the global revision. `ProjectWorkflowQuery` can select
  project/workstream; folders/navigation stay global. Refresh after `CONFLICT`;
  error details identify expected/actual revisions. Never blindly overwrite.
- Workstream `revision` advances for relevant state changes; `decisionRevision`
  advances on adoption. Runs/deliveries capture these fences. A stale delivery may
  be retained/consumed as stale, never replace current effective decisions.
- `authorization.grant` requires an explicit user source; it describes scope, not
  extra host/tool permissions. `start` names that authorization. Main validates
  renderer commands using `isProjectWorkflowUserCommand`; runtime-only transitions,
  run observations and deliveries are available only through the trusted host port.
- Authorization actions are exact user-defined strings; the initial UI defaults
  are `implement`, `check`, `document`. Resources are exact user-approved path/URI
  identifiers, without wildcard or prefix expansion. A proposed next checkpoint
  must name an allowed action and a subset of these resources. `maxRuns` counts
  main and side Work runs under the same authorization. Existing tool permissions
  remain the independent ceiling.
- `run.observe` completion does not complete a workstream. `evidence.add` records
  evidence and its acceptance association, but does not automatically satisfy it.
  Submit an explicit acceptance update before `workstream.transition: completed`;
  completion requires all conditions satisfied and passed current-candidate evidence.
- Boundary failures use existing `INVALID_ARGUMENT`, `NOT_FOUND`, `CONFLICT`,
  `UNAUTHORIZED` codes; ambiguous effect recovery uses `WORKFLOW_EFFECT_UNKNOWN`.
  Existing API invocation throws with `code`/`details`, as other renderer APIs do.
- `discuss` includes an explicit `pause` choice. Side creation includes independent
  purpose/visibility/readContext and optional source message; only Work may execute
  under a supplied authorization. No side transcript is an authorization source.
- `start.sessionId` explicitly selects an existing executable Agent session and
  becomes the persisted `mainSessionId`. Without it, runtime uses the existing main
  session or creates one under the current explicit Agent defaults. Consumer Chat
  providers remain discussion-only: Main rejects them for Work rather than silently
  changing provider. Ask/Explore creation preserves the source provider and inherits
  its permission source, with Plan mode and an Ask ceiling for read/discussion.
- The private runtime factory also returns `recoverAll(): Promise<void>`. Main
  awaits it before enabling actions: all existing runs are observed and persisted
  before any authorized successor is admitted. Failed recovery leaves admission
  disabled; accepted checkpoint continuations retain their exact scope on retry.
- `AgentPromptRequest`, queued turn summaries and queue input carry optional
  `workflowRunId`. `session.beginTurn` validates and binds it to the durable turn;
  ordinary callers omit it. Bound turns preserve `workflow-run:<runId>` as their
  user message identity. Tool execution resolves the Host-owned binding, not a
  model-supplied resource list; out-of-scope tools return
  `WORKFLOW_RESOURCE_DENIED` before effects.
- Foreground workflow Bash requires a separate user decision on every exact
  invocation. Host emits the existing permission request with optional
  `ToolPermissionRequest.approvalScope: "workflow-shell"` and complete arguments.
  Auto mode and session grants do not bypass this request; only `allow-once`
  admits execution. `allow-session` is rejected without a reusable grant.
  Approval waits retain the original call, not a replayable command token.
  A refused/cancelled permission-wait result carries top-level
  `approvalScope: "workflow-shell"`, proving it did not reach the runner.
  An abort after command admission has no such marker and may have effects.
  The Host revalidates the actual turn and workflow authority before starting
  the command. Shell effects may exceed selected writable paths; the card states
  this explicitly. File-tool scope remains unchanged; background/delegated Shell
  and other unsupported tools remain denied.

C0 declares the actual API/ports and adds validation tests, without fake Host or
runtime implementations. A owns subsequent host wiring. C must report the exported
factory and dependencies needed for final composition; no unpublished C imports
are required by this milestone.

This file freezes product semantics and the handoff procedure. Exact TypeScript,
Rust, RPC and IPC signatures become authoritative in A's first committed contract
milestone. B and C must consume that milestone, not maintain private parallel types.
A may choose minimal concrete names/storage after checking existing implementations;
do not change the product semantics below to fit a convenient implementation.

## Reuse map (verified before dispatch)

| Boundary | Existing entry points |
| --- | --- |
| Project identity/context | `crates/host-core/src/db/project_groups.rs`; `project.groups.*`, `project.group.context`, group instructions/memory RPC in `crates/host-core/src/rpc/mod.rs` |
| Persistent state | `crates/host-core/src/db/repositories.rs` KV operations and existing DB/migration facilities |
| Session identities | `crates/host-core/src/sessions.rs`, `create_session_with_options`; legacy session ownership is `project_path` |
| Collaboration | `crates/host-core/src/session_collaboration/mod.rs`; `packages/shared/src/session-collaboration.ts` |
| Shared/preload/API | `packages/shared/src/protocol.ts`, exports/types; `apps/desktop/electron/main/ipc/workspace-ipc.ts`, `session-ipc.ts`, `register.ts`; `apps/desktop/src/lib/api.ts` |
| Runtime execution | `packages/agent-host/src/agent-host.ts`, `ports.ts`; `packages/host-runtime/src/agent-sidecar.ts`; `packages/agent-runtime/src/runtime.ts` |
| Local lifecycle | `apps/desktop/electron/main/runtime/session-coordination.ts`, `session-launch.ts`, `event-persistence.ts` |
| Renderer | `components/Sidebar.tsx`, `stores/slices/project-slice.ts`, `session-slice.ts`, `features/app/AppShell.tsx`, `pages/ProjectsPage.tsx` |

Existing session collaboration mutations are authenticated/plugin-only (see
`apps/desktop/electron/main/session-collaboration-control.ts`). Do not expose them
to the renderer by removing provenance/authorization checks. A/C must provide an
appropriate user-action/host-owned project entry point while reusing safe internal
capabilities and preserving the plugin boundary.

## State ownership

A owns authoritative persistent transitions and schemas. C owns execution choice,
context assembly and integration/reconciliation policy, issuing validated commands
through A's service boundary. B renders snapshots and issues typed user intents.
Only A maintains shared status enums; neither B nor C has an independent persisted
project state machine. C may have private transient scheduler state with explicit
lifecycle ownership.

## Contract milestone C0 must contain

1. Shared data types and boundary validation for the concepts below, with exports.
2. Typed operation/result/error and update-event contracts.
3. Typed renderer API surface and a runtime-facing port/adapter signature.
4. Representative fixtures owned with the contract, plus contract tests.
5. A capability-to-symbol/path map added to this file, including host-owned
   mutations versus runtime actions and initial revision behavior.

Publish C0 before building all host behavior. It must be importable/buildable;
declare types/ports rather than wire imports to unpublished runtime modules.
Do not fake successful implementations to make early contracts compile.

## Required semantic fields (not a prescribed table schema)

- **Identity:** existing ProjectGroup ID, workstream ID, stable session/message ID,
  run ID, artifact ID. Folder identity is separate from all execution identity.
- **Workstream:** goal, acceptance items, accountable owner reference, status,
  explicit blocker/dependency and next action, current candidate, revision.
- **Conversation link:** session, project/workstream binding, primary navigation
  parent/source message, relation (main/branch/child), purpose (ask/explore/work),
  visibility, read-context selection and return policy. Navigation edits alone
  must not rewrite execution roots or inherited context.
- **Decision:** proposal/effective/superseded state, scope, basis/source references,
  adopted revision, superseded decision and adopting actor/source.
- **Resource:** canonical path/URI/reference, kind (doc/constraint/skill/source),
  project scope and revision/update metadata. Reference does not grant file access.
- **Run:** workstream/session, goal/decision revision at start, executor, observed
  execution state, outcome, authorized scope reference and side effects.
- **Result delivery:** source run, recipient workstream, proposed/evidence/result
  kind, artifact/source refs, delivery versus consumption state and stale/conflict
  disposition. Raw side transcripts are not the delivery payload.
- **Artifact/evidence:** origin run/source, exact candidate/revision, environment,
  scenario, verification outcome/limits, entry point and supersession.
- **Authorization:** explicit user-authorized operation/resource scope, applicable
  budget/stop conditions and authority source. Existing host permissions remain
  authoritative. No credentials inside workflow records/context.

## Required operation groups

### Organization and retrieval

Folder list/create/rename/move/remove; batch membership updates; workstream
list/create/update; session-to-workstream and branch/child associations; stable
navigation projections; scoped search with direct message/artifact locations.
Deleting a folder unfiles its chats rather than deleting them. Preserve historical
session IDs and links. Legacy path projects resolve through existing semantics.

### Project read/write

Overview snapshot; effective context/resources; decisions/proposals and adoption;
candidate/evidence/user-feedback registration; owner/dependency/blocker updates.
Use revision-aware writes for shared mutable decisions and work state. A stale
write gets a typed conflict, not last-writer-wins loss. Keep capability-specific
schemas instead of an arbitrary JSON command executor.

### Runtime user intents and events

Start work, discuss next, adopt and continue, pause/resume/cancel affected work;
create Ask/Explore/Work side assignment; deliver and consume result; reconcile
observed run outcome after restart. A owns the shared interface; C implements the
execution service. A owns final composition-root wiring.

Events carry durable identity and applicable revision. Duplicate turn completion
must not dispatch duplicate successor work. When an effect is ambiguous, expose
that state rather than replaying it. Important changes update Project Console even
when no session is selected. Renderer reload reconstructs from authoritative state.

### Context transfer

Context assembly references workstream revision, effective decisions/constraints,
relevant resources, artifacts, outstanding issues and user authority. Discuss-next
adds execution deltas to visible Chat context. Adopt-and-continue sends changed
decisions to Work at safe boundaries. Use ordinary available messages/artifacts;
do not assume inaccessible backend model state can be transferred.

## Handoff/change protocol

### Project Agent discussion extension

`action({ kind: "agent.open", projectId, commandId, expectedRevision })` opens
the project's canonical discussion session and returns `{ snapshot, sessionId }`.
It needs no workstream, including for an empty project. Revisit and application
restart resolve the same live session; deleting that session permits a new one.
Opening the Agent never creates a workstream, conversation link, run or grant.

The optional `snapshot.projectAgents` array contains `{ projectId, sessionId }`
associations. The Host normalizes older v1 snapshots to an empty array. The
runtime-only `agent.create` mutation creates session metadata and its association
inside the same Host CAS transaction; no session is published before both commit.
A stale revision creates nothing; persistence failure rolls both records back.
The internal `agent.link` validation prevents replacing a live canonical Agent;
renderer user mutations cannot create or bind Agent associations.

The canonical session has an immutable discussion boundary independent of its
displayed mode and permission mode. Main resolves this Host mapping on every
launch and supplies `discussionOnly`; runtime publishes no tool catalog and loads
no trusted extensions or delegates. Host tool admission independently denies all
tools for the persisted session identity, including absent/forged turn IDs,
auto mode and reusable tool grants. Selecting the session for Work is rejected.
Execution requires a separate work item and its existing explicit authorization.

Project instructions and project memory still use the existing launch pipeline.
The current workstreams, effective decisions/resources, artifacts, evidence and
deliveries are added as reference data on each turn. Discussion does not adopt
those records or write project memory. Existing ordinary and workstream-bound
sessions retain their previous behavior.

A writes the C0 commit ID and exported symbol map to its status record. B/C commit
their own safe checkpoint, then merge that exact published milestone into their own
branches. No dependency on A's uncommitted worktree. Later contract changes stay
with A, with additive producer/consumer updates and a new published commit.

B/C put interface requests in their own status record with the required behavior,
affected path and smallest proposed change. They continue independent work while
waiting. Do not send user-visible messages to other Codex chats based solely on
this brief; file-based handoff and read-only wait/status tools suffice.
