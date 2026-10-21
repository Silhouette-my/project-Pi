# Local main consolidation — 2026-10-20

## Integrated sources

The integration candidate is `d84b8d19c`. It contains:

| Source | Retained revision or snapshot |
| --- | --- |
| Current upstream main | `de57f05aa` |
| Workflow baseline and dispatch contracts | `57d386a52` |
| Runtime delivery | `d76e9cd6a` |
| Renderer delivery | `a1e76193f` |
| Host and integrated MVP | `95cc57d0a` |
| Later Project Agent / console changes | `07cd628fa` |
| Later Chat instructions and transport changes | `e27557b8c` |

The baseline, runtime, and renderer tips were already ancestors of the Host
delivery. They were not independently reapplied. Later uncommitted Host and
Chat source was captured without changing its original worktrees. The original
user-provided Chat specification is now tracked.

## Integration repairs

- Folder contents remain visible when their chats enter Favorites or Recent.
  Those sections are views, not alternative ownership locations.
- Schema 27 accepts schema 24, the Chat-only schema 25, workflow schema 25,
  and workflow schema 26. Synthetic migration tests preserve actual session,
  preset, and queued-message records through upgrade and repeated opening.
- Chat preset selection retains its omitted/null/string configuration semantics,
  draft-first-send behavior, and fork persistence.
- Chat receives Host-selected project/workflow reference data independently of
  its persona preset. `none` still sends no system persona. Reference injection
  does not alter the transcript or user-message count; changed context retires
  the old runtime/continuation.
- Project discussion remains tool-free at the Host and runtime boundaries.
- Chat thinking choices map to the service's supported levels; unsupported
  choices fail explicitly.
- Current upstream title localization and path-boundary fixes were retained
  rather than overwritten by older copies in the Chat checkout.
- The workflow UI acceptance runner resolves its Electron environment instead
  of hardcoding a historical worktree. Explicit binary overrides remain
  available for this machine's existing Electron installation.

## Evidence

The source owners ran targeted Chat draft/preset/transport/runtime tests,
database and workflow tests, TypeScript checks, and a synthetic two-process
Electron lifecycle test. An independent read-only review identified the lost
Chat workflow context; the repaired implementation and request-construction
tests passed re-review.

The pre-Chat candidate `6e7bd9e7c` passed a real Electron/Main/Host/runtime
journey with isolated HOME, database, and profile, using a loopback model:
`/tmp/pi-main-consolidation-ui-20261020/result.json`.
It exercised project discussion, restart continuity, empty tool catalogs,
work-item creation, scoped search, revision-specific feedback, context links,
folder operations, and stable folder visibility after opening/favoriting.
Actual light/dark renderer captures were inspected.

After combining Chat and workflow, candidate `d84b8d19c` passed the same
production journey:
`/tmp/pi-main-consolidation-final-ui-20261020/result.json`.
Its final renderer capture was inspected. Workspace builds, shared/runtime/
i18n/desktop type checks, the Electron build, and the Rust Host build passed
on this candidate. Rechecked Chat workflow/instructions tests passed (26),
draft/preset/composer tests passed (12), and the v24 migration test passed (1).
The more extensive migration-history and queue-preservation tests were already
run on the unchanged Chat integration commit.

Historical work-execution acceptance remains in
`project-workflow-coordination/notes/A/LOCAL_ACCEPTANCE.md` outside the
repository. It covers the earlier integrated execution candidate and is
distinct from the discussion/navigation journey.

No remote push or installed-application replacement is part of this
consolidation. Real-account Chat evaluation belongs to its original
conversation; the integration checks use synthetic providers.

## Local recovery and cleanup

Source manifests and binary patches are retained under
`/Users/michaeltan/Desktop/Programming/Pi/work/main-consolidation/`.
The main checkout's original untracked specification is retained in this
history; cleanup preserves an additional copy beside the source manifests.

Retiring a local branch does not authorize deleting its worktree's login data,
application caches, screenshots, or other retained evidence. Historical
worktrees remain detached at their recorded commits.

### Final Chat handoff

The user authorized pausing the original Chat task. Its owner confirmed that
source edits, child-agent writes, restarts, and new test requests have stopped.
There were no application/runtime source changes after the last captured
transport refresh. Direct comparison found no unexpected source differences
from main.

The subsequent blind-review deliverable is retained unchanged at
`examples/chat-ab-round1.html`. Its supporting results, generation scripts,
and private answer key remain in the original worktree's ignored
`.pi-desktop-test/prompt-ab-round1/` directory. The answer key is not committed
or disclosed.

The owner reported four complete real Chat responses from the original
worktree, using `gpt-6-thinking` with UI `high` mapped to outbound `extended`.
These do not validate main's later workflow-context integration. The HTML's
script syntax and export-selection synchronization were checked by its owner;
browser visual inspection and export/reopen validation remain unperformed.
User preference evaluation is still pending in the original conversation.

The original App remains running from the Chat worktree. Branch retirement
preserves that directory, its build outputs, database, and login paths.
No application restart or profile migration is needed for this cleanup.
