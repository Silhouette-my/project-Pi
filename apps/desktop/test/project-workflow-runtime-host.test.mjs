import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";
import { AgentHost } from "@pi-desktop/agent-host";
import { createHostSessionPort } from "@pi-desktop/host-runtime";
import { Host } from "../../../scripts/e2e/host.mjs";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createProjectWorkflowHostPort } = await import("../electron/main/services/project-workflow-host.ts");
const { createProjectWorkflowRuntime } = await import("../electron/main/runtime/project-workflow-runtime.ts");
const { createProjectWorkflowExecution } = await import("../electron/main/runtime/project-workflow-execution.ts");
const binary = process.env.PI_DESKTOP_HOST_BIN || resolve("target/debug/pi-desktop-host-core");

test("Real Host validates continuation receipts, exact scope, actual consumption and restart state", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "project-workflow-runtime-"));
  const home = join(root, "home"), project = join(root, "project");
  await mkdir(home); await mkdir(project);
  const host = new Host(binary, join(root, "data"), { env: { HOME: home }, quiet: true });
  const port = createProjectWorkflowHostPort(() => host, () => {});
  const prompts = [];
  let sequence = 0;
  const agentHost = new AgentHost({ sessions: createHostSessionPort(() => host),
    runtime: {
      async prompt(request) {
        prompts.push(request);
        await host.call("session.appendMessage", { sessionId: request.sessionId, message: { id: request.userMessageId,
          role: "user", content: request.content, status: "complete", createdAt: new Date().toISOString() } });
        return { turnId: `synthetic-model-edge-${++sequence}` };
      },
      async stop() { return { requested: true }; }, async abort() {}, async respondInput() {},
    }, approvals: { listPending: async () => [], resolveTool: async () => {}, resolveContract: async () => {} },
  });
  const execution = createProjectWorkflowExecution({ getAgentHost: () => agentHost, getHost: () => host, flushTranscript: async () => true,
    async createSession() { return (await host.call("session.create", { title: "Workflow", mode: "agent", projectPath: project })).session.id; },
  });
  const runtime = createProjectWorkflowRuntime({ host: port, execution });
  let projectId, sessionId;
  const mutate = async (kind, fields) => port.mutate({ kind, commandId: `setup-${++sequence}`, expectedRevision: (await port.snapshot()).revision, ...fields });
  const action = async (kind, fields = {}) => runtime.action({ kind, commandId: `intent-${++sequence}`, expectedRevision: (await port.snapshot()).revision, projectId, workstreamId: "work-1", ...fields });
  const report = (summary, next, consumedDeliveryIds = []) => "```project-workflow-checkpoint\n" + JSON.stringify({ summary, next, stop: false, artifacts: [], evidence: [], consumedDeliveryIds }) + "\n```";
  async function finish(content) {
    const turn = (await agentHost.workSnapshot(sessionId)).activeTurnId;
    await host.call("session.appendMessage", { sessionId, message: { id: `reply-${++sequence}`, role: "assistant", content, status: "complete", createdAt: new Date().toISOString() } });
    agentHost.endTurn(sessionId, turn, "completed");
    await runtime.onTurnSettled(sessionId);
  }
  try {
    await host.start();
    projectId = (await host.call("project.group.create", { name: "Runtime integration", folders: [project] })).group.id;
    sessionId = (await host.call("session.create", { title: "Main", mode: "agent", projectPath: project })).session.id;
    const stamp = new Date().toISOString();
    await mutate("workstream.create", { workstream: { id: "work-1", projectId, title: "Local continuation", goal: "Produce, check and consume a result", acceptance: [{ id: "ac-1", title: "Useful candidate", status: "pending", evidenceIds: [] }],
      owner: { kind: "session", ref: sessionId }, status: "ready", priority: 0, order: 0, dependencyIds: [], nextAction: "Implement bounded local change", revision: 0, decisionRevision: 0, createdAt: stamp, updatedAt: stamp } });
    await mutate("authorization.grant", { authorization: { id: "auth-1", projectId, workstreamId: "work-1", actions: ["implement", "check"], resources: [project], source: { kind: "user", ref: "explicit-local-authorization" }, permissionCeiling: "ask", maxRuns: 8, stopConditions: [], revoked: false } });
    await action("start", { authorizationId: "auth-1", sessionId });
    assert.equal(prompts.length, 1);
    await finish(report("Implementation produced", { action: "check", resources: [project], prompt: "Check the change" }));
    assert.equal(prompts.length, 2);
    await action("pause");
    await finish(report("Paused at a safe checkpoint", { action: "implement", resources: [project], prompt: "Fix the observed failure" }));
    assert.equal(prompts.length, 2);
    await action("resume");
    assert.equal(prompts.length, 3);
    await finish(report("Fix complete; acceptance review needed"));
    let state = await port.snapshot();
    assert.equal(state.workstreams[0].status, "awaiting_user");
    assert.equal(state.runs.length, 3);
    assert.ok(state.runs.every((run) => run.completionKey && run.state === "completed"));
    assert.equal(state.deliveries.filter((delivery) => delivery.state === "consumed").length, 3);
    await host.stop(); await host.start();
    state = await port.snapshot();
    assert.equal(state.runs.length, 3);
    assert.equal(state.workstreams[0].acceptance[0].status, "pending");
    assert.equal(prompts.length, 3, "persistence restart does not trigger an unknown replay");
  } finally { await runtime.dispose(); await host.stop(); await rm(root, { recursive: true, force: true }); }
});
