import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");

function setup({ refuse = false } = {}) {
  const handlers = new Map(), calls = [], sidecarCalls = [];
  const host = { async call(method, params) {
    calls.push({ method, params });
    if (method === "settings.get") return {};
    if (method === "session.get") return { session: { id: "session-1", messages: [] } };
    if (method === "session.beginTurn") {
      if (refuse) throw Object.assign(new Error("Workflow run belongs to another session"), { errorCode: "UNAUTHORIZED" });
      return { turnId: "durable-turn" };
    }
    if (method === "session.appendMessage") return {};
    assert.fail(`Unexpected RPC ${method}`);
  } };
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host, getSidecar: () => ({ setProjectInstructionRoot() {},
      async call(method, params) { sidecarCalls.push({ method, params }); return { accepted: true, turnId: "durable-turn" }; } }),
    getAgentHostBridge: () => null, logger: { app() {} }, vendorOAuth: {}, agentExtensions: {}, cancelSessionTools() {},
    persistenceOutbox: {}, dataDir: "/unused-no-attachments", activeTurns: new Map(), activeTurnUsages: new Map(),
    approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(), recordTurnStart() {},
    resolveAgentRuntimeLaunch: async () => ({ providerId: "provider", modelId: "model",
      sidecarParams: { sessionId: "session-1", provider: { modelConfig: { input: ["text"] } } } }),
    acquireSessionOperation: async () => () => {}, finishTurn: async () => assert.fail("No failed admitted turn expected"),
    emitAgentEvent() {}, setNotificationViewingSessionId() {}, optionalWorkspaceRoot: async () => null,
    composerCommandService: { buildComposerCommands: async () => [] }, loadComposerTemplatesCached: async () => [],
  });
  return { calls, sidecarCalls, prompt: (fields) => handlers.get(IPC.invoke.agentPrompt)({ sessionId: "session-1", content: "Bounded work", ...fields }) };
}

test("validated workflow turn retains its run message identity through real prompt IPC and sidecar dispatch", async () => {
  const f = setup();
  await f.prompt({ workflowRunId: "workflow:step-1", messageId: "4a6392af-a2d2-4e05-a7d4-a80fdaaf081e" });
  const begin = f.calls.find(c => c.method === "session.beginTurn");
  assert.equal(begin.params.workflowRunId, "workflow:step-1");
  const append = f.calls.find(c => c.method === "session.appendMessage");
  assert.ok(f.calls.indexOf(begin) < f.calls.indexOf(append));
  assert.equal(append.params.message.id, "workflow-run:workflow:step-1");
  assert.equal(append.params.turnId, "durable-turn");
  assert.equal(f.sidecarCalls[0].params.workflowRunId, "workflow:step-1");
  assert.equal(f.sidecarCalls[0].params.userMessageId, append.params.message.id);
  assert.equal(f.sidecarCalls[0].params.turnId, "durable-turn");
});

test("rejected Host binding cannot persist a workflow message or invoke the sidecar", async () => {
  const f = setup({ refuse: true });
  await assert.rejects(f.prompt({ workflowRunId: "foreign-run" }), { errorCode: "UNAUTHORIZED" });
  assert.equal(f.calls.some(c => c.method === "session.appendMessage"), false);
  assert.equal(f.sidecarCalls.length, 0);
});

test("ordinary chat keeps UUID identity and cannot forge workflow identity without a Host binding", async () => {
  const uuid = "4a6392af-a2d2-4e05-a7d4-a80fdaaf081e";
  for (const messageId of [uuid, "workflow-run:forged"]) {
    const f = setup(); await f.prompt({ messageId });
    assert.equal(f.calls.find(c => c.method === "session.beginTurn").params.workflowRunId, undefined);
    const actual = f.calls.find(c => c.method === "session.appendMessage").params.message.id;
    if (messageId === uuid) assert.equal(actual, uuid);
    else { assert.notEqual(actual, messageId); assert.match(actual, /^[a-f0-9-]{36}$/); }
  }
});

test("native continuation cannot silently discard a requested workflow binding", async () => {
  const f = setup();
  await assert.rejects(f.prompt({ sessionId: "native-pi:session-1", workflowRunId: "workflow:step-1" }), { errorCode: "INVALID_ARGUMENT" });
  assert.equal(f.calls.length, 0);
  assert.equal(f.sidecarCalls.length, 0);
});
