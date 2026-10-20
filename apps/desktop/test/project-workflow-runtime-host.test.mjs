import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";
import { AgentHost } from "@pi-desktop/agent-host";
import { createHostSessionPort, listPendingToolRequests } from "@pi-desktop/host-runtime";
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
  const mainResource = join(project, "main-output"), sideResource = join(project, "side-output");
  await mkdir(mainResource); await mkdir(sideResource);
  const host = new Host(binary, join(root, "data"), { env: { HOME: home }, quiet: true });
  const port = createProjectWorkflowHostPort(() => host, () => {});
  const prompts = [];
  const sidePath = join(sideResource, "side-result.json"), candidatePath = join(mainResource, "candidate.txt");
  let consumedValue;
  let sequence = 0;
  const agentHost = new AgentHost({ sessions: createHostSessionPort(() => host),
    runtime: {
      async prompt(request) {
        prompts.push(request);
        await host.call("session.appendMessage", { sessionId: request.sessionId, message: { id: request.userMessageId,
          role: "user", content: request.content, status: "complete", createdAt: new Date().toISOString() } });
        if (request.content.includes('"id": "side-artifact"')) {
          // Synthetic provider/tool boundary actually consumes the delivered file.
          consumedValue = JSON.parse(await readFile(sidePath, "utf8")).measurement;
          await writeFile(candidatePath, `Integrated measurement: ${consumedValue}`);
        }
        return { turnId: `synthetic-model-edge-${++sequence}` };
      },
      async stop() { return { requested: true }; }, async abort() {}, async respondInput() {},
    }, approvals: { listPendingTools: (sessionId) => listPendingToolRequests(() => host, sessionId),
      resolveTool: async () => {}, resolveContract: async () => {} },
  });
  const execution = createProjectWorkflowExecution({ getAgentHost: () => agentHost, getHost: () => host, flushTranscript: async () => true,
    assertExecutableSession: async () => {}, // This test owns the synthetic tool-capable model boundary.
    async createSession() { return (await host.call("session.create", { title: "Workflow", mode: "agent", projectPath: project })).session.id; },
  });
  const runtime = createProjectWorkflowRuntime({ host: port, execution });
  let projectId, sessionId;
  const mutate = async (kind, fields) => port.mutate({ kind, commandId: `setup-${++sequence}`, expectedRevision: (await port.snapshot()).revision, ...fields });
  const action = async (kind, fields = {}) => runtime.action({ kind, commandId: `intent-${++sequence}`, expectedRevision: (await port.snapshot()).revision, projectId, workstreamId: "work-1", ...fields });
  const report = (summary, next, consumedDeliveryIds = [], artifacts = []) => "```project-workflow-checkpoint\n" + JSON.stringify({ summary, next, stop: false, artifacts, evidence: [], consumedDeliveryIds }) + "\n```";
  async function finish(content, target = sessionId) {
    const turn = (await agentHost.workSnapshot(target)).activeTurnId;
    await host.call("session.appendMessage", { sessionId: target, message: { id: `reply-${++sequence}`, role: "assistant", content, status: "complete", createdAt: new Date().toISOString() } });
    agentHost.endTurn(target, turn, "completed");
    await runtime.onTurnSettled(target);
  }
  try {
    await host.start();
    projectId = (await host.call("project.group.create", { name: "Runtime integration", folders: [project] })).group.id;
    sessionId = (await host.call("session.create", { title: "Main", mode: "agent", projectPath: project })).session.id;
    const stamp = new Date().toISOString();
    await mutate("workstream.create", { workstream: { id: "work-1", projectId, title: "Local continuation", goal: "Produce, check and consume a result", acceptance: [{ id: "ac-1", title: "Useful candidate", status: "pending", evidenceIds: [] }],
      owner: { kind: "session", ref: sessionId }, status: "ready", priority: 0, order: 0, dependencyIds: [], nextAction: "Implement bounded local change", revision: 0, decisionRevision: 0, createdAt: stamp, updatedAt: stamp } });
    await mutate("authorization.grant", { authorization: { id: "auth-1", projectId, workstreamId: "work-1", actions: ["implement", "check"], resources: [mainResource], source: { kind: "user", ref: "explicit-local-authorization" }, permissionCeiling: "ask", maxRuns: 8, stopConditions: [], revoked: false } });
    await mutate("authorization.grant", { authorization: { id: "auth-side", projectId, workstreamId: "work-1", actions: ["check"], resources: [sideResource], source: { kind: "user", ref: "explicit-disjoint-side-authorization" }, permissionCeiling: "ask", maxRuns: 2, stopConditions: [], revoked: false } });
    await action("start", { authorizationId: "auth-1", sessionId });
    assert.equal(prompts.length, 1);
    const side = await action("side.create", { purpose: "work", visibility: "side_only", sourceSessionId: sessionId,
      readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true }, task: "Run the independent bounded check", authorizationId: "auth-side" });
    assert.equal(prompts.length, 2, "main and bounded side work execute in distinct sessions");
    await writeFile(sidePath, JSON.stringify({ measurement: 42, environment: "synthetic-local" }));
    const artifact = { id: "side-artifact", projectId, workstreamId: "work-1", label: "Bounded check output", kind: "report", revision: "side-revision-1",
      environment: "synthetic-local", entryPoint: sidePath, source: { kind: "run", ref: side.runId }, createdAt: stamp };
    await finish(report("Side check produced usable evidence", undefined, [], [artifact]), side.sessionId);
    const delivery = (await port.snapshot()).deliveries.find((d) => d.summary === "Side check produced usable evidence");
    assert.equal(delivery.state, "delivered");
    await finish(report("Implementation produced", { action: "check", resources: [mainResource], prompt: "Check the change" }));
    assert.equal(prompts.length, 3);
    assert.match(prompts.at(-1).content, /Side check produced usable evidence/);
    assert.equal(consumedValue, 42);
    assert.equal(await readFile(candidatePath, "utf8"), "Integrated measurement: 42");
    assert.equal((await port.snapshot()).deliveries.find((d) => d.id === delivery.id).state, "delivered");
    await action("pause");
    await finish(report("Consumed side evidence; paused at a safe checkpoint", { action: "implement", resources: [mainResource], prompt: "Fix the observed failure" }, [delivery.id]));
    assert.equal(prompts.length, 3);
    assert.equal((await port.snapshot()).deliveries.find((d) => d.id === delivery.id).state, "consumed");
    await action("resume");
    assert.equal(prompts.length, 4);
    await finish(report("Fix complete; acceptance review needed", undefined, [], [{ ...artifact, id: "owner-candidate", label: "Integrated candidate", kind: "candidate", revision: "candidate-revision-1", entryPoint: candidatePath }]));
    let state = await port.snapshot();
    assert.equal(state.workstreams[0].status, "awaiting_user");
    assert.equal(state.workstreams[0].currentCandidateId, "owner-candidate");
    assert.equal(state.artifacts.find((a) => a.id === "owner-candidate").revision, "candidate-revision-1");
    assert.equal(state.runs.length, 4);
    assert.ok(state.runs.every((run) => run.completionKey && run.state === "completed"));
    assert.equal(state.deliveries.filter((delivery) => delivery.state === "consumed").length, 4);
    await host.stop(); await host.start();
    state = await port.snapshot();
    assert.equal(state.runs.length, 4);
    assert.equal(state.workstreams[0].acceptance[0].status, "pending");
    assert.equal(prompts.length, 4, "persistence restart does not trigger an unknown replay");
  } finally { await runtime.dispose(); await host.stop(); await rm(root, { recursive: true, force: true }); }
});
