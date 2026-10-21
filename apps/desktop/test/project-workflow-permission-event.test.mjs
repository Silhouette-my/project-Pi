import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createHostRuntime } = await import("../electron/main/runtime/host.ts");

function setup() {
  let notify;
  const events = [];
  const host = { onNotification(callback) { notify = callback; }, onExit() {} };
  const runtimeState = { host };
  createHostRuntime({
    runtimeState, activeToolCalls: new Map(), sessionProjects: new Map(),
    activeToolCallKey: (session, tool) => `${session}:${tool}`,
    logger: { app() {} }, emitAgentEvent: event => events.push(event),
  }).wireHost(host);
  return { notify: (...args) => notify(...args), events, runtimeState };
}

const request = {
  requestId: "approval-one", sessionId: "workflow-session", toolCallId: "shell-one",
  toolName: "Bash", argsPreview: { command: "printf 'checked' > result.txt" },
  risk: "high", reason: "Approve this workflow command separately",
};

test("real Host notification bridge retains the workflow Shell one-use boundary and exact command", () => {
  const f = setup();
  const command = `printf '%s' '${"reviewable-command-".repeat(200)}'`;
  f.notify("permissions.request", { ...request, argsPreview: { command }, approvalScope: "workflow-shell" });
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].event.type, "tool_permission_request");
  assert.equal(f.events[0].event.request.approvalScope, "workflow-shell");
  assert.equal(f.events[0].event.request.argsPreview.command, command);
});

test("ordinary permission requests retain their existing approval choices", () => {
  const f = setup();
  f.notify("permissions.request", request);
  assert.deepEqual(f.events[0].event.request, request);
});

test("a replaced Host cannot deliver a stale permission card", () => {
  const f = setup();
  f.runtimeState.host = null;
  f.notify("permissions.request", { ...request, approvalScope: "workflow-shell" });
  assert.equal(f.events.length, 0);
});
