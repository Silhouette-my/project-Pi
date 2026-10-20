import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { emptyProjectWorkflowSnapshot } from "@pi-desktop/shared";
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
