# Product Contract — Project Workflow MVP v0.1

## Outcome

The user can direct a long-running project, inspect macro progress without opening
a session, move between discussion and execution, and find conversations without
copying handoff documents or repeatedly telling agents to continue.

The existing native Chat integration is the starting point. Preserve its provider
transport and login boundaries. This feature does not redesign authentication or
equate the consumer Chat provider with the existing Agent/Plan operating state.

## Core concepts

New ordinary tasks explicitly use session-backed execution. Their Agent session
retains its existing tools, plugins and permission mode; acceptance conditions
are optional, natural-language replies can finish work, and existing Review
remains the change-inspection surface. The bounded authorization/checkpoint loop
below remains the compatibility contract for historical tasks without
`executionMode: "session"`. See [session execution ADR](../adr/workflow-session-execution.md).

- **Chat folder**: navigation-only organization for ordinary conversations; it
  neither grants permissions nor shares model context.
- **Project**: the existing host-owned logical project identity, extended with
  goals, common resources, decisions, workstreams and progress.
- **Workstream**: one durable, outcome-oriented line of work, with acceptance
  conditions, an owner, dependencies and a current candidate. It can span many
  sessions and execution attempts. Do not add a second Epic/Task/Subtask hierarchy.
- **Session**: a concrete discussion/execution transcript, not the sole owner of
  project state. A workspace binding remains subject to existing host checks.
- **Run**: one execution attempt with its actual outcome and side-effect state.
- **Artifact/candidate**: an identifiable report, change, build, test result or
  other output, with origin, revision/environment and a usable entry point.
- **Decision/resource**: a source-backed effective or superseded decision, or a
  reference to canonical documents, skills and constraints.

## Required capabilities

### P1. Chat organization and project navigation

Chats and Projects are parallel navigation areas. Ordinary Chat folders support
create, rename, unlimited nesting (one indent level), move/bulk move and explicit non-destructive folder
removal. A global new Chat is unfiled; new Chat within a folder inherits that
folder. Existing chats remain accessible and continuable.

Projects expose an overview and workstreams instead of a flat permanent session
list. Clicking a workstream opens its main line; side conversations can expand
under it. Completed side work folds into history without deleting it. Preserve
manual ordering, user titles, expansion state and reading position. Background
agent messages do not reorder user navigation or flood Recent.

Recent is a derived access/activity view, not storage ownership. Favorites are
references. Search supports titles, message text, conclusions and artifact labels,
with breadcrumbs and a direct jump to the matched message/result. Search respects
explicit side-conversation visibility settings. Start with existing/full-text
capabilities; semantic/vector infrastructure is out of scope.

### P2. Independent Project Console

Without selecting a session, the user sees current goal/stage, workstreams and
owners, completed work, blockers/dependencies, decisions/acceptance awaiting the
user, current candidate and next planned action. No fake percent-complete or
message-count progress. Provide a project-level input surface that routes intent
to an explicit workstream; never silently send it to an unrelated active session.

Changing priorities or pausing a workstream affects its actual execution, not just
a visual label. Unrelated independent work remains runnable.

### P3. Shared resources and effective context

Provide references/editing through existing permitted paths for canonical project
constraints, design docs, decisions, current state and project skills. Reuse
existing project instructions/memory and skill mechanisms; do not maintain mutable
copies of the same rule in UI, memory, handoff and repository files.

Record source, revision/update time, scope and effective/superseded state. At a
work checkpoint, reconcile relevant outcomes and directly affected docs. Respect
file-write approval and source ownership; do not treat model-generated prose as a
user-approved change to authority or architecture. Existing skills can be bound
and maintained; automated skill mining is deferred.

Compile only the role-relevant goal, decisions, constraints, dependencies and
artifact references into model context. Preserve raw discussions as retrievable
sources according to visibility, not always-injected prompt material.

### P4. Chat to Work to Chat

The same workstream supports:

1. **Start work**: turn adopted discussion into an execution brief (goal,
   acceptance, decisions, constraints, references, open issues and authority).
2. **Discuss next**: bring execution deltas, evidence and blockers into Chat;
   existing Work continues unless the user explicitly pauses it.
3. **Adopt and continue**: adopt a new decision revision and deliver only relevant
   changes to the work owner; reuse valid outputs and continue at a safe boundary.
4. **Pause to discuss**: checkpoint and pause affected work, then explicitly resume.

No user-written/copied handoff is required. An unadopted proposal does not steer
execution. Discussion sees material changes that occurred after its starting
snapshot. Backend conversations need not share a physical context window.

### P5. Execution and bounded compatibility

For session-backed tasks, one ordinary Agent turn owns its search/edit/check/fix
loop. Normal completion with known effects can finish the task, independently of
optional user acceptance. Errors, cancellation and uncertain effects remain
visible; restarting observes prior work without replaying it. No workflow-specific
authorization form, mandatory checkpoint, Candidate or Evidence is required.

The following continuation and acceptance loop applies to bounded tasks:

Event-driven flow: observe change -> choose authorized next work -> execute or
delegate -> consume/integrate outcome -> assess acceptance -> update state/docs ->
continue or request the specific missing decision.

Use existing execution/turn/approval capabilities. Run completion does not itself
complete a workstream. Distinguish produced, delivered, consumed/integrated and
accepted results. User counterexamples reopen the affected acceptance condition
on the tested candidate without losing previous valid evidence.

Each workstream has an accountable owner; dependency and shared-write conflicts
are explicit. Routine in-scope continuation does not repeatedly ask permission.
Authorization scope covers resources/actions and applicable budget/stop conditions;
it cannot exceed host/tool permissions or be inferred from a summary.

Run while the local application is alive. Persist enough state to reconcile after
restart. Do not replay an external action whose execution result is unknown. Make
pause, cancel, blocked, awaiting-user and executing distinguishable. No unchanged
failure retry loop or always-on expensive model polling.

### P6. Side conversations and branches

Provide Ask, Explore and Work presets, with independent read context, write-back
policy and execution authority:

| Preset | Default input | Default output |
| --- | --- | --- |
| Ask | Selection and necessary background | No automatic effective-context write-back |
| Explore | Related workstream facts/decisions | Proposed conclusion; adopt, retain alternative or dismiss |
| Work | Bounded assignment, inputs and authority | Outcome/artifact/evidence/blocker delivery to the owning workstream |

Ask does not modify the project. Explore does not change active decisions until
adopted. Optional only-this-side-chat visibility excludes automatic project
retrieval. Work side effects are recorded even when raw conversation is not
injected into the main context. Testing/deployment are work assignments with their
own authority, not a bypass of these policies.

Branches retain their source discussion/revision; child conversations retain the
work they serve. One primary navigation parent plus explicit cross-references is
sufficient. Do not expose the whole dependency graph in the sidebar or invent
historical ancestry from matching titles.

Results target a durable workstream, not merely a parent session ID. Stale results
remain evidence but cannot overwrite a newer adopted decision. Critical findings
may notify the responsible workstream early; routine logs remain local to the side.

## End-to-end acceptance scenarios

| ID | Observable acceptance | Primary owner |
| --- | --- | --- |
| AC01 | File ordinary chats, move/delete a folder without deleting chats, and continue existing chats after restart | B + A |
| AC02 | Open Project Console with no active session; see real work/owner/blocker/candidate state | B + A |
| AC03 | New session continues using current effective project decisions, constraints and artifacts without copying a handoff | C + A |
| AC04 | Discuss -> Work -> new evidence -> Chat discussion -> adopt -> Work continues within the same workstream | C + B |
| AC05 | Authorized local implementation/check/fix/document steps continue after turn completion; out-of-scope action asks once at its boundary | C + A |
| AC06 | Ask stays out of main effective context; an unadopted Explore branch cannot steer Work | C + B |
| AC07 | Work side result is delivered AND consumed; parent session closure does not orphan it | C + A |
| AC08 | A new decision fences an old run's conflicting result; a user counterexample targets the correct candidate/acceptance condition | A + C |
| AC09 | Search jumps to the correct message/result with breadcrumb; background output does not reorder Recent; folded history remains reachable | B + A |
| AC10 | Pause/restart reconciles actual execution; unknown external effects are not replayed; unrelated work survives | C + A |
| AC11 | Open the exact current candidate and attach feedback to its revision/environment; test success is not labeled live deployment success | A + B + C |
| AC12 | Existing Agent/Plan, native Chat transcript, project memory/instructions, permissions and session/fork/history behavior remain usable | A integrates all |

## Deferred

No full Council debate UI, mandatory role pipeline, autonomous skill evolution,
cloud-always-on scheduler, cross-device execution, giant knowledge graph, universal
undo or full-history automatic reclassification. Do not reduce the MVP to a static
dashboard, cosmetic tree, mock backend or summaries with no active continuation.
