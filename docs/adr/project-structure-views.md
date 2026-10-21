# Project overview and structure views

## Decision

The overview projects the existing Host workflow: current goals and acceptance
counts, actual workstream states, blockers, proposed decisions, next actions and
recent openable artifacts. It never synthesizes project completion or a progress
percentage from execution completion. The canonical Agent discussion moved from
an overview composer to a right-edge project dock that reads the Agent session as
a detached transcript (no active-session change); drafts and Chat/Work
continuation retain their current behavior. Outputs and evidence are shown in the
workstream detail and shared context in a header sheet, leaving three tabs.

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
