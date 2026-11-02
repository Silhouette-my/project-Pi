# ADR: Preserve visualization contracts while integrating GenUI

- Status: Accepted
- Date: 2026-11-02
- Related: [GenUI](gen-ui-inline-visualization.md),
  [isolated legacy frame documents](isolated-visualize-frame-document.md)

## Context

The fork already generates and renders `visualize` fences whose JSON payload
names a contained HTML fragment. Its sandbox supports session-memory widget
state and follow-up/link proposals confirmed by a button in the host UI.
Existing transcripts and remote-host sessions use this contract.

Upstream 0.21.0 adds local, file-backed GenUI references (`::visualize{...}`),
bundled offline chart libraries, session-owned fragment storage and an opt-in
`inlineVisualizations` switch. Replacing the fork's skill or disabling its
shared `pi-desktop/visualize` id while that switch is off would remove an
existing entry point.

## Decision

Keep one `pi-desktop/visualize` skill per session. Enabled local GenUI sessions
receive the upstream `visualize.md` document; all other sessions receive the
fork's `visualize-legacy.md` document. Catalogs and on-demand loads use the same
session selection. User-disabled skill ids still override either selection.
The GenUI switch changes the local generation contract, not the activation of
the legacy feature. Existing defaults stay unchanged.

The assistant bubble first splits GenUI references, then renders the remaining
Markdown with its original message identity. Historical legacy fences remain
cards regardless of the GenUI switch, while GenUI references retain the
upstream switch, owner-session containment and remote-unavailable behavior.

Register both isolated schemes in Electron's single privileged-scheme call.
The main window permits them only in `frame-src`; neither scheme adds script
or network trust to the application. The legacy fixed bootstrap, opaque-origin
sandbox, widget state and host-confirmed actions remain intact. GenUI keeps its
independent network-free document policy and does not expose the legacy host
bridge.

## Consequences and verification

Two persisted reference formats remain readable without rewriting transcripts.
Only the selected format is taught to a session. Legacy CDN-backed fragments
retain their existing network behavior; GenUI fragments use bundled libraries.

Skill-selection tests cover the local/remote and enabled/disabled combinations
through the composer catalog and document loader. Transcript rendering tests
cover a reply containing both reference formats. Existing protocol, containment,
opaque-origin and host-action tests remain applicable. Electron acceptance
must exercise the two frame schemes in the integrated candidate with isolated
data, not a user's running application.
