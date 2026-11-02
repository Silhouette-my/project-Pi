# ADR: Isolated visualization frame documents

- Status: Accepted for implementation
- Date: 2026-10-21

## Context

The transcript visualization host initially used a Blob document. Packaged
Electron evidence showed that its CSP inherits the main renderer policy, so
the frame's own CDN allowlist could not enable its documented libraries.
Adding CDN origins to the main renderer would trust those scripts in the
application itself, rather than only in the isolated visualization.

The plugin renderer protocol serves permission-scoped plugin modules, not
untrusted HTML. The plugin panel host owns separate windows and partitions;
neither is a suitable replacement for an inline transcript frame.

## Decision

Serve one fixed, read-only bootstrap document at
`pi-visualize://frame/index.html`. The protocol accepts only GET for that exact
URL. It receives no file path, fragment or privileged command. The protocol is
reserved alongside the existing host schemes before Electron is ready; it has
standard and secure URL semantics, not CSP bypass or a fetch capability.

The response header locks the existing five-CDN script/style allowlist,
font-file allowlist, data/Blob images and `connect-src 'none'`. Forms, base URLs
and nested frames are refused. This policy remains enforced when the bootstrap
writes the final document. The parent allows this scheme only in `frame-src`;
its own script and network trust do not grow.

The renderer reads fragments through the existing contained `fsRead` path and
builds the existing design/runtime document. Once the frame loads, its true
parent sends that document over postMessage. The bootstrap verifies
`event.source === window.parent` and the envelope, removes its listener before
writing, and accepts initialization once. Further load messages cannot rewrite
the document. Live theme and widget-state behavior uses the existing bridge.

Every frame remains `sandbox="allow-scripts"`, without `allow-same-origin`,
Node integration, a preload bridge, storage privileges or new filesystem IPC.
Follow-up and external-link requests remain proposals requiring explicit host
confirmation.

## Consequences

The documented CDN resources can run inside the frame while the application
continues to reject the same CDN scripts. The endpoint is a small built-in
document host, not a general plugin server or arbitrary-file URL resolver.
It introduces one private protocol without changing persisted data or public
plugin contracts.

Unit tests cover exact endpoint matching, response CSP, one-shot parent
initialization, sandboxing and trusted action handling. Acceptance additionally
requires the packaged Electron candidate to load an allowed CDN script fulfilled
locally by CDP, reject an unlisted origin, deny parent access and preserve the
main renderer's refusal of CDN scripts. Static policy strings alone are not
acceptance evidence.
