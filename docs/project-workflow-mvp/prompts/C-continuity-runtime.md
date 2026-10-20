# Session C — Chat/Work Continuity, Side Results and Project Execution

Implement the execution/context side of the Project Workflow MVP. The user wants
to stop manually carrying context and repeatedly asking for the next authorized
step. Deliver actual runtime continuation, not another summary generator.

## Start

Work only at `/Users/michaeltan/Desktop/Programming/Pi/PI-Desktop-worktrees/project-workflow-runtime`
on `feat/project-workflow-runtime`. Read root AGENTS.md, the five parent brief
files, applicable actual scoped rules and dispatch registry. Inspect the existing
Agent Host/turn/approval/lifecycle interfaces before choosing new abstractions.

The branch includes the user's source-only native Chat snapshot. Preserve its
provider/login/stream behavior and separate it from Agent/Plan operating modes.
Local development commits are approved; push/PR/main, real-provider/paid calls,
credentials and existing application/profile changes are not.

## Own the result

1. Assemble role-relevant context from A's authoritative project/workstream state:
   effective decisions, constraints, canonical resources/skills, artifacts,
   dependencies and authority. Do not indiscriminately inject all conversation
   history or promote a model summary to authorization.
2. Implement Start work, Discuss next, Adopt and continue and Pause to discuss.
   Chat receives real execution deltas; Work receives adopted decision changes.
   Unadopted discussion does not steer work, and choosing to discuss does not
   implicitly pause execution. Preserve cancellation/tool/error/usage semantics.
3. Implement Ask/Explore/Work input and write-back policies; durable result delivery
   to a workstream, explicit consumption/integration and stale-decision handling.
   Raw logs stay in the side. Actual shared/external effects remain observable.
4. Implement the event-driven local project loop: observe, select authorized next
   work, execute/delegate, consume, assess acceptance, reconcile state/docs and
   continue or request a concrete decision. Reuse existing turn queue/runtime/
   permission pathways. No polling LLM, unconditional retry or duplicate dispatcher.
5. Handle owner/dependency conflicts, pause/resume/cancel, parent session closure,
   app restart, stale results and ambiguous external execution. Reconcile before
   resuming; never automatically replay unknown side effects. A owns persistence
   and validated transitions, you own the execution/reconciliation policy.
6. Update relevant runtime specs and owner coverage notes. Exercise the actual
   service-to-runtime lifecycle with synthetic provider/external boundaries and
   actual internal wiring. Preserve existing synthetic Chat regression coverage.

## Interfaces and ownership

A publishes C0 in `status/A.json`. While waiting, investigate the actual lifecycle,
define decisive test scenarios and make independent responsibility-preserving
changes; do not invent parallel shared schemas. Merge C0 after a safe checkpoint.

You own agent-runtime, agent-host, host-runtime, Electron runtime modules and
`apps/desktop/electron/main/services/session-collaboration.ts`. A
owns shared types, Rust durable state, IPC/API and Main composition. Export a small
typed service/port implementation and specify the exact final wiring A needs.
Do not weaken plugin-only collaboration provenance to expose it in renderer.
You do not own app-store, Sidebar or provider setup UI.
Other existing Electron Main services, session-search and Chat browser transport
belong to A; request specific changes rather than adopting an unassigned file.

## Delivery

Publish exact commits, callable service entry point, wiring needs, lifecycle and
authorization tests, actual continuation evidence and remaining gaps in
`status/C.json`. Distinguish dispatch, delivery, consumption and acceptance.
Do not call the work complete if it merely starts one Run or writes a handoff.
A consumes your commits and owns integrated candidate acceptance. Retain your
worktree for in-scope repairs and report to the user in Chinese.
