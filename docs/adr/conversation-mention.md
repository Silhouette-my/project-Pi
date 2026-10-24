# ADR conversation-mention: `@` mentions of conversations in every composer

- Status: Accepted
- Date: 2026-10-24
- Deciders: PI-Desktop runtime and desktop UI maintainers
- Amends: issue #1324 session references (same-project boundary and
  "no new trigger symbol")
- Preserves: ADR side-chats-on-detached-transcripts, ADR project-structure-views,
  D123 to D125 (`@` files and `/` commands)
- Related: [04-ux/08-component-spec.md](../spec/04-ux/08-component-spec.md) §20B ·
  [03-runtime/02-agent-runtime.md](../spec/03-runtime/02-agent-runtime.md) ·
  [06-delivery/04-e2e-test-plan.md](../spec/06-delivery/04-e2e-test-plan.md)

## Context

Issue #1324 let a draft carry `pi-desktop://session/<id>`: the renderer keeps the
link in the draft (a `kind: "session"` chip when pasted), Electron main reads the
referenced conversation through `session.get` before dispatch, attaches a bounded
excerpt to the user message, and the agent runtime quotes it as one
`<session_reference>` block. The only way to produce a link was copying it from a
conversation menu, and main refused conversations of another project.

The approved prototype makes referencing a conversation a first-class composer
action: typing `@` lists conversations, grouped by current project, recent and
other projects, in every composer (the chat Composer and the detached
conversations used by side chats, project side conversations and the project
Agent).

## Decision

1. **No new prompt contract.** A mention is the existing session link. The chat
   Composer's draft holds a `kind: "session"` chip; a plain-textarea composer
   holds `@title` text plus a renderer-only mention list and serializes the
   tokens to links when it sends. `sendPrompt`, the shared types, the host RPC
   and the runtime's `sessionReferenceBlock` are unchanged. The model receives
   the same bounded block (40 newest messages, 8 KB per field, 16 KB total, at
   most four links per message) it received for a pasted link.
2. **`@` lists conversations before files.** Conversations are offered by a pure
   rule module (`features/chat/mention/mention-core.ts`): groups current project,
   recent, other projects; empty groups dropped; at most 40 rows; filtered by
   title; the current conversation, remote sessions and scheduled-run transcripts
   excluded. File completion keeps working below its own heading (and alone in a
   draft with no matching conversation); the file grammar and its tests are
   unchanged.
3. **The same-project boundary is removed.** Naming a conversation from another
   project is now an explicit user choice made from a list that labels each row
   with its project, so main no longer drops such links. Unknown ids, the
   current conversation and `remote:` ids are still dropped. The link text only
   enters a prompt through the user's own pick or paste; model output cannot add
   one. The excerpt stays bounded and read-only.
4. **The token is a quiet tile.** In the draft and in sent messages the token is
   `@title` without an icon; the tooltip says `引用对话：<title>`; activating it
   opens that conversation. Titles follow renames in sent messages (the existing
   live-title lookup).
5. **Boundaries.** Renderer owns the UI and token rules; Electron main still
   resolves links; Rust host-core and the agent runtime are untouched. The chat
   Composer has no `+` menu, so no menu entry is added.

## Consequences

- Cross-project context is reachable without copying links. A user who does not
  want a conversation read simply does not mention it.
- A plain-textarea draft survives a surface remount through a renderer-memory
  map; after an app restart its tokens are plain text and are not resolved.
- The chat `@` menu lists conversations first, so a bare `@` highlights a
  conversation rather than the first file.
- Tests: `apps/desktop/test/conversation-mention-core.test.mjs` (trigger,
  grouping, token edits, serialization), `session-references.test.mjs` (main
  resolution across projects), `session-reference-ui.test.mjs` (token rendering),
  and `scripts/e2e-conversation-mention.mjs` (popover, token, sent message and
  the model request holding the context, in both composer kinds).
