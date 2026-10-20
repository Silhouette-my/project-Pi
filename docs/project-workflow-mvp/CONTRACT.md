# Interface Handoff — Owner A

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

A writes the C0 commit ID and exported symbol map to its status record. B/C commit
their own safe checkpoint, then merge that exact published milestone into their own
branches. No dependency on A's uncommitted worktree. Later contract changes stay
with A, with additive producer/consumer updates and a new published commit.

B/C put interface requests in their own status record with the required behavior,
affected path and smallest proposed change. They continue independent work while
waiting. Do not send user-visible messages to other Codex chats based solely on
this brief; file-based handoff and read-only wait/status tools suffice.
