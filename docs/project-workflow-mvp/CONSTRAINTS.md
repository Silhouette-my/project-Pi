# Shared Project Constraints

## Authority and delivery

The human authorized three implementation sessions, a source-only Chat baseline,
local development commits and local integration. This is implementation authority,
not a plan-only assignment. Proceed with reversible in-scope work and fix failures
introduced by it. Final product acceptance remains against PRODUCT.md.

No push/PR, merge into main, release, production action, paid/live-provider call,
credential access/copy, installed-app replacement or existing user-profile change.
Do not run `verify:ui:*` or attach to the user's running app. Targeted isolated
Electron tests with synthetic boundaries and task-local profiles are allowed.
If real-account acceptance is indispensable, report that exact gap and ask for the
specific bounded action; do not invent evidence or silently retry it.

Follow repository AGENTS.md and actual scoped rules. Root policy wins over older
delivery docs (including their contradictory unconditional commit/cleanup text).
Local commits are specifically allowed here. Remote delivery is not. Keep all
task worktrees until the integrated local candidate is accepted; do not delete a
peer's branch/worktree. Do not alter AGENTS.md/CLAUDE.md or global configuration.

## Immutable architecture and existing behavior

- Renderer owns presentation/interaction, not SQLite or agent execution.
- Electron Main remains thin orchestration/registration.
- Rust host-core owns durable state and permission/identity validation.
- Node agent execution stays in the existing runtime/Agent Host boundary.
- Shared holds actual cross-process types/schemas, never desktop internals.
- Reuse existing ProjectGroup identity, roots, instructions/memory, session IDs,
  turn queues, collaboration records and permission mechanisms where suitable.
- Chat folders are distinct from project identity and access scope. Moving a chat
  within folders does not rebind a workspace, change model context or elevate tools.
- Preserve original transcripts, message IDs, fork source, provider bindings,
  history/reading position and existing Agent/Plan semantics.
- The user-authorized native consumer Chat source is part of every branch baseline.
  Do not replace it with the website, a Codex subscription route, or a mock provider.
- Preserve stop, error, tool-call, usage and cancellation semantics across adapters.

Do not put project execution logic into Sidebar, app-store, main/index.ts or a new
monolithic module. Extract responsibility-based modules only as needed. Never add
a second Project database or independently invented UI/runtime status model.

## State and information boundaries

Current effective decisions, historical sources, execution status and acceptance
evidence are distinct. Every consequential semantic update retains its source and
applicable revision. A model proposal cannot approve itself or grant authority.

Workstream acceptance and Run termination are separate. Track material side effects
even for a side conversation that does not return raw text. Scope completion,
pause/cancel and invalidation to the affected work. Guard against stale results,
duplicate dispatch and restart ambiguity on real changed paths.

Validate untrusted inputs at the boundary; trust established internal invariants.
Do not add speculative fallback layers, silent success, unsupported retries or
parallel compatibility systems. Keep existing persisted formats readable through
an additive/versioned path. If new tables are necessary, include explicit migration,
version and populated-old-state/restart tests; never require deletion of user data.

## UI and documentation

Use existing UI primitives and design tokens. All user-facing UI text uses i18n,
including accessible labels and error/status messages. Preserve user naming/order.
No fabricated project progress or fixture data in production UI.

Repository code, contracts, specs, ADRs and commit messages are English-first;
report to the user in Chinese. Update actual relevant specs and E2E scenarios,
including mirrored docs as required by current repo tooling. An ADR records an
implemented decision; it does not replace executable contracts or grant permission
to change a frozen architecture. Breaking public/data/security changes require
the user's decision; additive in-scope implementation should proceed.

## Worktrees, dependencies and machine resources

- Each session uses only its assigned worktree/branch for source edits.
- Never edit primary main or the original Chat worktree, or depend on live
  uncommitted peer code. Import published committed milestones only.
- Explicit-path staging only. No stash, reset-hard, broad clean, add-all,
  force-push, hook bypass or unrelated process termination.
- Reuse available toolchains, package stores, compatible dependencies and runtime
  binaries. Do not provision three complete environments solely for E2E.
- Check workspace dependency symlinks: tests must resolve this worktree's packages,
  not a peer's writable `dist` or original Chat sources. Isolate mutable build
  output, tsbuildinfo, test profiles, sockets, logs and candidate artifacts.
- Concurrent heavy Cargo/Electron builds can defeat parallelism. Owners run fast
  targeted checks independently; final expensive integrated build belongs to A.
  Record a temporary shared-resource need in owner status and coordinate before
  using the same mutable cache or app instance.
- Use native shell for ordinary Git/build/test/config actions and Bash semantics.
  Use FastCtx for file inspection/search/replacement and durable background jobs
  when appropriate. Do not bypass an approval denial with another tool.

## Verification and truthful status

Run checks that establish changed behavior, not whole-suite ceremony. Preserve
valid same-candidate evidence; rerun when changed inputs invalidate it. Each new
feature needs a reachable user path with real internal wiring, not only pure
helper tests or source-string assertions.

Host: populated-state/migration and state-transition tests. Contracts: producer/
consumer request, event and error tests. Runtime: event ordering, result consumption,
authorization, pause/recovery and actual continuation. UI: interaction, navigation,
keyboard/focus, overflow and rendered state. Use targeted isolated Electron tests
for cross-process acceptance and inspect screenshots from the actual candidate.

Record candidate/base commit, commands, results, environment, applicable scenarios,
and remaining gaps. Fixtures, component tests, rendered UI, live-account behavior
and deployment are separate evidence. A requires passing integrated critical paths
before calling the MVP complete. A source-only snapshot does not supply new test
or live-account acceptance evidence.
