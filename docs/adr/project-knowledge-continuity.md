# ADR: Separate Agent-maintained project knowledge from user memory

- Status: Accepted
- Date: 2026-10-29
- Related: ADR 0234, ADR 0249, Project Workflow durable state

## Context

Ordinary Agent conversations can read explicit user-authored project memory but
cannot retain or correct a project finding for a later conversation. Workflow
decisions provide provenance and revision semantics, but require a workstream
and have their own proposal/adoption contract. Making every conversation create
a workstream would reintroduce the management burden the lightweight session
path removed.

Writing model-generated summaries into the existing user memory would also
misattribute their author and replace a working editing/synchronization contract.

## Decision

Add a separate, versioned `projectKnowledge` collection in the existing Host
`kv` store. Resolve it through the existing logical project identity, including
legacy path projects. Keep `projectMemory` and Workflow decisions unchanged.

Ordinary Agent tools read and maintain knowledge through Host. The execution
transport and Host derive the session, current turn, and source message; model
arguments cannot assert an author or select an arbitrary project. Updates use a
project-identity precondition and compare-and-swap revision. Replacement retains
the superseded record, while forgetting removes it from current context without
erasing the revision trail.

Launch preparation loads current records for normal project conversations,
independently of Workflow membership. The runtime labels the projection as
Agent-maintained context and refreshes it after a successful write. The existing
memory dialog exposes inspection, source navigation, history, and forgetting
alongside the separate user-authored editor.

## Consequences

- Switching conversations or runtime instances does not lose current project
  findings. Corrections can replace stale conclusions without repeating them
  as current context.
- Existing user memory, project instructions, Workflow adoption, permissions,
  and Project Agent discussion-only behavior retain their contracts.
- A bounded active projection controls prompt growth; historical material is
  available through explicit reads rather than automatic full injection.
- Record quality still depends on the Agent selecting useful, supported
  conclusions. The application records provenance and lifecycle, not semantic
  truth. Real model quality is measured separately from fixture-based wiring
  and persistence tests.
- This is local project data, not a new configuration-sync category or a
  background model service. No new database table or schema migration is needed.

## Alternatives considered

- **Append to user-authored memory:** rejected because it confuses authorship
  and silently changes the existing editor and sync contract.
- **Require Workflow decisions:** rejected because ordinary conversation
  continuity must not require a workstream or imply proposal adoption.
- **Store a second copy of every transcript:** rejected because the existing
  transcript store already owns the source history.
- **Start with a vector database or scheduled summarizer:** deferred; neither
  is necessary to establish the remember/correct/forget/continue path.

Behavior and limits are specified in
[Project knowledge](../spec/03-runtime/project-knowledge.md).
