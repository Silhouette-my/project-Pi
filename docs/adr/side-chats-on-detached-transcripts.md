# ADR side-chats-on-detached-transcripts: Chat side chats on detached transcripts

- Status: Accepted
- Date: 2026-10-22
- Deciders: PI-Desktop runtime and desktop UI maintainers
- Supersedes: ADR 0268 decision 5 (side chats) only
- Keeps: ADR 0268 decisions 1 to 4 and 6 to 7 for quotes, annotations, the
  selection overlay and the retired identifiers
- Amends: ADR message-quotes-and-side-chats (first-send amendment, Issue #421)
  as history only; that ADR stays superseded
- Preserves: D097, D128, D134, D154, D209, D301, ADR 0033, ADR auto-hide-side-panels,
  ADR project-structure-views
- Related: [04-ux/08-component-spec.md](../spec/04-ux/08-component-spec.md) ·
  [04-ux/09-interaction-patterns.md](../spec/04-ux/09-interaction-patterns.md) ·
  [04-ux/01-ui-ia.md](../spec/04-ux/01-ui-ia.md) ·
  [06-delivery/04-e2e-test-plan.md](../spec/06-delivery/04-e2e-test-plan.md)

## Context

ADR 0268 removed side chats together with quotes and annotations. Its stated
reason for side chats was that a side chat was "a second session lifecycle": the
renderer owned a registration map, a per-session transcript projection
(`projectSideChatEvent`) that duplicated the transcript reducer, and cascade
cleanup rules, while the only durable artifact was the forked child that
`session.fork` already produces.

The product still lacks a way to ask a side question about an answer without
replacing the visible conversation. Since then ADR project-structure-views added a
**detached transcript**: `attachSessionTranscript(id)` keeps one session's live
transcript readable through the background event projection that already feeds every
retained transcript, without activating it, and `DetachedConversation` shows such a
transcript with a compact composer (Send and Stop). The project Agent dock and the
project side conversations use it today.

## Decision

1. **Side chats return on the chat page, built on `DetachedConversation`.** The
   panel body is `DetachedConversation` bound to the child session. The child is
   read through `attachSessionTranscript`; there is no renderer transcript map, no
   second reducer and no `sideChats` registry.
2. **Entry.** An **Ask in side chat** action (`chat.askInSideChat`) joins the hover
   action row of a completed assistant turn, beside Fork, and of a user message,
   beside Copy. Copy, Edit, Delete, Fork and Retry are unchanged. The action is
   offered only on the visible conversation's own transcript, so a transcript
   shown by a detached surface (including a side chat) never starts another one.
   The context menu is unchanged.
3. **Draft first, fork on first Send (Issue #421 semantics).** The click opens a
   work-panel tab of kind `sidechat` anchored at `{parentSessionId,
   anchorMessageId}` with no session. Opening and typing create nothing. The
   first explicit Send calls the existing `session.fork` through `api.forkSession`
   with the anchor, commits the child without activating it, attaches its
   transcript, then sends through `sendPrompt` with the child's id; the tab now
   carries the child session id in `resource`. Concurrent Sends share one
   creation. A failed creation leaves nothing behind. A successful fork followed
   by a failed send keeps the child, so the retry sends to it instead of forking
   again. A running or read-only parent disables the first Send with a visible
   reason (`DetachedConversation.disabledReason`); an existing child keeps its own
   queue and Stop behavior.
4. **Tab kind.** `sidechat` is a work-panel tab kind keyed `sidechat:<parent>:<anchor>`,
   so asking again from the same message reuses the tab. It is created only by
   the explicit user action, so ADR 0033 holds: no agent event opens it. A tab
   without its anchor is not a known tab. The tab is part of the parent's panel
   context and is not persisted across a restart; the durable child is. The
   tab's header shows the side-chat title, a one-line excerpt of the anchored
   message, the **Return to main thread** mode control and action, and **Open as a
   conversation**.
5. **Auto-hide panels.** An unpinned right panel opened by the explicit click
   reveals through the existing gesture rule of `useSidePanelReveal` (the click is
   a pointer gesture within its 400ms window); no change to that hook is needed.
   The reveal is a command reveal, so it stays while the user types.
6. **Return to main thread (amended 2026-10-22).** Each side chat has a return
   mode, a renderer-only setting (side chats are renderer-owned forks) that can
   change at any time: **None** (`none`, the default), **Summary** (`summary`)
   or **Everything** (`full`). It lives in `side-chat-slice` keyed by the tab id,
   is never persisted and is dropped with the tab. One action, `sideChat.returnToMain`,
   replaces the former **Add to main chat**; it is disabled with a visible reason
   while the mode is None, before a child exists, while the side chat is
   running, and when it has no exchange yet.
   - **Summary** sends a visible prompt in the side chat itself (`sideChat.summaryPrompt`,
     asking for points and decisions, not a transcript), waits for that turn
     (`runningSessions[child]` goes true, then false; 120 s timeout, failures shown
     in the header), then quotes the newest assistant answer with a `Summary`
     label and the `chat.quoteSource` attribution, capped at 4000 characters. The
     button shows progress and ignores a second click while the turn runs.
   - **Everything** quotes every user and assistant text exchange after the fork
     anchor, in order, with role labels (tool rows are skipped), capped at 12000
     characters. The newest exchanges are kept and a visible note says how many
     earlier ones were omitted. The fork copies the parent prefix with remapped
     message ids, so the prefix length is recorded before the first prompt.
   - Both modes only append to the parent's per-session draft (D301) through
     `appendComposerDraftText` and hand the snapshot to a mounted Composer through
     the existing prefill path. They keep what the user typed and never send; the
     user reviews the draft first.
   - **Why None is the default:** PRODUCT P6 gives Ask no automatic effective-context
     write-back. Returning context is an explicit, per-side-chat opt-in, and even
     then it lands only in an unsent draft.
7. **Open as a conversation** closes the tab and selects the child through the
   normal `selectSession` path.
8. **Closing the tab** removes only the tab and its unsent draft. A created child
   is an ordinary session in the sidebar and in search; nothing is deleted.
9. **Still removed.** Quotes, the selected-text overlay, annotations and quote DOM
   recovery stay removed exactly as ADR 0268 decided. Their decision and E2E
   identifiers stay retired. The new scenario has its own identifier,
   `E2E-CHAT-side-chat-detached-panel`; the retired `E2E-CHAT-side-chat-*` and
   `E2E-SESSION-native-side-chat-fork-survives-close` identifiers are not reused.
10. **Boundaries.** Host protocol v11, storage schema v15, no new IPC channel, no
    new permission and no Rust change.

## Why ADR 0268's objections no longer apply

- **Renderer-owned projection lifecycle.** There is no projection: the child
  is read by the detached transcript that ADR project-structure-views already
  owns. No registration, release or cascade-cleanup rule exists. The only
  renderer state is the tab (with its anchor and child id) and an in-memory draft
  string, both released by one subscription when the tab leaves every panel context.
- **A second transcript reducer.** Gone for the same reason: background event
  projection is the single reducer and `DetachedConversation` only reads it.
- **A DOM-based quote and selection overlay.** Not restored. Entry is a button in
  the action row, so no selection is read and no excerpt is recovered from the DOM.
  The anchored excerpt is taken from the transcript message in the store, and the
  quote is taken from the child's store messages.
- **Annotations.** Not restored; there is no prompt serialization beyond the
  user's own text, so no display surface has to reverse one.

The remaining cost ADR 0268 named, a second route to the same durable child, is
accepted: Fork replaces the visible conversation, the side chat does not.

## Consequences

- A side question streams beside the main conversation; the visible session, its
  scroll position and its draft stay where they were.
- The renderer gains about 550 lines in `features/chat/side-chat/`, one small
  store slice and one tab kind, instead of ADR 0268's roughly 2000 removed lines.
- Side-chat tabs do not survive an app restart; the child opens from the sidebar.
- A forked child exists after the first Send even if the provider rejects the
  prompt, as the first-send amendment already accepted.

## Alternatives considered

- **Restore the old renderer-owned side chat:** rejected; it brings back exactly
  the projection and reducer 0268 removed.
- **Fork and activate:** rejected; that is Open as a conversation.
- **A selection overlay entry:** rejected; the DOM recovery path is what made the
  overlay costly, and the action row needs none.
- **Persist side-chat tabs:** rejected; the durable child already survives, and a
  persisted tab would add a restore lifecycle for a transient panel.
