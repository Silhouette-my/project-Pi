# Session B — Project Console, Chat Folders and Conversation Navigation

Implement the user-facing workspace/navigation and continuous conversation UI for
the Project Workflow MVP. Own design, implementation, tests and material usability
repairs in your write domain; do not stop with mockups or a static dashboard.

## Start

Work only at `/Users/michaeltan/Desktop/Programming/Pi/PI-Desktop-worktrees/project-workflow-ui`
on `feat/project-workflow-ui`. Read root AGENTS.md, renderer AGENTS.md, the five
parent brief files and the dispatch registry. Inspect current changes and preserve
the existing native Chat surface/reading-state behavior.

The user approved local task commits and local integration, not push/PR/main,
live-account calls or installed-app mutation. Use existing UI primitives/tokens
and i18n. Do not run verify:ui:* or attach to the user's running app.

## Own the result

1. Build parallel Chats/Projects navigation: ordinary Chat folders, unfiled chats,
   favorites/Recent, workstream grouping, shallow branches/children, stable order,
   folding, keyboard/focus and source-preserving history. Background agent activity
   must not reorder the user's navigation or surface every Run as a top-level row.
2. Build Project Console independent of active session: goal/stage, owners,
   progress/blocks, pending decisions/acceptance, current candidate, next action
   and project-level intent input with explicit routing.
3. Build the workstream main-line/side-panel experience: Start work, Discuss next,
   Adopt and continue, Pause to discuss, Ask/Explore/Work side creation, selective
   result adoption and actual status/artifact display. C supplies execution and
   context policy; A supplies authoritative state/API. Do not implement them in
   Zustand or renderer localStorage.
4. Provide shared resource/decision/skill-reference views and permitted editing,
   current-candidate open/feedback UI, scoped search with breadcrumbs and direct
   message/artifact jumps. Distinguish proposed/effective/superseded decisions and
   delivered/consumed results visibly where the user's next action depends on it.
5. Test real interactions and rendered states, including populated legacy
   conversations, project/session switching, long labels, folded history and
   current reading position. Update UI specs and required language mirrors.

## Work without waiting unnecessarily

A publishes C0 in `status/A.json`. Before it is ready, inspect actual UI and
existing navigation tests, establish reachable acceptance paths and implement
independent presentation refactors with preserved behavior. Do not create your
own duplicate shared types or a production fake-data store. Merge C0 after your
own safe commit; consume later published contract fixes as needed.

You own renderer except `src/lib/api.ts` and the new typed cross-process API
wrappers, plus i18n. A owns those API boundaries and all shared types. C owns
runtime. Put exact API needs in your status rather than editing another owner.
Follow EXECUTION.md for shared test/spec ownership and resource conflicts.

## Delivery

Publish verified commits in `status/B.json`, including scenario coverage, screenshots
or rendered inspection, API/runtime integration assumptions and remaining gaps.
Mark delivered only when your UI is wired to the real committed contract and your
checks pass; a fixture-only demonstration is not delivery. A owns final integrated
cross-process acceptance. Keep your worktree/branch for integration and repairs.
Report concisely in Chinese with actual evidence and the exact candidate scope.
