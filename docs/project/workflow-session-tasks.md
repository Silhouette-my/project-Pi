# Session-backed project tasks

## Requested result

New project tasks use the selected Agent conversation's existing tools, model,
plugin configuration and permission mode. Project organization and durable Run
state remain in the current Workflow system. The project directory is the default
working location, not a new sandbox. The already-installed Session Orchestrator
is reused through the ordinary Agent path; no replacement orchestrator or plugin
installation is part of this change.

No new delivery-review surface, automatic Evidence requirement, container,
virtual machine or sandbox is introduced. Existing Review and conversation tool
records remain the way to inspect changes and checks.

## Candidate and ownership

- Source: the user's current local project branch, `6616ef316`.
- Task branch/worktree: `feat/workflow-agent-path`,
  `PI-Desktop-worktrees/workflow-agent-path`.
- This request deliberately continues the latest local project implementation;
  it does not merge unrelated upstream work or the earlier Stage 1 worktree.
- The execution owner maintains the shared/Host/runtime contract. The primary
  agent owns renderer integration and acceptance. The E2E owner maintains the
  existing real-process workflow journey; an independent reviewer checks the
  permission and persistence boundaries.
- No commit, push, install into the user's application, real-provider evaluation
  or modification of the user's stored profile is included.

## Compatibility and completion

- New creation entry points explicitly set `executionMode: "session"`.
- A missing field retains the legacy bounded behavior. Existing records are not
  migrated into broader authority. A Run freezes its Workstream's mode.
- Session-backed tasks use ordinary Agent startup, tools and ask/auto behavior;
  they have no extra Workflow authorization form or Shell approval policy.
- Legacy records continue requiring their old authorization, checkpoint format
  and candidate/acceptance semantics.
- New tasks may have no acceptance conditions. Normal Agent completion can end
  the task without a Candidate, Evidence record or checkpoint block. User-authored
  acceptance conditions keep their separate state and are not automatically passed.
- The UI labels this state “Agent finished”, distinct from legacy “Accepted”.
  Errors, cancellation, interruption and unknown side effects remain visible and
  cannot become successful task completion merely because a turn ended.
- Pause/resume/restart retain conversation and Run identity. An uncertain effect
  is not replayed automatically. Side results use existing delivery/consumption
  records without requiring a structured checkpoint from a new task.

## Acceptance and checks

Required representative paths:

1. Create a task without acceptance or a Workflow grant; use a configured Agent.
2. Auto mode reads/searches, edits, observes a failed check, repairs it and passes
   the check, then finishes in natural language. A harmless failed read is not
   treated as an unknown write effect.
3. Ask mode uses the ordinary permission card and ordinary approval scopes;
   legacy Workflow still uses exact-command one-time approval.
4. Existing plugin and subagent entry points are not filtered by Workflow for a
   session-backed task. User accounts and installed plugins are not test fixtures.
5. Side results reach a later explicitly requested main turn without fabricating
   the main turn's final response or automatically starting another model turn.
6. Completed-task edits preserve completion meaning; historical authorization and
   acceptance still operate under their original contract.
7. Pause, cancellation and restart do not replay uncertain operations.

## Verification record

The task uses the existing shared dependency store with workspace package links
pointed at this worktree and isolated application data. All model-backed tests use
localhost scripted fixtures, not real providers. Tests validate the uncommitted
working candidate based on `6616ef316`, not an installed or released application.

Completed checks:

- Shared Workflow contract: 8 tests passed.
- Host Project Workflow: 50 tests passed.
- Runtime lifecycle: 62 tests passed, including legacy/session separation,
  known-read failure recovery, side result delivery, steering and final-response
  ownership, optional acceptance edits, and owner/session concurrency behavior.
- Host queue ports: 5 tests passed.
- Ordinary Agent bridge/queue identity: 2 tests passed. Session Runs persist a
  UUID accepted by the existing IPC validator in the initial dispatch receipt;
  queue restore, startup and observation reuse it without widening ID validation.
- Renderer structure projections: 6 tests passed; session completion is counted
  separately from accepted legacy work.
- i18n: 33 tests passed across the package suites.
- The isolated Electron Project Console journey passed new creation without
  acceptance, start/side work without a Workflow grant, optional acceptance edits,
  completion meaning, and the unchanged legacy authorization journey.
- The actual task-detail render was inspected at wide and narrow widths.
  Screenshots: `.artifacts/project-workflow-ui/console-session.png` and
  `console-session-narrow.png`. The narrow fixture closes its fixed-width mock
  right panel; full-application docking is not tested by that component fixture.
- Shared/dependency JavaScript builds, Desktop typecheck and production build,
  Host production build, targeted Rust formatting and `git diff --check` passed.

The production cross-process journey passed using the frozen Desktop build and
`.artifacts/bin/pi-desktop-host-core-final`, with 49 loopback fixture requests.
Report: `.artifacts/project-workflow-e2e/result.json`; full isolated run:
`/tmp/pi-workflow-agent-path-e2e-final-4`.

- New auto tasks recovered from a failed Read, used Glob/Grep, repaired a failing
  Shell check, passed the recheck, wrote to an ordinary permitted temporary path
  outside the project, used native Task/TaskWait, and finished in natural language
  without extra Workflow approval, Candidate or Evidence.
- New ask tasks displayed the ordinary permission card, retained ask mode, and
  honored allow-for-chat. Optional acceptance remained pending.
- Side Work returned prose; a later explicit main Start received and consumed
  the result without an automatically dispatched main turn.
- An actual partial Shell effect followed by timeout stayed unknown. App restart
  created no successor Run or model request, left exactly one started marker,
  and did not execute the delayed write. Legacy bounded permissions, continuation,
  pause/resume/cancel, adoption and recovery also passed.

The user's installed Session Orchestrator was not invoked; delegation used an
isolated native Task fixture. Real-model quality, live accounts and deployment
were not tested. An earlier diagnostic run used a binary path replaced during
validation and is not acceptance evidence for the final candidate.

Independent review findings were repaired and point-checked: known read failures
do not become unknown writes; optional acceptance edits/feedback do not reopen a
finished session task; side-context injection cannot replace a main final reply;
same-turn steering and later independent turns retain distinct receipts. Production
integration also caught ordinary IPC replacing a non-UUID message ID. Persisting
the actual UUID fixed this binding rather than guessing the last assistant reply.
A second integration failure involved a side result published before the main
conversation was bound. The fix supplies eligible pending results on a later
explicit Start, records their IDs, and consumes them after the main turn finishes.
Targeted regressions cover this case and interrupted return integration. Queue
admission alone is not consumption; `none` and stale decisions remain excluded.
The final side-delivery diff and regression assertions also passed an independent
read-only point-check; the production journey above supplies its execution evidence.
