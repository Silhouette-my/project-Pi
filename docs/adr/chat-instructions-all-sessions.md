# ADR: Chat Instructions Apply to Every Conversation

- Status: Accepted for implementation
- Date: 2026-10-25
- Related: D671, `03-runtime/11-provider-model-system.md`, ADR `side-chats-on-detached-transcripts`

## Context

Chat instruction presets (`promptPreset`) shipped for ChatGPT conversation
models on local sessions only. Those sessions have no local tools, so the
preset replaces the whole agent system prompt. Users also want the same
discussion styles with every other provider, in side chats, in project side
conversations and in the project Agent, and want the choice to start neutral.

## Decision

Electron main resolves a session's preset for every launch and passes it to the
sidecar as `chatInstructions` (encoding unchanged: `undefined`, `""`, content).
`chatgpt_conversation` providers keep replacing the agent prompt. Every other
provider keeps the agent prompt and appends a non-empty instruction as a last
`chatInstruction` section, so tools, project instructions and memory still
apply; `undefined` and `""` append nothing. The existing reuse comparison
already retires a runtime when the value changes.

`session.create` stores `none` as the new-session default. Sessions stored
before the change keep NULL: built-in persona on ChatGPT, no instruction
elsewhere. `session.fork` still copies the source value (branches inherit); a
chat side chat resets to `none` on first send unless the user chose a preset.
Detached composers bind the same picker to their session, or hold the pick as
pending configuration before the session exists and apply it on creation.

Remote-host sessions cannot take an instruction: RACP `session/configure`
carries none and the turn runs on the other machine. Imported pi-native
sessions are read-only. The picker stays visible but disabled with the reason
as a tooltip. No protocol field is added; extending RACP is a separate decision.

## Consequences

- ChatGPT conversations created after this change start with no system prompt
  until a preset is chosen (previously the built-in persona).
- Appended persona text follows the agent prompt, so it can only add style;
  tool and safety rules stay authoritative.
- Older hosts that lack the `none` default simply leave new sessions NULL,
  which behaves like None for non-ChatGPT providers.
