# ADR: Project Agent discussion sessions

- Status: Accepted
- Date: 2026-10-20

## Context

The project entry point must allow discussion before any work item exists.
Existing workflow conversation links require a workstream. Ordinary Plan mode
can run Shell and therefore cannot enforce a discussion-only promise.

## Decision

Keep ordinary Session persistence and ChatSurface rendering. Store a separate
project-to-session association in the Host-owned workflow aggregate, as the
optional additive v1 `projectAgents` field. The trusted runtime mutation
`agent.create` writes Session metadata and the association in one Host CAS
transaction, using existing Session persistence and internal `agent.link`
validation. Main publishes the session only after commit. Revision conflicts
create nothing; persistence failures roll back both records without deleting
user-consumed data. The user action `agent.open` creates or resolves the
canonical live session without creating work, runs or authorizations.

Resolve the persisted association on each launch. Runtime receives a
`discussionOnly` policy that removes its entire tool catalog, trusted extensions
and delegation independently of mode changes. Host tool admission also rejects
every tool for that session identity before permission handling, so runtime
configuration, turn IDs and auto/session grants cannot widen authority.

Continue loading existing project instructions/memory; supplement them with the
current workflow projection. The project Agent proposes work in conversation.
Creating and authorizing a separate work item remains the execution boundary.

## Compatibility and verification

No existing session mode or workflow conversation schema changes. Old v1
snapshots load with an empty project Agent association; ordinary sessions keep
their existing tool policy. The new field is optional in shared validation.

Focused tests cover empty-project opening, concurrent revisit, orchestration
restart, Host database reopen, legacy snapshots, existing execution-session
rejection, no synthetic work/authority, Host tool denial, and an empty runtime
catalog after Agent/Plan/Goal mode changes. Native rendered interaction belongs
to the desktop integration acceptance, not these backend tests.
