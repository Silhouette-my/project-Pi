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

Storage schema v25 adds a workflow aggregate and command ledger; v26 adds durable
run scopes and turn bindings while preserving old queue rows. The aggregate
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

## Turn-bound tool authority

`session.beginTurn` accepts optional `workflowRunId`. Host validates the active
run, session, project, decision revision and user authorization before persisting
its binding to the real turn. The initial dispatch resources are immutable;
later tool receipts cannot expand them. Queue persistence retains this identity.

For a bound turn, Host checks authority before permission admission and again
before execution. `Write` and `Edit` must remain within the captured output
resources. `Read` may also use effective canonical resources and relevant
artifact/delivery inputs, without adding write authority. Existing Host/tool
permissions still apply. Foreground `Bash` instead requires a separate one-use
approval of the exact command, even under Auto or prior session grants. Shell
effects may exceed the captured paths; the permission card makes that boundary
explicit. Host revalidates the binding and authorization at process admission.
Other uncontained tools, background and delegated execution return
`WORKFLOW_RESOURCE_DENIED` before effects. A path grant is not a process sandbox.
Ordinary turns without a workflow binding retain their existing behavior.

## Navigation trees

Folders support arbitrary depth. Optional `scope` is `chats`, `projects`, or
`project`; omitted scope retains the standalone Chat meaning. `chats` and
`projects` are one category space: the optional `categories` collection holds
user-defined categories, and optional `categoryId` on folders, session
navigation and project placements names the category (built-in ids `chats` and
`projects`; absent derives from scope or the default). A category mixes
folders, standalone conversations and projects; `category.create|update|remove`
manage them and removal moves contents to the matching built-in. See ADR
`project-navigation-tree`. Only `project`
folders carry a stable ProjectGroup `projectId`. The optional
`projectNavigation` collection stores stable project placements, separate from
session navigation. Old version-1 snapshots remain readable. Before the first
placement, projects retain their existing visible/manual order and project-main
path metadata; conversations without navigation records remain reachable.

`tree.move` changes navigation only. Its target is a folder, project, or session,
and its destination contains a scope, optional project and folder, and numeric
order. Optional `siblingOrder` normalizes the visible mixed folder/item order in
the same CAS transaction, including entries without prior placement records.
Host validates identity, scope, project membership and arbitrary-depth folder
cycles. Scope is immutable for folders. Removing a folder promotes its direct
children and placements to its parent; no sessions or projects are deleted.
Existing unscoped `navigation.move/update` retain their historical contract.

Project membership includes explicit conversation links and workstream main
sessions, including legacy sessions with no workspace. Filing such a session
never assigns a workspace. Project archive/pin filtering remains in Sidebar,
execution history stays reachable, and the fixed conversations/history wrapper
is removed. Independent Chat and project trees share drag-before, drag-after,
drop-inside, and root drop behavior. Recent/Favorites references use the same
drag source as their canonical conversation. Folder and item move menus provide
a keyboard-accessible alternative.

Git trees, Archify architecture and session relationship trees are deferred to
a subsequent overview iteration; no placeholder panels are rendered.

## Project Agent discussion

`agent.open` opens the project's canonical discussion session without requiring
a workstream. The optional `projectAgents` snapshot collection durably associates
the existing project and session identities; old snapshots without that
collection remain valid. Reopening or restarting reuses the live associated
session. Opening the entry alone sends no prompt and creates no workstream, run,
or execution authorization.

The project title, sidebar Home row, project page header and project-aware chat
top bar expose an icon action to the same discussion; the Agent has no session
row in Sidebar. These entries share in-flight opening state.

The discussion uses the existing ChatSurface, transcript, model picker and
prompt queue. Project instructions, memory and current workflow context remain
available. The renderer labels this session as Project Agent, provides a return
to the project, and hides execution-mode, permission and local-extension controls.
These controls are presentation only: Host rejects tool execution for the
persisted discussion identity before permission admission, independently of
mode or permission grants. Runtime advertises no tools and disables trusted
extensions and delegates for this session. A Project Agent session cannot be
selected as the execution session of a workstream. Other sessions keep their
existing permissions and behavior.

The project overview exposes discussion before work creation. Work details,
authorization controls, context and artifacts remain real Host projections,
not synthetic dashboard state. Header actions are below the native titlebar;
project instructions, memory and reload are grouped in the project menu.
Standalone conversation groups are mutually exclusive in navigation without
changing their durable folder membership.

The overview keeps an unsent draft per project. Submitting opens the canonical
session and targets the existing send path explicitly; a later user navigation
cannot redirect that prompt to a different session. Failed submissions retain
the project draft.

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
- [ADR: Project Agent discussion boundary](../../adr/project-agent-discussion-boundary.md)
