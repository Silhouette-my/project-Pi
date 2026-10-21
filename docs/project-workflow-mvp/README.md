# Project Workflow MVP — Parallel Development Brief

Status: authorized local implementation, 2026-10-20.

Build a project-oriented workspace in which the user directs outcomes instead of
transporting context between sessions. Chat, Work and side conversations share a
durable workstream while retaining explicit context and permission boundaries.

## Read in this order

1. The repository `AGENTS.md` and applicable existing scoped rules.
2. [Product and acceptance](PRODUCT.md).
3. [Shared constraints](CONSTRAINTS.md).
4. [Interface handoff](CONTRACT.md).
5. [Parallel execution and ownership](EXECUTION.md).
6. Your assigned prompt: [A](prompts/A-host-integration.md),
   [B](prompts/B-workspace-ui.md), or [C](prompts/C-continuity-runtime.md).

## Three owners

| Session | Responsibility | First deliverable |
| --- | --- | --- |
| A — Host, contracts and integration | Authoritative state, shared API, IPC, persistence, final integrated candidate | A small committed contract package consumed by B and C |
| B — Workspace and navigation | Project Console, Chat folders, workstream tree, main/side conversation UI, i18n | Navigable real renderer surfaces using A's contract |
| C — Continuity and execution | Context assembly, Chat/Work handoff, side-result delivery, authorized continuation and recovery | Runtime service using A's state/command contract |

A owns final local integration. B and C own their respective behavior through
targeted checks and adjacent repairs; they are not merely file-editing helpers.

## Source baseline

- Primary checkout: `/Users/michaeltan/Desktop/Programming/Pi/PI-Desktop`.
- Refreshed upstream base: `87a48b953e8bada43a7a63f8922846198b9efb61`.
- User-authorized source-only Chat snapshot:
  `6e3beac28501f168a9f8e3be05dddd248923f3e6`.
- Original Chat worktree:
  `/Users/michaeltan/Desktop/Programming/Pi/PI-Desktop-worktrees/chatgpt-chat-mode`.
  It is not an editable dependency and must remain untouched.
- Frozen briefing worktree:
  `/Users/michaeltan/Desktop/Programming/Pi/PI-Desktop-worktrees/project-workflow-base`.
- Dispatch registry and per-owner status:
  `/Users/michaeltan/Desktop/Programming/Pi/project-workflow-coordination/`.

The snapshot contains 46 tracked modifications and 19 new source files, applied
on the refreshed upstream base. It excludes ignored files, profiles, cookies,
credentials, installed applications and runtime data. Its preservation is not a
new claim that the Chat provider passed live-account acceptance.

The registry records the final briefing commit, exact branch/worktree identities
and created chat IDs. Read committed source from the assigned branch, not a
peer's in-progress files. These documents are the implementation brief, not a
replacement for maintained product specs; each owner updates affected specs.

## Delivery boundary

The user explicitly approved local source snapshots, development commits and
integration on dedicated branches. No push, PR, remote publication, main merge,
production deployment, paid/live-model testing or existing app/profile mutation
has been authorized. Deliver a local integrated candidate and valid evidence.
