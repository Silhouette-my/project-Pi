# ADR turn-process-and-thinking-display: Turn process and thinking presentation

- Status: Accepted
- Date: 2026-09-17
- Amended: 2026-10-21
- Issues: #510, #461
- Amends: D071, [ADR 0242](0242-delta-only-streaming-updates.md)

## Context

A model can alternate reasoning, tool calls and progress text many times before
answering one user request. Separate activity groups leave those progress
messages at the same visual level as the answer, while one flat process
container still leaves long tool/search sequences difficult to scan. Some
readers also need a thinking indicator without rapidly changing reasoning text.

## Decision

One unified turn-process presentation applies to every loaded assistant-turn
entry: it projects the entry into one collapsible process disclosure plus its
trailing answer. Thinking, tools, intermediate assistant text and the turn's
`Bash` run rows keep their original order inside that disclosure. A trailing
assistant text stays visible
while streaming; if later tool or thinking activity follows, that text moves into
the process without changing the stored message. There is no semantic
final-answer marker in `UiMessage`, so the renderer does not guess intent from
wording. User/system messages and compaction dividers retain their existing turn
boundaries.

One turn renders exactly one process disclosure. Every row the turn produced
before its answer lives inside it — the activity groups and the `Bash` run rows
alike — so a long turn collapses in one gesture instead of leaving a column of
sibling disclosures above the answer. The answer itself stays outside it.

Inside that disclosure, non-Bash activity forms ordinary activity groups: one
contiguous tool/search/thinking segment between progress paragraphs or run rows,
appearing only when at least two items are visible under the current thinking
preference. A singleton uses its item disclosure directly; hidden thinking does
not create a redundant wrapper. Existing Task topology remains its segment's
container and is not duplicated inside an ordinary activity group.

Whether a run row sits *inside* its group or *beside* it is the
`keepCommandsExpanded` preference, which defaults to on. When on, `Bash` and run
aliases are lifted out of the groups they ran among: each becomes its own row at
the disclosure's top level, adjacent calls stay separate, and the row's detail
stays closed until the user opens it. When off, a run row keeps its place in the
flow, so a command reads as another line of the group around it — the layout
before commands were separated. The preference never changes how many
disclosures a turn renders: both values render exactly one.

Group folding defaults are unified and do not depend on either preference. The
ordinary activity group that owns the active execution segment starts open, then
closes on completion only while untouched. Other completed groups start closed.
An untouched active group containing any recorded failed or denied tool stays
open through later recovery and closes on turn completion if still untouched.

The turn's disclosure header states the turn's outcome and never echoes the item
it is working on, because a shell command or search query can be arbitrarily
long. It reads `failed`, `stopped`, `running`, or finished, in that precedence:
a recorded failure outranks a stop, because the turn produced no answer and a
normal-looking header hid that. A stop is read from an aborted message, the only
signal the runtime records — the turn result distinguishes completed from failed
only. Aborted activity rows also record a stop while a tool or reasoning step is
in flight; delegated child rows do not determine the parent turn's outcome.
While running, stages a reader can sit in front of (compaction, recovery)
name themselves; a live reasoning step reads `Thinking`, and momentary stages
read as plain running. Durations are dropped when the transcript recorded no
timing rather than shown as zero, and issue counts sit beside the label.

The disclosure and the levels it reveals share one left edge. Hierarchy is
carried by type size and colour, not by indentation, so a nested group header and
a run row start exactly where the turn header does.

The thinking preference is a boolean `showThinking`. When it is false, the live
thinking indicator stays visible, while completed thinking rows and excerpts are
hidden and empty thinking-only containers are omitted; the stored reasoning is
retained, so turning the preference back on restores the completed rows and
excerpts. Hidden thinking never creates an empty group wrapper.

The leaf default that an earlier decision first introduced was later removed.
Item payloads never open themselves: a tool-call, hosted-search or plan row
stays a header row until the user opens it, wherever it sits in the group, and
this holds regardless of the thinking preference. Group defaults are unchanged,
and opening a closed ancestor still exposes the retained item choices without
opening all descendants.

Each header toggles only its own level. Parent and child states are independent:
closing a parent preserves descendant choices, reopening restores them, and
sibling groups do not form an accordion. Manual interaction with an item claims
its containing group as user-owned without toggling it; completion must not close
a container around content the user opened, focused, or selected. Manual choices
survive streaming, completion, preference changes, reparenting from singleton to
group, and row remounts while the owning retained session pane remains alive.
Pane eviction, session deletion, or renderer restart releases this presentation
memory; it is not stored in messages or host settings.

Search/navigation reveals the ancestor path its target needs: the turn process
and the activity group that own the named message. Item-level targeting is not
part of this change, so each row's own details stay behind its own disclosure.
Replaying the same request does not repeatedly override a later manual close.
Reasoning hidden by the preference stays hidden until the user turns
`showThinking` on. Assistant errors, stopped trailing partial answers,
permission/question/plan/goal decisions, and any other pending action surface
remain outside hidden process content and reachable without expanding it.

Settings → AI → Defaults exposes a `Show thinking` boolean that persists as the
optional `showThinking` `AppSettings` field. Absent and non-boolean values fall
back to the legacy `thinkingDisplayMode` field: an explicit `compact` hides
reasoning while `detailed`, an unknown value, or an absent field shows it. The
legacy field is retained for persisted-settings compatibility and is no longer
exposed in the UI. The preference changes presentation only; it does not alter
provider thinking levels, runtime/model context, stored reasoning, export,
permissions, execution, or copy payloads, and it does not control turn-process
or activity-group folding. Process headers use recorded timing, direct tool/search
counts, running state, and issue counts; they do not double-count delegated child
work or treat a failed child as a failed assistant turn.

## Consequences

- One disclosure per turn keeps the final answer and actionable interruptions
  reachable, and makes a long turn collapsible in a single gesture.
- Group folding defaults are unified: active work stays visible, untouched
  completed groups fold by default, and explicit disclosure choices are preserved
  regardless of the thinking preference. Closing the turn's disclosure closes the
  groups under it, and reopening restores the groups the user had opened.
- When `showThinking` is false, the live indicator stays visible while completed
  reasoning rows and excerpts are hidden. The stored reasoning is retained and
  reappears when the preference is turned back on.
- With `keepCommandsExpanded` on (the default), run aliases render as their own
  rows so shell-heavy turns stay scannable; turning it off restores the older
  layout where a command reads as another line of its group. Neither value
  changes the number of disclosures, and because the preference is read while
  rendering rather than while building entries, toggling it repaints the
  transcript immediately instead of waiting for new messages.
- The header answers "how did this turn end up" in one short line. Echoing the
  current command was removed: it pushed the counts off the row and duplicated
  what opening the item already shows.
- Disclosure memory is pane-owned presentation state with stable turn, group,
  and item identities; it is neither a persisted transcript contract nor a
  central workflow-store concern.
- This groups loaded transcript entries only; it does not reconstruct unloaded
  history or join turns across compaction boundaries.

## Validation

For the 2026-09-20 amendment, the request explicitly limits validation to static
checks and compilation. The linked E2E scenarios describe intended behavior for
source and design review; no unit, component, integration, browser, Electron, or
E2E tests are added or run for this amendment. See
E2E-CHAT-turn-process-and-thinking-display for the synchronized scenario text.
For the 2026-09-27 amendment, `apps/desktop/test/turn-process.test.mjs` covers
the default selection, and `pnpm test:e2e:transcript-disclosure` exercises
active-to-completed collapse and user-open retention in real Chromium.
For the 2026-10-16 amendment, `apps/desktop/test/thinking-visibility.test.mjs`
covers the `showThinking`/legacy `thinkingDisplayMode` resolver precedence, and
the i18n catalog tests cover the new `settings.showThinking` copy. The UI,
resolver, and E2E scenarios are validated on the integration candidate; see
E2E-CHAT-turn-process-and-thinking-display for the synchronized scenario text.
For the 2026-10-21 amendment, `apps/desktop/test/turn-process.test.mjs` covers
one-disclosure segmentation, command-folding on and off, and header phase
precedence; `apps/desktop/test/transcript-style.test.mjs` covers the shared left
edge and the removed live item echo. The interactive transcript probes cover the
rendered disclosure count, command placement, and header labels. See
E2E-CHAT-turn-process-and-thinking-display for the synchronized scenario text.
