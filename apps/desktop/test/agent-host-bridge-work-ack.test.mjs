import assert from "node:assert/strict";
import test from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { IPC } from "@pi-desktop/shared";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));

test("AgentHost work controls require explicit structured acknowledgements", async (t) => {
  const server = await createServer({
    root: dirname(here),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { createAgentHostBridge } = await server.ssrLoadModule("/electron/main/agent-host-bridge.ts");
  let response;
  const bridge = createAgentHostBridge({
    channels: IPC.invoke,
    getHost: () => null,
    log: () => undefined,
    async invoke() { return response; },
  });

  const steer = { sessionId: "session-a", expectedTurnId: "turn-1", content: "Add a check", userMessageId: "message-1", voiceOrigin: { callId: "call-1", operationId: "op-1" } };
  response = undefined;
  assert.equal(await bridge.steerWorkSession(steer), false);
  response = {};
  assert.equal(await bridge.steerWorkSession(steer), false);
  response = { accepted: false };
  assert.equal(await bridge.steerWorkSession(steer), false);
  response = { accepted: true };
  assert.equal(await bridge.steerWorkSession(steer), true);

  response = undefined;
  assert.deepEqual(await bridge.stopWorkSession({ sessionId: "session-a", expectedTurnId: "turn-1", urgency: "graceful" }), { status: "stale-target" });
  response = {};
  assert.deepEqual(await bridge.stopWorkSession({ sessionId: "session-a", expectedTurnId: "turn-1", urgency: "graceful" }), { status: "stale-target" });
  response = { requested: true };
  assert.deepEqual(await bridge.stopWorkSession({ sessionId: "session-a", expectedTurnId: "turn-1", urgency: "graceful" }), { status: "requested" });

  response = {};
  assert.deepEqual(await bridge.stopWorkSession({ sessionId: "session-a", expectedTurnId: "turn-1", urgency: "immediate" }), { status: "stale-target" });
  response = { aborted: true };
  assert.deepEqual(await bridge.stopWorkSession({ sessionId: "session-a", expectedTurnId: "turn-1", urgency: "immediate" }), { status: "requested" });
});

test("Session Workflow identity survives ordinary bridge queue restoration and prompt persistence", async (t) => {
  const server = await createServer({ root: dirname(here), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] } });
  t.after(() => server.close());
  const { createAgentHostBridge, DESKTOP_PRINCIPAL } = await server.ssrLoadModule("/electron/main/agent-host-bridge.ts");
  const { createProjectWorkflowExecution } = await server.ssrLoadModule("/electron/main/runtime/project-workflow-execution.ts");
  const { durableUserMessageId } = await server.ssrLoadModule("/electron/main/prompt-attachments.ts");
  const messages = [], queued = new Map(), prompts = [];
  const sessionId = "session-workflow";
  const host = { async call(method, params) {
    if (method === "session.get") return { session: { id: sessionId, mode: "agent", permissionMode: "auto", messages } };
    if (method === "session.queueList") return { entries: [...queued.values()] };
    if (method === "session.queuePush") { queued.set(params.id, { ...params, position: queued.size, createdAt: new Date().toISOString() }); return {}; }
    if (method === "session.queueRemove") return { removed: queued.delete(params.id) };
    throw new Error(`Unexpected RPC ${method}`);
  } };
  let promoted;
  const promotion = new Promise((resolve) => { promoted = resolve; });
  const makeBridge = () => createAgentHostBridge({ channels: IPC.invoke, getHost: () => host, log() {},
    async invoke(channel, [request]) {
      assert.equal(channel, IPC.invoke.agentPrompt);
      prompts.push(request);
      // The real agentPrompt persistence policy: renderer-shaped IDs only for
      // ordinary turns, never special Workflow-shaped identifiers.
      const id = durableUserMessageId(request.messageId, messages);
      messages.push({ id, role: "user", content: request.content, status: "complete", createdAt: new Date().toISOString() });
      if (prompts.length === 2) promoted();
      return { turnId: `runtime-${prompts.length}` };
    } });
  let bridge = makeBridge();
  const active = await bridge.agentHost.startTurn(DESKTOP_PRINCIPAL, { sessionId, input: { text: "earlier ordinary turn", userMessageId: randomUUID() }, context: { requestId: "earlier" } });
  const userMessageId = randomUUID();
  const run = { id: "workflow:session-regression", sessionId, executionMode: "session", state: "queued",
    effects: [{ id: "dispatch", action: "agent", resource: `session:${sessionId}`, state: "planned",
      detail: JSON.stringify({ step: { action: "agent", resources: [], prompt: "assignment" }, deliveryIds: [], userMessageId }) }] };
  const execution = createProjectWorkflowExecution({ getAgentHost: () => bridge.agentHost, getHost: () => host,
    flushTranscript: async () => true, assertExecutableSession: async () => {}, createSession: async () => sessionId });
  const admitted = await execution.start({ run, content: "assignment" });
  assert.equal(admitted.queued, true);
  assert.equal([...queued.values()][0].userMessageId, userMessageId);
  assert.equal([...queued.values()][0].workflowRunId, undefined);
  run.effects[0].state = "confirmed";
  run.effects[0].detail = JSON.stringify({ ...JSON.parse(run.effects[0].detail), turnId: admitted.turnId });
  // Process restart uses the actual Host queue adapter, without the old
  // AgentHost's in-memory turns or Workflow identity guesses.
  bridge = makeBridge();
  await bridge.agentHost.start();
  assert.equal(bridge.agentHost.queue.list(sessionId)[0].userMessageId, userMessageId);
  assert.equal(bridge.agentHost.queue.list(sessionId)[0].workflowRunId, undefined);
  bridge.agentHost.queue.resume(sessionId);
  bridge.agentHost.kick(sessionId);
  await promotion;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prompts[1].messageId, userMessageId);
  assert.equal(prompts[1].workflowRunId, undefined);
  assert.equal(messages[1].id, userMessageId);
  messages.push({ id: randomUUID(), role: "assistant", content: "Natural final reply", status: "complete", createdAt: new Date().toISOString() });
  bridge.agentHost.endTurn(sessionId, admitted.turnId, "completed");
  assert.equal((await execution.observe(run)).state, "completed");
  assert.equal((await execution.observe(run)).content, "Natural final reply");
  assert.ok(active.turn.id);
});
