# Project Knowledge and Conversation Continuity

## User path

An ordinary Agent conversation can retain a useful project finding, current
working state, or adopted decision. A later conversation in that project receives
the current records without requiring a Workflow task. When the user corrects a
finding, the Agent replaces the record; the old version remains available as
history but is no longer included as current context.

The existing Project memory editor keeps user-written notes separate from
Agent-maintained records. Users can inspect the latter, open their source
conversation, view revision history, and forget a record without editing their
own notes.

## Ownership and trust

- Rust Host owns persistence and resolves the project from trusted session
  identity. Renderer state and model-supplied paths do not select a tool's scope.
- User-authored `projectMemory` remains unchanged, including its existing
  `entries-v1` and legacy plain-text behavior.
- Agent records are a separate, versioned Host `kv` collection under
  `projectKnowledge`, keyed by logical project identity. Their context block
  explicitly identifies them as Agent-maintained notes, not user instructions
  or verified facts. Current user input, project instructions, and authoritative
  source material take precedence.
- A record cannot grant permissions, adopt a Workflow proposal, change a task's
  completion state, or elevate a temporary authorization into project policy.
- Project membership and filesystem access keep their existing meanings.
  Project Agent discussion sessions retain their tool prohibition. Plan and
  historical bounded Workflow execution retain their existing write boundaries.
- This collection is local project data. It does not extend the existing
  configuration-sync category for user-authored memory.

## Records and updates

A version-1 snapshot contains `projectId`, `revision`, and `entries`. Each entry
contains a stable `id`, `kind` (`state`, `decision`, or `knowledge`), `title`,
`content`, `status`, source identity, and creation/update timestamps. A source
identifies the originating `sessionId`, `messageId`, and `turnId`; the trusted
execution path derives and validates it rather than accepting a claimed author
from the model.

The supported lifecycle is:

1. **Remember:** create an active record for information useful beyond this
   conversation.
2. **Replace:** create a new active record with `supersedesId`, and mark the old
   entry superseded. Do not overwrite its historical content or source.
3. **Forget:** mark the chosen record forgotten and exclude it from future
   current-context projections. Historical inspection still identifies it.

Writes carry `expectedRevision` and the `expectedProjectId` returned by the
read. The latter is a precondition checked against the session-derived project,
not permission to choose a write target. A stale write fails with a conflict; the caller
reloads current state and reconciles the intended change. There is no silent
last-writer-wins overwrite. Invalid or oversized input fails without a partial
save. Forgetting and replacing never modify the user-authored collection.

Limits are 160 characters per title, 4 KiB per content value, 40 active entries,
16 KiB of active title/content text, and 1 MiB of stored history. Reaching a
limit is an explicit `PROJECT_KNOWLEDGE_LIMIT` error, not silent truncation or
automatic deletion of older records.

The user can explicitly clear historical records in Project memory after
confirmation. This removes superseded and forgotten entries, preserves all
active entries and user-written notes, and leaves source transcripts unchanged.
The operation uses the same revision precondition and provides recovery when
the history limit is reached. Agents do not automatically prune history.

## Runtime use

`ProjectKnowledgeRead` provides project-scoped records, with an optional text
query and historical inspection. History reads use `offset`/`limit` pagination
(at most 40 entries per page). `ProjectKnowledgeWrite` supports remember,
replace, and forget against an expected revision. Neither tool accepts a target
project path or a claimed source author.

Normal project sessions load the current projection at their launch boundary,
including a new session with no Workflow association. Superseded and forgotten
content is absent from that projection. Source identities remain available for
traceability. The original transcript stays in its existing store.

Only active entries travel through the launch boundary or a successful Agent
write response; loading a runtime does not transfer the full stored history.
Native Pi sessions whose canonical transcript lives outside Desktop's Host
session store retain their existing context path and do not enable this new
Host-bound collection.

Launch preparation reloads the Host snapshot. Its revision participates in
runtime reuse, so a subsequent turn does not keep a cached pre-correction
projection. A successful in-turn knowledge write refreshes that runtime's
project-knowledge prompt immediately.

The Agent should retain material conclusions and corrections, not every tool
log or turn. It should revise an existing record instead of accumulating
contradictory summaries. A design option is not an adopted decision; a test
result is not broader verification than the observed candidate and environment.
The feature adds no summarization service, scheduled model calls, vector
database, or cross-project automatic sharing.

## Desktop interface

The existing preload surface exposes:

- `projectKnowledgeGet({ groupId })` → current snapshot, including history.
- `projectKnowledgeForget({ groupId, entryId, expectedRevision })` → updated
  snapshot.
- `projectKnowledgeClearHistory({ groupId, expectedRevision })` → updated
  snapshot after explicit user confirmation in the editor.

The editor renders these records separately from the editable user notes.
Forgetting takes effect immediately through Host, independently of the user
notes' Save/Cancel actions. Loading errors and revision conflicts remain visible;
switching projects cannot apply an earlier project's response to the new one.

## Related specifications

- [Data storage](04-data-storage.md)
- [Agent runtime](02-agent-runtime.md)
- [Project workflow state](../02-architecture/project-workflow-state.md)
- [Project memory ADR](../../adr/0234-project-owned-memory-context.md)
- [Logical project groups ADR](../../adr/0249-chatgpt-style-logical-project-groups.md)
