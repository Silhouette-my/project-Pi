# Session-backed Workflow tasks

## Decision

New task creation explicitly writes `executionMode: "session"` on the Workstream.
The Run freezes the same marker. An absent marker always means the existing
bounded workflow contract; updates cannot change that interpretation.

A session-backed Run uses the existing AgentHost `startTurn` path without
`workflowRunId` or a workflow `permissionCeiling`. Its selected Agent session
retains its model, permission mode, tools, plugins and delegation configuration.
The project remains its normal working location, not an additional sandbox.
The Host does not create a bounded resource scope or turn binding for this Run.
Ordinary Host permissions and plugin permissions remain effective.

The Run has no workflow authorization ID. Bounded Runs still require a current
authorization and retain their exact-command Shell approval and resource checks.
Host rejects a mode mismatch or a session Run carrying a bounded authorization.
The marker is an additive version-1 record field; historical records are not
rewritten and existing acceptance, authorization and checkpoint data remain intact.
No SQLite table or aggregate layout changes: the version-1 aggregate already
stores additive optional record fields. Older binaries cannot admit an ordinary
session Run through the old closed Run schema; they still require bounded
authorization and checkpoints, so downgrading does not silently broaden tools.
New producers persist a fresh UUID as `userMessageId` in the initial dispatch
receipt before admission. Start, queue restoration and observation reuse this
identity, which the ordinary prompt adapter preserves. Legacy queued-input
inference cannot restore it as a bounded Workflow turn.

## Completion and recovery

Session tasks accept an ordinary final reply. No structured checkpoint, Candidate
or Evidence record is required. A completed Agent turn with known effects may
complete its main task; optional acceptance items retain their own state. This
means execution ended, not that tests passed or the user accepted the result.
Host requires the current main Run's terminal receipt before this transition.

Failures, cancellation, interruption and unknown effects do not become successful
completion. An ordinary nonzero Shell exit is a known command result and can be
diagnosed and repaired within the same Agent turn. A command without a trusted
exit receipt retains uncertain effects and cannot be replayed automatically.

Session task pause interrupts the actual ordinary turn, including pending work;
resume is an explicit user action with retained transcript/receipts. Recovery only
observes existing session Runs. It never derives a successor from natural-language
prose, a delivery event or startup. Legacy bounded checkpoint continuation remains
unchanged. Results and side conversations keep the existing durable delivery
records; a stale decision result cannot complete current work.
With a side conversation's delivery return policy, its natural-language result
is durably appended to the main conversation and existing discussions. The
session-mode delivery records integration into that context, not test success or
user acceptance. If return integration has not finished or the main conversation
was not yet linked, explicit Start also offers current-decision pending results
whose source conversation has delivery return policy. Their IDs stay in the Run's
dispatch receipt; a completed main turn consumes them once. Queue admission alone
does not consume a result. Private (`none`) returns are not offered or broadcast
to discussions. Delivery alone never launches another model request.

## Rejected alternatives

Removing only the runtime tool whitelist would leave Host resource bindings and
Shell approvals active. Removing all workflow bindings would silently widen old
tasks. A new free-mode toggle, a second scheduler, Docker/VM dependencies, a
delivery-review center and automatic Evidence generation are outside this change.
