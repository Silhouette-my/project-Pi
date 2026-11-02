# Mutable conversation return policy and the return command

## Context

A project side conversation carries a `returnPolicy` (`none`, `proposal`,
`delivery`) that says where its answers go. `conversation.link` treated the
whole row as execution identity and rejected any change, so the policy chosen
at creation could never be corrected. The work panel now shows the policy as a
pill the user changes at any time, like model or effort, and offers a
"return to conversation" action.

## Decision

Two additive Host commands, both user commands through the existing
`project.workflow.mutate` path (revision CAS, command ledger, replay):

- `conversation.policy { projectId, workstreamId, sessionId, returnPolicy }`
  changes only `returnPolicy` of an existing conversation. `conversation.link`
  keeps rejecting changes to `parentSessionId`, `sourceMessageId`,
  `sourceRevision`, `relation`, `purpose`, `readContext` and `returnPolicy`, so
  context and ancestry stay immutable and the generic link cannot be used as a
  back door. A workstream main conversation keeps `delivery` (rejected with
  `CONFLICT`): the runtime relies on it.
- `conversation.return { projectId, workstreamId, sessionId, recordId, title,
  text, createdAt }` records what the conversation returns, decided by the
  stored policy, never by the caller:
  - `proposal` inserts a `decision` in state `proposed` whose source is
    `{ kind: "session", ref: <sessionId>, revision: <sourceRevision> }`. It
    appears in the project's Context tab; the view labels a session source that
    names a side conversation as "from side conversation: <title>".
  - `delivery` inserts an `artifact` of kind `report` (label = title, source =
    the session, entry point `session:<id>`) and bumps the workstream revision,
    so it lists under recent outputs. A `delivery` record needs a run
    (`sourceRunId`) and is published by the runtime, so a side conversation
    without a run cannot use it; a report artifact is the least invasive
    existing record. Its entry point is not a file, so opening it as a
    reference is refused ("Unsupported reference URI") rather than guessed.
  - `none`, or a main conversation, is rejected with `CONFLICT`.
  The record id is supplied by the caller and is never reused.

Neither command changes persisted shape: both write existing record kinds, and
snapshots written before this change stay valid (no schema bump).

## Consequences

- Shared `ProjectWorkflowUserCommandSchema`, Host `validation.rs` and
  `commands/organization.rs` gain the two kinds; IPC and preload need no new
  channel because they forward `isProjectWorkflowUserCommand` commands.
- Changing the policy never retroactively edits records already returned.
- Chat side chats (summary / full into the parent's composer draft) and the
  project Agent are renderer-only and add no Host state; they never send.
