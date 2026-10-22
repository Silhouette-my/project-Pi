# Project overview and structure views

## Decision

The overview projects the existing Host workflow: current goals and acceptance
counts, actual workstream states, blockers, proposed decisions, next actions and
recent openable artifacts. It never synthesizes project completion or a progress
percentage from execution completion. The canonical Agent discussion moved from
an overview composer to the right work panel (see the amendment below), which
reads the Agent session as a detached transcript (no active-session change);
drafts and Chat/Work continuation retain their current behavior. Outputs and evidence are shown in the
workstream detail; shared context remains a tab, leaving four tabs.

A separate Structure tab contains switchable Sessions, Git and Architecture
views rather than three canvases in the overview. Empty/error states describe
real data availability without example nodes or empty dashboard cards.

Session edges come only from conversation.parentSessionId. Workstream main
session and run associations are annotations/memberships, not invented parent
edges. Unrelated historical sessions remain discoverable separately. Existing
archive state and live execution are visible, and a selected node opens through
the original session navigation path. This read-side never changes conversation
context, tool permissions, project bindings, or execution admission.

Git is local and read-only: no fetch, checkout, reset or automatic write.
Architecture discovers project-local .archify outputs and opens JSON/HTML/source
through existing safe preview boundaries; HTML never enters the main renderer
DOM. No generation, model call, installation or personal skill path is required.

## Boundaries and consequences

The Host's registered project roots authorize every read. The shared
`ProjectStructureApi` is a read-side contract implemented by host-runtime and a
thin Electron adapter. A registered subdirectory does not grant access to its
parent Git repository. Git history is bounded to 200 commits and 500 refs;
working changes and selected-commit diffs reuse the established diff model.
Merge diffs are against the first parent; root commits use the empty tree.

Architecture discovery is bounded to `.archify` HTML and schema-version-1
diagram JSON, excluding known delivery/finalization receipts. JSON `meta.output`
associates metadata with a rendered HTML. Sources use `path`, `line` and
`end_line`; `meta.repository.revision` records generation provenance. Source
reads always return the current working file. A failed or truncated Git read
cannot establish a revision match; dirty source or a differing HEAD is stale.

HTML is initialized inside the existing host-owned `pi-visualize` iframe with
`sandbox="allow-scripts"`, no same-origin capability, and its existing CSP.
Project previews do not handle follow-up messages as execution commands.
Filesystem reads reject traversal, binary/oversized files and symlink escapes.
The installed Archify skill supplies a fixture format reference only; neither
the skill nor its generator is an application dependency.

## Amendment: the Agent moves from the project dock to the work panel (2026-10-22)

The console no longer renders its own right-edge dock. The project Agent and
project side conversations are tabs of the existing right work panel
(`components/workpanel/WorkPanel.tsx`), in a project-scoped context
(ADR auto-hide-side-panels amendment):

- `project-agent` (resource: projectId) renders the canonical Agent session
  through `DetachedConversation`; its first send still creates the session with
  `agent.open`. The tab root keeps `data-project-agent-dock` and its composer
  form keeps `data-workflow="project-intent"`.
- `project-side` (resource: side-conversation session id) shows the purpose, the
  read-only return policy label, the source workstream, an Explore "review
  proposals" link to the Shared context tab and "open as conversation", above a
  `DetachedConversation`. Creating a side conversation or choosing "Open beside"
  opens this tab through `openProjectPanelTab`.
- The Agent has no tools and stays discussion-only
  (ADR project-agent-discussion-boundary). Moving words between the Agent and
  conversation threads is done by the user in the Agent tab: **Send to
  conversation…** (target thread, latest answer or last 1/3/all exchanges, an
  editable preview, then Send with an attribution line, or insert into the
  target's composer draft) and **Bring in a conversation…** (a thread's latest
  answer as a quoted block in the Agent draft). Neither lets the Agent act.
- The console header's `data-project-agent-dock-toggle` button now reveals the
  Agent tab. The old per-project dock state and its CSS are removed.
