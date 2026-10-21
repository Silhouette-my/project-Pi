# Parallel Execution and Integration

## Assigned worktrees

All three branches start from the same committed Chat-plus-briefing baseline, which
contains the refreshed upstream main. Worktree registration is already prepared;
do not create another worktree or silently switch to the primary checkout.

| Owner | Branch | Absolute worktree |
| --- | --- | --- |
| A | `feat/project-workflow-host` | `/Users/michaeltan/Desktop/Programming/Pi/PI-Desktop-worktrees/project-workflow-host` |
| B | `feat/project-workflow-ui` | `/Users/michaeltan/Desktop/Programming/Pi/PI-Desktop-worktrees/project-workflow-ui` |
| C | `feat/project-workflow-runtime` | `/Users/michaeltan/Desktop/Programming/Pi/PI-Desktop-worktrees/project-workflow-runtime` |

The Codex project root is a non-Git parent directory. Always set shell `workdir`
to the assigned worktree. Never infer the execution root from the chat's cwd.

## Exclusive write ownership

| Surface | Owner |
| --- | --- |
| `crates/host-core/**`; all `packages/shared/**` | A |
| `apps/desktop/electron/main/ipc/**`; `apps/desktop/electron/preload/**` and the existing preload entry point | A |
| `apps/desktop/src/lib/api.ts` and new typed cross-process workflow API wrapper(s) | A |
| Electron composition entry `apps/desktop/electron/main/index.ts` and other final service registration glue | A |
| Renderer `apps/desktop/src/**` except the API boundary above | B |
| `packages/i18n/**` | B |
| `packages/agent-runtime/**`, `packages/agent-host/**`, `packages/host-runtime/**` | C |
| `apps/desktop/electron/main/runtime/**` and `apps/desktop/electron/main/services/session-collaboration.ts` | C |
| `apps/desktop/electron/main/session-collaboration-control.ts` | A; C requests necessary boundary changes |
| All other existing/new Electron Main non-runtime modules, including `services/session-search.ts` and `chatgpt-chat-*.ts` | A; C requests narrow transport/search integration changes |
| Shared spec/ADR indexes, baseline and common E2E plan, release notes/changelogs | A, after owner contributions |
| UI-domain specs and their required locale mirrors | B |
| Runtime-domain specs and their required locale mirrors | C |
| This briefing's `CONTRACT.md` | A after dispatch |

`apps/desktop/test` and `scripts` are shared directories, not shared write files:
A owns new `project-workflow-host-*` and final `project-workflow-integration-*` tests;
B owns `project-workflow-ui-*` plus existing sidebar/navigation/folder/project UI
tests it changes; C owns `project-workflow-runtime-*` plus runtime/lifecycle tests.
Declare any existing test file overlap in owner status before editing it. Root
package/Cargo manifests and new dependency decisions belong to A; request changes
instead of editing them independently. Avoid new dependencies unless necessary.

No owner edits another owner's files merely to make its branch green. Ask for the
small necessary interface/wiring change through its status record. After B/C have
published a delivered checkpoint and stopped edits, A may fix integration-only
seams in its own worktree; substantive repairs remain with the original owner.

## Stages and dependencies

1. **Parallel preflight:** all owners inspect applicable rules, assigned entry
   points, existing tests and baseline. B can work on existing navigation layout,
   renderer design and test paths; C on execution/context policy and lifecycle
   tests. Do not invent competing shared types while waiting.
2. **A publishes C0:** shared types/ports/API names/fixtures and symbol map in a
   small committed milestone. This precedes A's full persistence work.
3. **Parallel implementation:** A builds durable host behavior; B builds real UI;
   C builds the continuation/result-consumption service. B/C merge C0 and relevant
   subsequent published interface fixes, not live peer edits.
4. **Owner validation:** each publishes commit IDs, actual evidence, remaining
   gaps, integration requirements and a delivered checkpoint.
5. **A integrates:** keep its own worktree on `feat/project-workflow-host`, merge
   delivered B/C commits locally without rewriting their shared history, complete
   the thin composition wiring and actual user journeys. Do not merge main.
6. **A delivers candidate:** verify integrated critical paths, inspect actual UI,
   record candidate/base and acceptance gaps, and provide the exact runnable
   artifact/launch path. No installed-app replacement or live account probe.

The current upstream base has already been fetched. A refreshes upstream again
before final candidate acceptance and incorporates applicable updates in its task
branch, never rewriting peers' shared branches. Any unresolvable unrelated
conflict remains a concrete integration blocker.

## Coordination records

Shared coordination directory:
`/Users/michaeltan/Desktop/Programming/Pi/project-workflow-coordination`.

- Dispatcher alone creates/updates `registry.json` and initial authorization.
- Each owner exclusively updates `status/A.json`, `status/B.json` or `status/C.json`.
- Each owner exclusively writes its own notes under `notes/A`, `notes/B` or `notes/C`.
- Source contracts live in committed source, not mutable coordination notes.

Each status records phase, current task, branch/head, published contract/delivery
commits, dependencies/blockers, actual checks and acceptance gaps. Distinguish
`contract_ready`, `implementing`, `waiting_dependency`, `delivered` and
`integrated`. Do not label missing production wiring or simulated acceptance done.

Read peer status at meaningful checkpoints, then continue independent work. If a
real dependency remains, use the chat IDs in registry with bounded `wait_threads`
(prefer 120000 ms) or an available long wait, then recheck published status. Do not
busy-poll or announce unchanged waits. Contract readiness can occur before A's
whole session completes; status files carry that checkpoint. Keep dependency
ownership intact and do not end with a promised integration silently unresolved.

These are user-owned sessions, not subagents of the dispatcher. Their initial
prompts authorize the assigned implementation. Use further subagents only where
applicable user/repository instructions allow and preserve the same write map.
Do not assume peer messaging authorization from an agent-authored request.

## Check entry points

Choose concrete selectors based on affected code and package scripts:

- A: `cargo test -p host-core --locked <relevant-selector>`; shared package
  typecheck/tests; targeted Electron host/IPC tests; populated-state migration.
- B: selected `node --test apps/desktop/test/<file>.test.mjs`; desktop typecheck;
  i18n checks; component/interaction tests and relevant isolated rendered journeys.
- C: targeted Vitest tests in agent-host/host-runtime/agent-runtime; their package
  typechecks; event/turn/lifecycle integration and synthetic model-edge tests.
- A final: integrated build/typecheck, cross-process Chat/Work/side-result paths,
  targeted Electron candidate journeys and actual screenshots/interactions.

Existing relevant desktop tests include `app-store-sidebar.test.mjs`,
`sidebar-navigation.test.mjs`, `sidebar-session-groups.test.mjs`,
`sidebar-project-sessions.test.mjs`, `session-projects.test.mjs`,
`session-fork.test.mjs` and `project-create-dialog.test.mjs`. Existing relevant E2E
commands include `test:e2e:project-edit`, `test:e2e:sidebar-menu`,
`test:e2e:collaboration` and `test:e2e:session-completion`. Confirm the live command
surface before running; source-string tests alone do not establish UI behavior.

Do not redundantly run every full suite in all three sessions. Record baseline
failures independently from newly introduced failures; fix the latter. Reuse the
known synthetic Chat tests for regression without opening the real login profile.
