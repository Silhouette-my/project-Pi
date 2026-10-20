# ADR: Project Workflow Durable State

- Status: Accepted for local MVP implementation
- Date: 2026-10-20
- Deciders: PI-Desktop maintainers
- Amends: ADR 0011, ADR 0249

## Context

The Project Workflow MVP needs progress, decisions, authorization, run outcomes,
candidate evidence and side-result consumption to survive session changes and
application restarts. Existing `ProjectGroupRecord` identity, session records
and message history must remain canonical. A renderer- or plugin-owned copy
would split authority; turning run completion into workstream acceptance would
lose the distinction between execution and product evidence.

## Decision

1. Rust `host-core` owns the durable workflow aggregate and validates every
   referenced project, session and source message against existing host state.
2. Schema v25 adds a versioned workflow snapshot and command ledger. A typed
   command and its new aggregate revision commit in one SQLite transaction.
   Commands carry unique IDs and an expected global revision; same-input replay
   is idempotent, ID reuse with different input conflicts, and stale revisions
   require refresh rather than last-writer-wins.
3. The aggregate is additive to existing ProjectGroup and session identity.
   Workflow folders affect navigation only. Existing project roots, transcripts,
   project instructions/memory and permission checks keep their existing owners.
4. Shared TypeScript schemas define capability-specific user and runtime
   commands. Renderer IPC exposes user commands and explicit actions; trusted
   runtime mutations remain behind the host port. This is not a Plugin SDK
   capability.
5. Decisions require source-backed adoption. Runs capture authorization and
   decision/workstream revision fences. Evidence references an exact candidate,
   revision, environment and acceptance item; completion remains explicit and
   distinct from run completion. Unknown external effects are reconciled rather
   than replayed.
6. Opening a recorded reference does not grant access: local references must
   resolve within a registered project-group root and HTTP(S) must pass the
   existing host URL gate. The operation returns the recorded revision.

## Consequences

- Project state remains available without selecting a session, while existing
  Chat and Agent/Plan entry points retain their identity and behavior.
- A global compare-and-swap boundary serializes workflow writes and makes a
  mutation plus its deduplication result atomic. Filtered reads retain the
  global revision; events signal consumers to reload the authoritative snapshot.
- Renderer, runtime and plugin cannot independently define persisted workflow
  states or self-approve a proposal. Runtime execution remains in the existing
  Node boundary, and host/tool permissions remain the authority ceiling.
- Run status, delivery, consumption, candidate evidence and acceptance remain
  separate records. Local fixture or component coverage alone cannot establish
  rendered-user or live-provider acceptance.

## Alternatives considered

- **Store the whole workflow in renderer state or project memory:** rejected
  because it would not provide host validation, atomic concurrency control or
  restart-safe state transitions.
- **Replace or extend the ProjectGroup/session identity:** rejected because
  workflow organization must not rebind workspaces or redefine transcripts.
- **Use arbitrary JSON replacement commands:** rejected because the host needs
  capability-specific validation and a trusted boundary between user intent
  and runtime observations.
- **Treat successful Run termination as acceptance:** rejected because a
  completed process is not evidence that current-candidate acceptance conditions
  passed.
