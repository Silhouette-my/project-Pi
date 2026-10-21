# ADR: ChatGPT conversation browser transport

- Status: Accepted for the requested ChatGPT Chat implementation
- Date: 2026-10-19

## Context

ChatGPT subscription chat is a separate transport from Codex Responses. Its
conversation endpoint requires a signed-in browser session. The desktop
renderer must not receive browser credentials or execute the agent loop.

## Decision

Keep the provider adapter in agent-runtime and the browser view in Electron
Main. Use the existing sidecar host RPC and notification transport for
`chatgpt.conversation.open/cancel` and `chunk/end/error` notifications. Main
creates a sandboxed view with a dedicated persistent partition and exposes
only a constrained stream bridge, validated against its webContents, main
frame, and ChatGPT origin. The unattached transport view uses offscreen
rendering, nonzero bounds and no background throttling. A temporary native
login window uses a separate interactive view in the same partition;
conversation rendering continues in the ordinary React transcript.

Native Electron tests showed that a fresh ordinary unattached view can fetch
session data while its authorization iframe animation frames remain stalled.
Disabling background throttling alone does not initialize that rendering path.
Offscreen rendering lets the iframe progress without showing or retaining a
host window, including after a process restart with a persisted login. Closing
login destroys its interactive view; later operations recreate the offscreen
view and validate the shared session without transferring credentials.

The initial static-model assumption was replaced after user acceptance:
authentication is validated using the consumer session JSON, and the consumer
model catalog supplies account-specific slugs, names and default effort.
All session authorization remains in the page. No Codex OAuth account or
Codex model endpoint participates in this transport. Authentication diagnostics
project only status/content-type/reason fields; login polling has deadlines
and observable failure states instead of swallowing errors indefinitely.

## Alternatives

- Direct Node requests do not carry the browser login context required by the
  endpoint.
- An embedded chat website would replace the requested native transcript.
- Moving provider execution into the renderer would violate the process model.

## Consequences

The partition is shared by ChatGPT Chat provider rows, while conversation
continuity remains session/provider scoped. Logging out affects all such rows.
Page processes and active streams are cancelled on runtime exit and shutdown.
Browser memory cost and upstream protocol drift remain operational costs.
Real login, connector availability, and subscription accounting require manual
account-side acceptance; fixture tests establish local behavior only.
