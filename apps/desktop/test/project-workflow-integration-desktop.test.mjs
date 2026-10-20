import assert from "node:assert/strict";
import { register } from "node:module";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";
const { emptyProjectWorkflowSnapshot } = shared;
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createWorkflowSessionFactory, createDesktopProjectWorkflow } = await import("../electron/main/services/project-workflow-desktop.ts");

function sessionsFixture() {
  const created = [], changed = [];
  let providerStyle = "openai_chat_completions";
  const source = { id: "source-1", title: "User title", projectPath: "/project/secondary", mode: "agent",
    providerId: "provider-1", modelId: "model-1", thinkingLevel: "medium" };
  const host = { async call(method, input) {
    if (method === "project.groups.list") return { groups: [{ id: "project-1", name: "User project", primaryPath: "/project/primary",
      roots: [{ path: "/project/primary" }, { path: "/project/secondary" }] }] };
    if (method === "session.get") return { session: source };
    if (method === "settings.get") return { defaultProviderId: "provider-1" };
    if (method === "providers.list") return { providers: [{ id: "provider-1", apiStyle: providerStyle, enabled: true }] };
    if (method === "session.create") { created.push(input); return { session: { ...input, id: "new-session" } }; }
    assert.fail(`Unexpected Host method ${method}`);
  } };
  const factory = createWorkflowSessionFactory({ getHost: () => host, onSessionsChanged: () => changed.push(true) });
  return { factory, created, changed, source, setConsumer: () => { providerStyle = "chatgpt_conversation"; } };
}

test("side session creation preserves group root, user title, provider and inherited permission source", async () => {
  const f = sessionsFixture();
  assert.equal(await f.factory.createSession({ projectId: "project-1", sourceSessionId: "source-1", purpose: "work" }), "new-session");
  assert.deepEqual(f.created[0], { title: "User title", mode: "agent", projectPath: "/project/secondary", providerId: "provider-1",
    modelId: "model-1", thinkingLevel: "medium", inheritPermissionFromSessionId: "source-1" });
  assert.equal(Object.hasOwn(f.created[0], "permissionMode"), false);
  f.setConsumer();
  await assert.rejects(f.factory.createSession({ projectId: "project-1", sourceSessionId: "source-1", purpose: "work" }), { errorCode: "INVALID_ARGUMENT" });
  assert.equal(f.created.length, 1, "unsupported execution must not create an orphan or switch provider");
  await f.factory.createSession({ projectId: "project-1", sourceSessionId: "source-1", purpose: "ask" });
  assert.equal(f.created[1].mode, "plan");
  assert.equal(f.created[1].providerId, "provider-1", "consumer Chat remains usable for discussion");
  f.source.projectPath = "/other-project";
  await assert.rejects(f.factory.createSession({ projectId: "project-1", sourceSessionId: "source-1", purpose: "explore" }), { errorCode: "INVALID_ARGUMENT" });
});

test("execution requires an explicit Agent-capable selected session", async () => {
  const f = sessionsFixture();
  f.source.mode = "plan";
  await assert.rejects(f.factory.assertExecutable(f.source.id), { errorCode: "INVALID_ARGUMENT" });
  f.source.mode = "agent"; f.setConsumer();
  await assert.rejects(f.factory.assertExecutable(f.source.id), { errorCode: "INVALID_ARGUMENT" });
});

test("workflow dispatch is disabled until reconciliation and legacy chat context remains unchanged", async () => {
  const state = emptyProjectWorkflowSnapshot();
  const workflow = createDesktopProjectWorkflow({ host: { snapshot: async () => state },
    getHost() { assert.fail("No project execution expected"); }, getAgentHost() { assert.fail("No runtime dispatch expected"); },
    flushTranscript: async () => true, onSessionsChanged() {} });
  const action = { kind: "pause", commandId: "pause-1", expectedRevision: 0, projectId: "project-1", workstreamId: "work-1" };
  await assert.rejects(workflow.runtime.action(action), { errorCode: "AGENT_UNAVAILABLE" });
  assert.equal(await workflow.contextForSession("ordinary-chat"), undefined);
  await workflow.initialize();
  assert.equal(await workflow.contextForSession("ordinary-chat"), undefined);
  await workflow.dispose();
  await assert.rejects(workflow.runtime.action(action), { errorCode: "AGENT_UNAVAILABLE" });
});

// This focused composition harness controls only the coordinator/execution
// boundary; runtime recovery itself is covered by integration-recovery.
function bufferedComposition(coordinator) {
  const file = new URL("../electron/main/services/project-workflow-desktop.ts", import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    if (id === "@pi-desktop/shared") return shared;
    if (id === "../runtime/project-workflow-execution") return { createProjectWorkflowExecution: () => ({}) };
    if (id === "../runtime/project-workflow-runtime") return { createProjectWorkflowRuntime: () => coordinator };
    throw new Error(`Unexpected import ${id}`);
  }, module.exports, module);
  return module.exports.createDesktopProjectWorkflow({ host: { snapshot: async () => emptyProjectWorkflowSnapshot() },
    getHost() { assert.fail("No session creation expected"); }, getAgentHost() { assert.fail("No execution admission expected"); },
    flushTranscript: async () => true, onSessionsChanged() {} });
}
const pauseIntent = { kind: "pause", commandId: "pause-buffered", expectedRevision: 0, projectId: "project-1", workstreamId: "work-1" };

test("terminal callbacks during recovery are deduplicated and drained before public actions become ready", async () => {
  let releaseRecovery, releaseSettlement, reachedSettlement;
  const recovery = new Promise((resolve) => { releaseRecovery = resolve; });
  const settlement = new Promise((resolve) => { releaseSettlement = resolve; });
  const reached = new Promise((resolve) => { reachedSettlement = resolve; });
  const handled = [], actions = [];
  const workflow = bufferedComposition({
    recoverAll: () => recovery,
    async onTurnSettled(sessionId) {
      handled.push(sessionId);
      if (sessionId === "fast-successor") { reachedSettlement(); await settlement; }
    },
    async action(input) { actions.push(input); return { snapshot: emptyProjectWorkflowSnapshot() }; },
  });
  const initialization = workflow.initialize();
  await workflow.onTurnSettled("fast-successor");
  await workflow.onTurnSettled("fast-successor");
  assert.deepEqual(handled, [], "settlement must not run or admit work during global recovery");
  await assert.rejects(workflow.runtime.action(pauseIntent), { errorCode: "AGENT_UNAVAILABLE" });
  releaseRecovery(); await reached;
  await workflow.onTurnSettled("next-fast-successor");
  await assert.rejects(workflow.runtime.action(pauseIntent), { errorCode: "AGENT_UNAVAILABLE" });
  releaseSettlement(); await initialization;
  assert.deepEqual(handled, ["fast-successor", "next-fast-successor"]);
  await workflow.runtime.action(pauseIntent);
  assert.equal(actions.length, 1);
  await workflow.onTurnSettled("ready-session");
  assert.deepEqual(handled, ["fast-successor", "next-fast-successor", "ready-session"]);
});

test("disposal discards buffered settlements and cannot be undone by pending initialization", async () => {
  let release;
  const recovery = new Promise((resolve) => { release = resolve; });
  const handled = [];
  const workflow = bufferedComposition({ recoverAll: () => recovery,
    async onTurnSettled(sessionId) { handled.push(sessionId); }, async dispose() {} });
  const initialization = workflow.initialize();
  await workflow.onTurnSettled("before-disposal");
  await workflow.dispose();
  await workflow.onTurnSettled("after-disposal");
  release(); await initialization;
  assert.deepEqual(handled, []);
  await assert.rejects(workflow.runtime.action(pauseIntent), { errorCode: "AGENT_UNAVAILABLE" });
});

test("a failed buffered settlement remains available to initialization retry", async () => {
  const handled = [];
  let fail = true;
  const workflow = bufferedComposition({ async recoverAll() {}, async onTurnSettled(sessionId) {
    handled.push(sessionId);
    if (fail) { fail = false; throw new Error("Synthetic settlement interruption"); }
  }, async action() { return { snapshot: emptyProjectWorkflowSnapshot() }; } });
  await workflow.onTurnSettled("retry-session");
  await assert.rejects(workflow.initialize(), /Synthetic settlement interruption/);
  await assert.rejects(workflow.runtime.action(pauseIntent), { errorCode: "AGENT_UNAVAILABLE" });
  await workflow.initialize();
  assert.deepEqual(handled, ["retry-session", "retry-session"]);
  await workflow.runtime.action(pauseIntent);
});
