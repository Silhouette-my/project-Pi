import assert from "node:assert/strict";
import fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";
import * as nodeUrl from "node:url";
import crypto from "node:crypto";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";
import { AgentHost } from "@pi-desktop/agent-host";
import { projectWorkflowFixture } from "../../../packages/shared/dist/project-workflow-fixtures.js";

const principal = { subject: "desktop", roles: ["owner"], pairedDevice: true };
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const file = new URL(`../electron/main/runtime/${name}.ts`, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    if (id === "@pi-desktop/shared") return shared;
    if (id === "node:crypto") return crypto;
    if (id === "node:fs") return fs;
    if (id === "node:fs/promises") return fsPromises;
    if (id === "node:path") return nodePath;
    if (id === "node:url") return nodeUrl;
    if (id === "../agent-host-bridge") return { DESKTOP_PRINCIPAL: principal };
    if (id.startsWith("./project-workflow-")) return load(id.slice(2));
    throw new Error(`Unexpected import ${id}`);
  }, module.exports, module);
  cache.set(name, module.exports);
  return module.exports;
}
const { createProjectWorkflowRuntime } = load("project-workflow-runtime");
const { createProjectWorkflowExecution } = load("project-workflow-execution");
const { assembleWorkflowContext } = load("project-workflow-context");
const { durableUserMessageId } = load("../prompt-attachments");
const timestamp = "2026-10-20T00:00:00Z";
const checkpoint = (summary, next, overrides = {}) => "Done\n```project-workflow-checkpoint\n" + JSON.stringify({ summary, next, stop: false, artifacts: [], evidence: [], ...overrides }) + "\n```";
const next = (prompt, action = "check", resources = ["/synthetic/project"]) => ({ prompt, action, resources });

function requestShellApproval(f, sessionId, turnId, requestId, toolCallId, approvalScope = "workflow-shell") {
  const request = { requestId, sessionId, toolCallId, toolName: "Bash", argsPreview: { command: "npm test" }, risk: "high",
    reason: "Workflow Shell call needs one-time approval", ...(approvalScope ? { approvalScope } : {}) };
  f.pendingTools.push(request);
  f.agentHost.ingest({ sessionId, turnId, ts: Date.parse(timestamp), event: { type: "tool_permission_request", request } });
}

/** The only mocked internal-process boundary is Rust persistence; commands validate against C0. */
function durableHost(initial) {
  let state = structuredClone(initial);
  const seen = new Set();
  const calls = [];
  let failKind;
  return {
    calls,
    snapshot: async () => structuredClone(state),
    mutate: async (command) => {
      assert.ok(shared.isProjectWorkflowCommand(command), `invalid C0 command ${JSON.stringify(command)}`);
      calls.push(command);
      if (command.kind === failKind) { failKind = undefined; throw new Error("Synthetic Host interruption"); }
      if (seen.has(command.commandId)) return { snapshot: structuredClone(state), replayed: true };
      assert.equal(command.expectedRevision, state.revision);
      const w = state.workstreams.find((w) => w.id === (command.workstreamId ?? command.run?.workstreamId));
      switch (command.kind) {
        case "workstream.transition": Object.assign(w, { status: command.status, nextAction: command.nextAction, blocker: command.blocker, revision: w.revision + 1 }); break;
        case "workstream.update": Object.assign(w, command.patch); w.revision++; break;
        case "conversation.link": state.conversations = state.conversations.filter((c) => c.sessionId !== command.conversation.sessionId); state.conversations.push(command.conversation); break;
        case "run.start": {
          const auth = state.authorizations.find((a) => a.id === command.run.authorizationId);
          assert.equal(command.run.workstreamRevision, w.revision);
          assert.equal(command.run.executionMode, w.executionMode);
          for (const effect of command.run.executionMode === "session" ? [] : command.run.effects) {
            assert.ok(auth.actions.includes(effect.action), "planned effect action must be authorized");
            assert.ok(auth.resources.includes(effect.resource), "planned effect resource must be authorized");
          }
          state.runs.push(command.run); break;
        }
        case "run.observe": {
          const run = state.runs.find((r) => r.id === command.runId);
          for (const prior of run.effects) {
            const effect = command.effects.find((e) => e.id === prior.id);
            assert.ok(effect, "observed effects cannot be erased");
            assert.equal(effect.action, prior.action); assert.equal(effect.resource, prior.resource);
            if (prior.state === "confirmed") assert.equal(effect.state, "confirmed");
          }
          Object.assign(run, { state: command.state, outcome: command.outcome, effects: command.effects, completionKey: command.completionKey }); break;
        }
        case "delivery.publish": state.deliveries.push(command.delivery); break;
        case "delivery.consume": {
          const delivery = state.deliveries.find((d) => d.id === command.deliveryId);
          assert.equal(delivery.state, "delivered", "Host consumes a delivered result only once");
          Object.assign(delivery, { state: "consumed", disposition: command.disposition }); break;
        }
        case "decision.propose": state.decisions.push(command.decision); break;
        case "decision.resolve": {
          const decision = state.decisions.find((d) => d.id === command.decisionId);
          decision.state = "effective"; decision.adoptedBy = command.source; decision.adoptedRevision = ++w.decisionRevision; w.revision++;
          break;
        }
        case "artifact.put": state.artifacts.push(command.artifact); break;
        case "evidence.add": state.evidence.push(command.evidence); break;
        default: throw new Error(`Unimplemented fixture boundary ${command.kind}`);
      }
      state.revision++; seen.add(command.commandId);
      return { snapshot: structuredClone(state), replayed: false };
    },
    edit(fn) { fn(state); state.revision++; },
    failOnce(kind) { failKind = kind; },
  };
}

for (const permissionMode of ["ask", "auto"]) test(`Session task retains ${permissionMode} permissions and finishes with natural language`, async () => {
  const f = await setup((state) => {
    state.workstreams[0].executionMode = "session";
    state.workstreams[0].acceptance = [];
    state.authorizations = [];
  });
  f.summaries.get("session-1").permissionMode = permissionMode;
  await f.action("start", { sessionId: "session-1" });
  assert.equal(f.prompts[0].effectivePermissionMode, permissionMode);
  assert.equal(f.prompts[0].workflowRunId, undefined, "ordinary Agent admission owns tools and permissions");
  assert.doesNotMatch(f.prompts[0].content, /project-workflow-checkpoint/);
  assert.doesNotMatch(f.prompts[0].content, /Assigned resources/);
  const started = (await f.host.snapshot()).runs[0];
  assert.equal(started.executionMode, "session");
  assert.equal(started.authorizationId, undefined);
  const persistedId = JSON.parse(started.effects[0].detail).userMessageId;
  assert.match(persistedId, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  assert.equal(f.prompts[0].userMessageId, persistedId);
  assert.equal(f.transcripts.get("session-1")[0].id, persistedId);
  await f.finish("session-1", "Fixed the task and ran the relevant test.", "completed", [{ id: "check", role: "tool", toolName: "Bash", toolCallId: "check", toolStatus: "success", toolResult: { details: { exitCode: 0 } } }]);
  const state = await f.host.snapshot();
  assert.equal(state.runs[0].state, "completed");
  assert.equal(state.workstreams[0].status, "completed");
  assert.deepEqual(state.workstreams[0].acceptance, []);
  assert.equal(f.prompts.length, 1);
  await f.restart(true).recoverAll();
  assert.equal(JSON.parse((await f.host.snapshot()).runs[0].effects[0].detail).userMessageId, persistedId);
  assert.equal(f.prompts.length, 1, "restart must not rerun a natural-language result");
});

test("Session task completion preserves optional acceptance and can repair a nonzero check", async () => {
  const f = await setup((state) => { state.workstreams[0].executionMode = "session"; state.authorizations = []; });
  await f.action("start", { sessionId: "session-1" });
  await f.finish("session-1", "The first test failed; I fixed it and the second passed.", "completed", [
    { id: "check-failed", role: "tool", toolName: "Bash", toolCallId: "check-failed", toolStatus: "error", toolResult: { details: { exitCode: 1 } } },
    { id: "check-passed", role: "tool", toolName: "Bash", toolCallId: "check-passed", toolStatus: "success", toolResult: { details: { exitCode: 0 } } },
  ]);
  const state = await f.host.snapshot();
  assert.equal(state.workstreams[0].status, "completed");
  assert.equal(state.workstreams[0].acceptance[0].status, "pending", "turn completion is not user acceptance");
  assert.equal(state.runs[0].effects.find((effect) => effect.id === "check-failed").state, "confirmed");
});

for (const toolName of ["Read", "Glob", "Grep"]) test(`Session ${toolName} failure can be recovered inside the same Agent turn`, async () => {
  const f = await setup((state) => { state.workstreams[0].executionMode = "session"; state.authorizations = []; });
  await f.action("start", { sessionId: "session-1" });
  await f.finish("session-1", "The initial lookup failed; I found the right file and finished.", "completed", [
    { id: "lookup", role: "tool", toolName, toolCallId: "lookup", toolStatus: "error", toolResult: { details: { code: "FILE_NOT_FOUND" } } },
  ]);
  const state = await f.host.snapshot();
  assert.equal(state.runs[0].effects.find((effect) => effect.id === "lookup").state, "failed");
  assert.equal(state.workstreams[0].status, "completed");
});

test("Session side work returns natural language to the main conversation and next explicit turn", async () => {
  const f = await setup((state) => { state.workstreams[0].executionMode = "session"; state.authorizations = []; });
  await f.action("start", { sessionId: "session-1" });
  const discussion = await f.action("discuss", { pause: false });
  const side = await f.action("side.create", { purpose: "work", visibility: "project", task: "Inspect the independent piece",
    readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true } });
  const sideRun = (await f.host.snapshot()).runs.find((run) => run.sessionId === side.sessionId);
  assert.equal(sideRun.executionMode, "session");
  assert.equal(sideRun.authorizationId, undefined);
  await f.finish(side.sessionId, "SIDE_RESULT: The independent piece is ready.");
  const state = await f.host.snapshot();
  assert.equal(state.deliveries.find((delivery) => delivery.sourceRunId === sideRun.id).state, "consumed");
  assert.match(f.transcripts.get("session-1").at(-1).content, /SIDE_RESULT/);
  assert.match(f.transcripts.get(discussion.sessionId).at(-1).content, /SIDE_RESULT/);
  assert.equal(f.prompts.length, 2, "delivery does not silently launch another main turn");
  await f.finish("session-1", "Main work completed.");
  await f.action("start", { sessionId: "session-1" });
  assert.match(f.prompts.at(-1).content, /SIDE_RESULT/);
});

for (const interruptedPublish of [false, true]) test(`Explicit session Start consumes published side work without waiting for return integration (${interruptedPublish ? "torn integration" : "main not yet linked"})`, async () => {
  const f = await setup((state) => {
    state.workstreams[0].executionMode = "session"; state.authorizations = [];
    if (!interruptedPublish) delete state.workstreams[0].mainSessionId;
  });
  const side = await f.action("side.create", { purpose: "work", visibility: "project", sourceSessionId: "session-1", task: "Independent measurement",
    readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true } });
  if (interruptedPublish) f.host.failOnce("delivery.consume");
  const finishing = f.finish(side.sessionId, "PENDING_SIDE_MEASUREMENT: 42");
  if (interruptedPublish) await assert.rejects(finishing, /Synthetic Host interruption/);
  else await finishing;
  const before = await f.host.snapshot();
  const delivery = before.deliveries[0];
  assert.equal(delivery.state, "delivered");
  assert.equal(f.prompts.length, 1, "publication does not launch a main turn");
  f.host.edit((state) => state.deliveries.push({ ...structuredClone(delivery), id: "obsolete-result", summary: "STALE_SIDE_SECRET", decisionRevision: 99 }));
  await f.action("start", { sessionId: "session-1" });
  assert.match(f.prompts.at(-1).content, /PENDING_SIDE_MEASUREMENT: 42/);
  assert.doesNotMatch(f.prompts.at(-1).content, /STALE_SIDE_SECRET/);
  const admitted = await f.host.snapshot();
  const mainRun = admitted.runs.find((run) => run.sessionId === "session-1");
  assert.deepEqual(JSON.parse(mainRun.effects[0].detail).deliveryIds, [delivery.id]);
  assert.equal(admitted.deliveries.find((d) => d.id === "obsolete-result").disposition, "stale");
  assert.equal(admitted.deliveries.find((d) => d.id === delivery.id).state, "delivered", "queue admission alone is not consumption");
  await f.finish("session-1", "Incorporated the measurement, 42.");
  const after = await f.host.snapshot();
  assert.equal(after.deliveries.find((d) => d.id === delivery.id).disposition, "integrated");
  assert.equal(after.deliveries.find((d) => d.id === delivery.id).state, "consumed");
  assert.equal(after.workstreams[0].status, "completed");
  await f.restart().recoverAll();
  assert.equal(f.prompts.length, 2, "recovery finishes the torn return without replaying either turn");
});

test("Session side returnPolicy none does not enter main, discussion or explicit Start context", async () => {
  const f = await setup((state) => { state.workstreams[0].executionMode = "session"; state.authorizations = []; });
  const discussion = await f.action("discuss", { pause: false });
  const side = await f.action("side.create", { purpose: "work", visibility: "project", task: "Private inspection",
    readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true } });
  f.host.edit((state) => { state.conversations.find((c) => c.sessionId === side.sessionId).returnPolicy = "none"; });
  await f.finish(side.sessionId, "PRIVATE_SIDE_RESULT");
  assert.equal(f.transcripts.get("session-1").length, 0);
  assert.ok(f.transcripts.get(discussion.sessionId).every((message) => !message.content.includes("PRIVATE_SIDE_RESULT")));
  await f.action("start", { sessionId: "session-1" });
  assert.doesNotMatch(f.prompts.at(-1).content, /PRIVATE_SIDE_RESULT/);
  const main = (await f.host.snapshot()).runs.find((run) => run.sessionId === "session-1");
  assert.deepEqual(JSON.parse(main.effects[0].detail).deliveryIds, []);
});

test("Session turn completion includes same-turn steering and promoted user input", async () => {
  const f = await setup((state) => { state.workstreams[0].executionMode = "session"; state.authorizations = []; });
  await f.action("start", { sessionId: "session-1" });
  f.transcripts.get("session-1").push({ id: "promoted-user", role: "user", steering: true, content: "Also check the related file", status: "complete", createdAt: timestamp });
  await f.finish("session-1", "Completed the original and added request.");
  const state = await f.host.snapshot();
  assert.equal(state.runs[0].outcome, "Completed the original and added request.");
  assert.equal(state.workstreams[0].status, "completed");
});

test("Session exploration can propose a natural-language conclusion without adopting it", async () => {
  const f = await setup((state) => { state.workstreams[0].executionMode = "session"; state.authorizations = []; });
  const side = await f.action("side.create", { purpose: "explore", visibility: "project", task: "Compare the approaches",
    readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true } });
  assert.doesNotMatch(f.prompts[0].content, /project-workflow-checkpoint/);
  await f.finish(side.sessionId, "Prefer the simpler local approach.");
  const proposal = (await f.host.snapshot()).decisions.find((decision) => decision.id === `explore:${side.sessionId}:conclusion`);
  assert.equal(proposal.statement, "Prefer the simpler local approach.");
  assert.equal(proposal.state, "proposed");
});

test("Explore without its transient identity cannot borrow an unrelated final reply after restart", async () => {
  const f = await setup((state) => { state.workstreams[0].executionMode = "session"; state.authorizations = []; });
  const side = await f.action("side.create", { purpose: "explore", visibility: "project", task: "Compare the approaches",
    readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true } });
  f.execution.dispose();
  await f.finish(side.sessionId, "A reply whose turn identity was lost.");
  assert.equal((await f.host.snapshot()).decisions.length, 0);
});

test("A late side context cannot replace the actual main Agent final reply", async () => {
  const f = await setup((state) => { state.workstreams[0].executionMode = "session"; state.authorizations = []; });
  await f.action("start", { sessionId: "session-1" });
  const side = await f.action("side.create", { purpose: "work", visibility: "project", task: "Side inspection",
    readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true } });
  const mainTurn = (await f.agentHost.workSnapshot("session-1")).activeTurnId;
  f.transcripts.get("session-1").push({ id: "actual-main-final", role: "assistant", content: "ACTUAL_MAIN_RESULT", status: "complete", createdAt: timestamp });
  f.agentHost.endTurn("session-1", mainTurn, "completed");
  await f.finish(side.sessionId, "LATE_SIDE_RESULT");
  assert.match(f.transcripts.get("session-1").at(-1).id, /^workflow-context:/);
  await f.runtime.onTurnSettled("session-1");
  const mainRun = (await f.host.snapshot()).runs.find((run) => run.sessionId === "session-1");
  assert.equal(mainRun.outcome, "ACTUAL_MAIN_RESULT");
});

test("A later independent ordinary turn cannot replace an unsettled session task result", async () => {
  const f = await setup((state) => { state.workstreams[0].executionMode = "session"; state.authorizations = []; });
  await f.action("start", { sessionId: "session-1" });
  const originalTurn = (await f.agentHost.workSnapshot("session-1")).activeTurnId;
  f.transcripts.get("session-1").push({ id: "original-final", role: "assistant", content: "ORIGINAL_RESULT", status: "complete", createdAt: timestamp });
  f.agentHost.endTurn("session-1", originalTurn, "completed");
  const later = await f.agentHost.startTurn(principal, { sessionId: "session-1", admission: "queue",
    input: { text: "A different ordinary task", userMessageId: "later-user" }, context: { requestId: "later-user" } });
  f.transcripts.get("session-1").push({ id: "later-final", role: "assistant", content: "LATER_RESULT", status: "complete", createdAt: timestamp });
  f.agentHost.endTurn("session-1", later.turn.id, "completed");
  await f.runtime.onTurnSettled("session-1");
  assert.equal((await f.host.snapshot()).runs[0].outcome, "ORIGINAL_RESULT");
});

for (const terminal of ["failed", "interrupted", "canceled"]) test(`Session task ${terminal} cannot become completed`, async () => {
  const f = await setup((state) => { state.workstreams[0].executionMode = "session"; state.authorizations = []; });
  await f.action("start", { sessionId: "session-1" });
  await f.finish("session-1", "Execution stopped.", terminal);
  assert.equal((await f.host.snapshot()).workstreams[0].status, "awaiting_user");
  await f.restart(true).recoverAll();
  assert.equal(f.prompts.length, 1);
});

test("Session task retains unknown Shell effects and never replays them on resume", async () => {
  const f = await setup((state) => { state.workstreams[0].executionMode = "session"; state.authorizations = []; });
  await f.action("start", { sessionId: "session-1" });
  await f.finish("session-1", "The command timed out.", "completed", [
    { id: "uncertain", role: "tool", toolName: "Bash", toolCallId: "uncertain", toolStatus: "error", toolResult: { details: { code: "TOOL_TIMEOUT" } } },
  ]);
  assert.equal((await f.host.snapshot()).workstreams[0].status, "awaiting_user");
  await assert.rejects(() => f.action("resume"), { code: "WORKFLOW_EFFECT_UNKNOWN" });
  assert.equal(f.prompts.length, 1);
});

test("Independent session tasks sharing a user owner use ordinary per-session admission", async () => {
  const f = await setup((state) => {
    const main = state.workstreams[0]; main.executionMode = "session"; state.authorizations = [];
    state.workstreams.push({ ...structuredClone(main), id: "work-2", mainSessionId: "session-2" });
    state.conversations.push({ ...structuredClone(state.conversations[0]), sessionId: "session-2", workstreamId: "work-2" });
  });
  await f.action("start", { sessionId: "session-1" });
  await f.runtime.action({ kind: "start", commandId: "independent-start", projectId: "project-1", workstreamId: "work-2", sessionId: "session-2",
    expectedRevision: (await f.host.snapshot()).revision });
  assert.equal(f.prompts.length, 2);
  assert.equal((await f.host.snapshot()).workstreams.find((work) => work.id === "work-2").status, "executing");
});

test("An unused legacy authorization record cannot stop a session task", async () => {
  const f = await setup((state) => { state.workstreams[0].executionMode = "session"; });
  await f.action("start", { sessionId: "session-1" });
  await f.runtime.onHostChanged({ revision: (await f.host.snapshot()).revision, kind: "authorization.revoke", commandId: "unused-auth-revoke",
    projectId: "project-1", workstreamId: "work-1" });
  assert.deepEqual(f.stops, []);
  assert.deepEqual(f.aborts, []);
});

test("Session task queues behind an already-active ordinary turn in the same session", async () => {
  const f = await setup((state) => { state.workstreams[0].executionMode = "session"; state.authorizations = []; });
  await f.agentHost.startTurn(principal, { sessionId: "session-1", admission: "queue",
    input: { text: "Existing ordinary work", userMessageId: "existing-user" }, context: { requestId: "existing-user" } });
  await f.action("start", { sessionId: "session-1" });
  assert.equal(f.prompts.length, 1, "Workflow cannot bypass ordinary session admission");
  assert.equal((await f.host.snapshot()).runs[0].state, "queued");
  assert.equal(f.agentHost.queue.list("session-1").length, 1);
});

test("Legacy workstreams retain accountable-owner serialization", async () => {
  const f = await setup((state) => {
    const main = state.workstreams[0];
    state.workstreams.push({ ...structuredClone(main), id: "work-2", mainSessionId: "session-2" });
    state.conversations.push({ ...structuredClone(state.conversations[0]), sessionId: "session-2", workstreamId: "work-2" });
    state.authorizations.push({ ...structuredClone(state.authorizations[0]), id: "auth-other", workstreamId: "work-2", resources: ["/synthetic/other"] });
  });
  await f.action("start", { sessionId: "session-1", authorizationId: "auth-1" });
  await f.runtime.action({ kind: "start", commandId: "legacy-owner-start", projectId: "project-1", workstreamId: "work-2", sessionId: "session-2",
    authorizationId: "auth-other", expectedRevision: (await f.host.snapshot()).revision });
  assert.equal(f.prompts.length, 1);
  assert.equal((await f.host.snapshot()).workstreams.find((work) => work.id === "work-2").status, "blocked");
});

test("Session pause uses ordinary turn interruption and resume retains prior receipts", async () => {
  const f = await setup((state) => { state.workstreams[0].executionMode = "session"; state.authorizations = []; });
  await f.action("start", { sessionId: "session-1" });
  await f.action("pause");
  assert.deepEqual(f.aborts, ["session-1"]);
  assert.deepEqual(f.resolvedTools, [], "there is no extra workflow Shell approval layer");
  await f.finish("session-1", "Stopped at the requested boundary.", "interrupted");
  assert.equal((await f.host.snapshot()).workstreams[0].status, "paused");
  await f.action("resume");
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[1].content, /Continue the interrupted task/);
  assert.equal(f.prompts[1].workflowRunId, undefined);
});

async function setup(modify = () => {}) {
  const initial = projectWorkflowFixture();
  initial.workstreams[0].mainSessionId = "session-1";
  initial.conversations.push({ sessionId: "session-1", projectId: "project-1", workstreamId: "work-1", sourceRevision: 0,
    relation: "main", purpose: "work", visibility: "project", readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true }, returnPolicy: "delivery", archived: false, order: 0 });
  initial.authorizations.push({ id: "auth-1", projectId: "project-1", workstreamId: "work-1", actions: ["implement", "check", "document"],
    resources: ["/synthetic/project"], source: { kind: "user", ref: "approved-local-work" }, permissionCeiling: "ask", maxRuns: 10, stopConditions: ["Stop at a required user decision"], revoked: false });
  initial.authorizations.push({ ...structuredClone(initial.authorizations[0]), id: "auth-side", resources: ["/synthetic/side-output"], source: { kind: "user", ref: "explicit-disjoint-side-scope" } });
  modify(initial);
  const host = durableHost(initial);
  const sessionIds = [...new Set(initial.conversations.map((conversation) => conversation.sessionId))];
  const transcripts = new Map(sessionIds.map((sessionId) => [sessionId, []]));
  const prompts = [], stops = [], aborts = [];
  let count = 0, ids = 0, sessions = sessionIds.length;
  const summaries = new Map(sessionIds.map((sessionId, index) => [sessionId, { id: sessionId, title: index === 0 ? "Main" : `Session ${index + 1}`, mode: "agent", permissionMode: "auto", createdAt: timestamp, updatedAt: timestamp }]));
  const modelEdge = {
    async prompt(request) {
      prompts.push(request);
      const messages = transcripts.get(request.sessionId);
      // The production ordinary agentPrompt adapter accepts only fresh UUIDs.
      // Preserve its actual identity policy instead of echoing every requested ID.
      const id = request.workflowRunId !== undefined ? `workflow-run:${request.workflowRunId}` : durableUserMessageId(request.userMessageId, messages);
      messages.push({ id, role: "user", content: request.content, status: "complete", createdAt: timestamp });
      return { turnId: `turn-${++count}` };
    },
    async stop(sessionId) { stops.push(sessionId); return { requested: true }; },
    async abort(sessionId) { aborts.push(sessionId); },
    async respondInput() {},
  };
  const pendingTools = [];
  const resolvedTools = [];
  const syntheticShellEffects = [];
  let approvalFailure;
  const agentOptions = { runtime: modelEdge,
    sessions: { get: async (id) => summaries.get(id) ?? null, history: async () => ({ items: [], hasMore: false }) },
    approvals: {
      listPendingTools: async (sessionId) => pendingTools.filter((request) => !sessionId || request.sessionId === sessionId),
      resolveTool: async (requestId, decision) => {
        if (approvalFailure?.requestId === requestId) {
          const failure = approvalFailure.error;
          approvalFailure = undefined;
          const index = pendingTools.findIndex((request) => request.requestId === requestId);
          if (index >= 0) pendingTools.splice(index, 1);
          throw failure;
        }
        resolvedTools.push({ requestId, decision });
        const index = pendingTools.findIndex((request) => request.requestId === requestId);
        if (index >= 0) {
          const request = pendingTools[index];
          if (decision === "allow-once" && request.approvalScope === "workflow-shell" && request.toolName === "Bash") {
            syntheticShellEffects.push({ requestId, toolCallId: request.toolCallId });
          }
          pendingTools.splice(index, 1);
        }
      },
      resolveContract: async () => {},
    },
  };
  let agentHost = new AgentHost(agentOptions);
  const rpc = { async call(method, params) {
    if (method === "session.get") return { session: { id: params.id, messages: transcripts.get(params.id) } };
    if (method === "session.appendMessage") { transcripts.get(params.sessionId).push(params.message); return {}; }
    throw new Error(`Unexpected RPC ${method}`);
  } };
  const execution = createProjectWorkflowExecution({ getAgentHost: () => agentHost, getHost: () => rpc, flushTranscript: async () => true,
    assertExecutableSession: async () => {}, // Synthetic model edge is explicitly tool-capable.
    async createSession() {
      const id = `session-${++sessions}`; transcripts.set(id, []); summaries.set(id, { ...summaries.get("session-1"), id }); return id;
    },
  });
  const runtime = createProjectWorkflowRuntime({ host, execution, now: () => timestamp, id: () => `c-${++ids}` });
  async function action(kind, fields = {}) {
    return runtime.action({ kind, projectId: "project-1", workstreamId: "work-1", expectedRevision: (await host.snapshot()).revision, commandId: `intent-${++ids}`, ...fields });
  }
  async function finish(sessionId, content, status = "completed", toolRows = []) {
    const active = (await agentHost.workSnapshot(sessionId)).activeTurnId;
    transcripts.get(sessionId).push(...toolRows, { id: `reply-${count}`, role: "assistant", content, status: "complete", createdAt: timestamp });
    agentHost.endTurn(sessionId, active, status);
    await runtime.onTurnSettled(sessionId);
  }
  return { host, runtime, execution, agentHost, modelEdge, prompts, stops, aborts, transcripts, summaries, pendingTools, resolvedTools, syntheticShellEffects, action, finish,
    failApprovalResolveOnce(requestId, error) { approvalFailure = { requestId, error }; },
    restart(dropAgentHistory = false) {
      if (dropAgentHistory) agentHost = new AgentHost(agentOptions);
      return createProjectWorkflowRuntime({ host, execution, now: () => timestamp, id: () => `restart-${++ids}` });
    },
  };
}

test("Discuss -> Work -> evidence -> discuss -> adopt -> authorized check/fix/document continuation", async () => {
  const f = await setup();
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  assert.equal(f.prompts[0].effectivePermissionMode, "ask");
  assert.equal(f.prompts[0].workflowRunId, (await f.host.snapshot()).runs[0].id);
  await f.finish("session-1", checkpoint("Implementation produced", next("Run the critical test")));
  assert.equal(f.prompts.length, 2);
  const discussion = await f.action("discuss", { pause: false });
  assert.equal(f.stops.length, 0);
  assert.match(f.transcripts.get(discussion.sessionId)[0].content, /Implementation produced/);
  f.host.edit((s) => s.decisions.push({ id: "d-1", projectId: "project-1", workstreamId: "work-1", title: "Use narrow checks", statement: "Run changed critical paths", state: "proposed", sources: [{ kind: "session", ref: discussion.sessionId }], createdAt: timestamp }));
  await f.action("adopt", { decisionId: "d-1", source: { kind: "user", ref: "adopt-button" } });
  assert.deepEqual(f.stops, ["session-1"]);
  await f.finish("session-1", checkpoint("Old test outcome", next("Old proposal must not run")));
  assert.equal(f.prompts.length, 3);
  assert.match(f.prompts[2].content, /Run changed critical paths/);
  assert.doesNotMatch(f.prompts[2].content, /Old proposal must not run/);
  await f.finish("session-1", checkpoint("Critical test failed; cause isolated", next("Fix the observed failure", "implement")));
  await f.finish("session-1", checkpoint("Failure repaired", next("Update the affected runtime documentation", "document")));
  await f.finish("session-1", checkpoint("Documentation reconciled", undefined));
  assert.equal(f.prompts.length, 5);
  const state = await f.host.snapshot();
  assert.equal(state.workstreams[0].status, "awaiting_user");
  assert.notEqual(state.workstreams[0].status, "completed");
  assert.equal(state.deliveries.find((d) => d.summary === "Old test outcome").disposition, "stale");
  assert.ok(f.transcripts.get(discussion.sessionId).some((m) => m.content.includes("Work checkpoint since this discussion began")));
  await f.runtime.onTurnSettled("session-1");
  assert.equal(f.prompts.length, 5, "duplicate settlement must not dispatch a successor");
});

test("Ask and unadopted Explore never enter effective Work context", async () => {
  const f = await setup();
  const ask = await f.action("side.create", { purpose: "ask", visibility: "side_only", readContext: { selection: "Only this excerpt", resourceIds: [], includeDecisions: false, includeArtifacts: false }, task: "Explain it" });
  assert.match(f.prompts[0].content, /Only this excerpt/);
  assert.doesNotMatch(f.prompts[0].content, /Continue adopted work across sessions/);
  assert.equal((await f.host.snapshot()).runs.length, 0);
  const explore = await f.action("side.create", { purpose: "explore", visibility: "project", readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true }, task: "Consider another design" });
  f.transcripts.get(explore.sessionId).push({ id: "private-proposal", role: "assistant", content: "Unadopted alternative", status: "complete", createdAt: timestamp });
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  assert.doesNotMatch(f.prompts.at(-1).content, /Unadopted alternative|Explain it|Only this excerpt/);
  assert.equal((await f.host.snapshot()).conversations.find((c) => c.sessionId === ask.sessionId).returnPolicy, "none");
});

test("Work side delivery is consumed by the durable owner even when its discussion parent is gone", async () => {
  const f = await setup();
  const side = await f.action("side.create", { purpose: "work", visibility: "side_only", sourceSessionId: "closed-parent",
    readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true }, task: "Run a bounded test", authorizationId: "auth-side" });
  // Main has no prior run; its explicit authorization is still usable for consumption.
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  await f.finish(side.sessionId, checkpoint("Side test result", undefined));
  assert.equal((await f.host.snapshot()).deliveries[0].state, "delivered");
  await f.finish("session-1", checkpoint("Main checkpoint", next("Integrate the test result", "implement")));
  assert.match(f.prompts.at(-1).content, /Side test result/);
  let delivery = (await f.host.snapshot()).deliveries.find((d) => d.summary === "Side test result");
  assert.equal(delivery.state, "delivered", "dispatch/admission is not consumption");
  await f.finish("session-1", checkpoint("Integrated side result into the owner candidate", undefined, { consumedDeliveryIds: [delivery.id] }));
  delivery = (await f.host.snapshot()).deliveries.find((d) => d.summary === "Side test result");
  assert.equal(delivery.state, "consumed"); assert.equal(delivery.disposition, "integrated");
});

test("Out-of-scope next work requests a specific authorization once without retrying", async () => {
  const f = await setup();
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  await f.finish("session-1", checkpoint("Local checks complete", next("Publish production", "deploy", ["production"])));
  let s = await f.host.snapshot();
  assert.equal(s.workstreams[0].status, "awaiting_user"); assert.match(s.workstreams[0].blocker.reason, /authorized action\/resource scope/);
  await f.runtime.onTurnSettled("session-1");
  assert.equal(f.prompts.length, 1);
});

test("Pause is scoped, safe checkpoint resumes, and unknown effects never replay after restart", async () => {
  const f = await setup();
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  await f.action("pause");
  await f.finish("session-1", checkpoint("Safe boundary", next("Continue with the check")));
  assert.equal(f.prompts.length, 1);
  await f.action("resume"); assert.equal(f.prompts.length, 2);
  const state = await f.host.snapshot();
  const uncertain = state.runs.at(-1);
  f.host.edit((s) => { const r = s.runs.find((r) => r.id === uncertain.id); r.effects[0].state = "unknown"; r.state = "unknown"; });
  await assert.rejects(() => f.action("resume"), { code: "WORKFLOW_EFFECT_UNKNOWN" });
  assert.equal(f.prompts.length, 2);
});

test("Pause denies only its pending workflow Shell approval, then resumes that exact assignment with fresh approval", async () => {
  const f = await setup((state) => {
    const main = state.workstreams[0];
    state.workstreams.push({ ...structuredClone(main), id: "work-2", title: "Independent workstream", owner: { kind: "session", ref: "session-2" }, mainSessionId: "session-2", order: 1 });
    state.conversations.push({ ...structuredClone(state.conversations.find((conversation) => conversation.sessionId === "session-1")),
      sessionId: "session-2", workstreamId: "work-2", order: 1 });
    state.authorizations.push({ ...structuredClone(state.authorizations[0]), id: "auth-2", workstreamId: "work-2", resources: ["/synthetic/other-workstream"] });
  });
  await f.action("start", { workstreamId: "work-2", authorizationId: "auth-2", sessionId: "session-2" });
  const otherTurn = (await f.agentHost.workSnapshot("session-2")).activeTurnId;
  requestShellApproval(f, "session-2", otherTurn, "other-shell-approval", "other-shell-call");

  const offer = await f.action("side.create", { purpose: "work", visibility: "project", authorizationId: "auth-side",
    readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true }, task: "Prepare an independent check result" });
  await f.finish(offer.sessionId, checkpoint("Reusable side check result"));
  const deliveryId = (await f.host.snapshot()).deliveries[0].id;
  const side = await f.action("side.create", { purpose: "work", visibility: "project", authorizationId: "auth-side",
    readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true }, task: "Run the authorized side check" });
  const sideTurn = (await f.agentHost.workSnapshot(side.sessionId)).activeTurnId;
  requestShellApproval(f, side.sessionId, sideTurn, "side-shell-approval", "side-shell-call");
  await f.action("start", { workstreamId: "work-1", authorizationId: "auth-1", sessionId: "session-1" });
  const firstTurn = (await f.agentHost.workSnapshot("session-1")).activeTurnId;
  requestShellApproval(f, "session-1", firstTurn, "first-shell-approval", "first-shell-call");
  requestShellApproval(f, "session-1", firstTurn, "ordinary-shell-approval", "ordinary-shell-call", null);
  assert.deepEqual(f.agentHost.pendingApprovals("session-1").map((approval) => approval.id), ["first-shell-approval", "ordinary-shell-approval"]);
  assert.deepEqual(f.agentHost.pendingApprovals(side.sessionId).map((approval) => approval.id), ["side-shell-approval"]);
  assert.deepEqual(f.agentHost.pendingApprovals("session-2").map((approval) => approval.id), ["other-shell-approval"]);
  assert.deepEqual(f.syntheticShellEffects, [], "pending approvals have not started any Shell effect");

  f.host.failOnce("run.observe");
  await assert.rejects(() => f.action("pause", { workstreamId: "work-1" }), /Synthetic Host interruption/);
  assert.deepEqual(f.resolvedTools, [], "the Shell approval must not be touched before durable pause intent commits");
  assert.equal(f.agentHost.pendingApprovals("session-1").length, 2);
  assert.equal(f.agentHost.pendingApprovals(side.sessionId).length, 1);

  await f.action("pause", { workstreamId: "work-1" });
  assert.deepEqual(f.resolvedTools, [
    { requestId: "side-shell-approval", decision: "deny" },
    { requestId: "first-shell-approval", decision: "deny" },
  ]);
  assert.deepEqual(f.syntheticShellEffects, [], "denying pending approval has no external effect");
  assert.deepEqual(f.agentHost.pendingApprovals("session-1").map((approval) => approval.id), ["ordinary-shell-approval"]);
  assert.deepEqual(f.agentHost.pendingApprovals(side.sessionId), []);
  assert.deepEqual(f.agentHost.pendingApprovals("session-2").map((approval) => approval.id), ["other-shell-approval"]);
  assert.equal(f.agentHost.getTurn(otherTurn).status, "waiting_approval");
  assert.equal(f.aborts.length, 0, "pausing a pending approval never aborts a started command");
  const promptsWhilePaused = f.prompts.length;
  await assert.rejects(() => f.action("resume", { workstreamId: "work-1" }), { code: "CONFLICT" });
  assert.equal(f.prompts.length, promptsWhilePaused, "Resume waits for the actual terminal receipt");
  let state = await f.host.snapshot();
  for (const run of state.runs.filter((run) => run.workstreamId === "work-1" && ["session-1", side.sessionId].includes(run.sessionId))) {
    assert.equal(JSON.parse(run.effects.find((effect) => effect.id === "dispatch").detail).pausePendingShell, true);
  }

  await f.finish("session-1", checkpoint("Pending Shell was denied before execution", next("Run the assigned check again")), "failed", [
    { id: "first-shell-call", role: "tool", content: "Shell approval denied before execution", status: "complete", createdAt: timestamp,
      toolName: "Bash", toolCallId: "first-shell-call", toolStatus: "error",
      toolResult: { isError: true, terminate: true, details: { code: "TOOL_DENIED", approvalScope: "workflow-shell" } } },
  ]);
  await f.finish(side.sessionId, checkpoint("Side Shell was denied before execution"), "failed", [
    { id: "side-shell-call", role: "tool", content: "Shell approval denied before execution", status: "complete", createdAt: timestamp,
      toolName: "Bash", toolCallId: "side-shell-call", toolStatus: "error",
      toolResult: { isError: true, terminate: true, details: { code: "TOOL_DENIED", approvalScope: "workflow-shell" } } },
  ]);
  assert.deepEqual(f.agentHost.pendingApprovals("session-1"), []);
  state = await f.host.snapshot();
  const pausedRun = state.runs.find((run) => run.workstreamId === "work-1" && run.sessionId === "session-1");
  const pausedSideRun = state.runs.find((run) => run.workstreamId === "work-1" && run.sessionId === side.sessionId);
  assert.equal(pausedRun.state, "failed");
  assert.match(pausedRun.completionKey, /:paused-before-shell$/);
  assert.equal(pausedRun.effects.find((effect) => effect.id === "first-shell-call").state, "failed");
  assert.match(pausedSideRun.completionKey, /:paused-before-shell$/);
  assert.equal(f.prompts.length, 4, "denied requests do not dispatch successors while paused");

  await f.action("resume", { workstreamId: "work-1" });
  state = await f.host.snapshot();
  const resumedRun = state.runs.find((run) => run.sessionId === "session-1"
    && JSON.parse(run.effects.find((effect) => effect.id === "dispatch").detail).resumedFromRunId === pausedRun.id);
  const resumedSideRun = state.runs.find((run) => run.sessionId === side.sessionId
    && JSON.parse(run.effects.find((effect) => effect.id === "dispatch").detail).resumedFromRunId === pausedSideRun.id);
  assert.notEqual(resumedRun.id, pausedRun.id);
  assert.equal(resumedRun.workstreamId, pausedRun.workstreamId);
  assert.equal(resumedRun.sessionId, pausedRun.sessionId);
  assert.equal(resumedRun.authorizationId, pausedRun.authorizationId);
  assert.equal(resumedSideRun.authorizationId, pausedSideRun.authorizationId);
  assert.deepEqual(JSON.parse(resumedRun.effects.find((effect) => effect.id === "dispatch").detail).step,
    JSON.parse(pausedRun.effects.find((effect) => effect.id === "dispatch").detail).step);
  assert.deepEqual(JSON.parse(resumedSideRun.effects.find((effect) => effect.id === "dispatch").detail).step,
    JSON.parse(pausedSideRun.effects.find((effect) => effect.id === "dispatch").detail).step);
  assert.deepEqual(JSON.parse(resumedRun.effects.find((effect) => effect.id === "dispatch").detail).deliveryIds, [deliveryId]);
  assert.match(f.prompts.at(-1).content, /first-shell-call|prior.*Shell/i);
  assert.equal(f.prompts.length, 6);
  assert.deepEqual(f.syntheticShellEffects, [], "resume alone does not reuse an old approval or execute Shell");
  const resumedTurn = (await f.agentHost.workSnapshot("session-1")).activeTurnId;
  requestShellApproval(f, "session-1", resumedTurn, "resumed-shell-approval", "resumed-shell-call");
  const resumedSideTurn = (await f.agentHost.workSnapshot(side.sessionId)).activeTurnId;
  requestShellApproval(f, side.sessionId, resumedSideTurn, "resumed-side-shell-approval", "resumed-side-shell-call");
  assert.deepEqual(f.syntheticShellEffects, [], "new pending approvals still have no effect before allow-once");
  await f.agentHost.respondApproval(principal, { approvalId: "resumed-shell-approval", decision: "allow-once", context: { requestId: "user-allowed-resume" } });
  await f.agentHost.respondApproval(principal, { approvalId: "resumed-side-shell-approval", decision: "allow-once", context: { requestId: "user-allowed-side-resume" } });
  assert.deepEqual(f.syntheticShellEffects, [
    { requestId: "resumed-shell-approval", toolCallId: "resumed-shell-call" },
    { requestId: "resumed-side-shell-approval", toolCallId: "resumed-side-shell-call" },
  ], "each freshly approved resumed toolCallId causes exactly one synthetic external effect");
  assert.deepEqual(f.resolvedTools, [
    { requestId: "side-shell-approval", decision: "deny" },
    { requestId: "first-shell-approval", decision: "deny" },
    { requestId: "resumed-shell-approval", decision: "allow-once" },
    { requestId: "resumed-side-shell-approval", decision: "allow-once" },
  ]);

  await f.finish(side.sessionId, checkpoint("Resumed side Shell effect completed"), "completed", [
    { id: "resumed-side-shell-call", role: "tool", content: "side check passed", status: "complete", createdAt: timestamp,
      toolName: "Bash", toolCallId: "resumed-side-shell-call", toolStatus: "success", toolResult: { details: { exitCode: 0, stdout: "side check passed" } } },
  ]);
  await f.finish("session-1", checkpoint("Resumed Shell effect completed", undefined, { consumedDeliveryIds: [deliveryId] }), "completed", [
    { id: "resumed-shell-call", role: "tool", content: "tests passed", status: "complete", createdAt: timestamp,
      toolName: "Bash", toolCallId: "resumed-shell-call", toolStatus: "success", toolResult: { details: { exitCode: 0, stdout: "tests passed" } } },
  ]);
  state = await f.host.snapshot();
  assert.equal(state.runs.filter((run) => run.workstreamId === "work-1").length, 5);
  assert.equal(state.runs.find((run) => run.id === resumedRun.id).effects.filter((effect) => effect.id === "resumed-shell-call" && effect.state === "confirmed").length, 1);
  assert.equal(state.runs.find((run) => run.id === resumedSideRun.id).effects.filter((effect) => effect.id === "resumed-side-shell-call" && effect.state === "confirmed").length, 1);
  assert.equal(state.deliveries.find((delivery) => delivery.id === deliveryId).state, "consumed");
  assert.equal(state.deliveries.filter((delivery) => delivery.id === deliveryId).length, 1);
  const resumedMappings = state.runs.filter((run) => run.workstreamId === "work-1")
    .map((run) => JSON.parse(run.effects.find((effect) => effect.id === "dispatch").detail).resumedFromRunId)
    .filter(Boolean);
  assert.deepEqual(resumedMappings.sort(), [pausedRun.id, pausedSideRun.id].sort());
  assert.equal(new Set(resumedMappings).size, resumedMappings.length, "each paused run is restored at most once");
  const promptsBeforeSecondResume = f.prompts.length;
  const runIdsBeforeSecondResume = state.runs.map((run) => run.id);
  await f.action("resume", { workstreamId: "work-1" });
  state = await f.host.snapshot();
  assert.equal(f.prompts.length, promptsBeforeSecondResume, "a second Resume does not replay an already restored assignment");
  assert.deepEqual(state.runs.map((run) => run.id), runIdsBeforeSecondResume);
  assert.equal(f.agentHost.getTurn((await f.agentHost.workSnapshot("session-2")).activeTurnId).status, "waiting_approval", "the other workstream's pending approval survives");
});

test("A lost approval resolve race is not mistaken for a resumable pre-execution denial", async () => {
  const f = await setup();
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  const turnId = (await f.agentHost.workSnapshot("session-1")).activeTurnId;
  requestShellApproval(f, "session-1", turnId, "raced-shell-approval", "raced-shell-call");
  f.failApprovalResolveOnce("raced-shell-approval", Object.assign(new Error("permission request already settled"), { code: "NOT_FOUND" }));

  await f.action("pause");
  assert.deepEqual(f.resolvedTools, []);
  await f.finish("session-1", checkpoint("Approval raced with execution", next("Do not retry without a receipt")), "failed", [
    { id: "raced-shell-call", role: "tool", content: "execution outcome unavailable", status: "complete", createdAt: timestamp,
      toolName: "Bash", toolCallId: "raced-shell-call", toolStatus: "error",
      toolResult: { isError: true, terminate: true, details: { code: "TOOL_ABORTED" } } },
  ]);
  const state = await f.host.snapshot();
  const run = state.runs[0];
  assert.equal(run.state, "failed");
  assert.ok(!run.completionKey?.endsWith(":paused-before-shell"));
  assert.equal(run.effects.find((effect) => effect.id === "raced-shell-call")?.state, "unknown");
  assert.equal(f.prompts.length, 1);
  await assert.rejects(() => f.action("resume"), { code: "WORKFLOW_EFFECT_UNKNOWN" });
  assert.equal(f.prompts.length, 1);
});

test("Cancel does not turn a pending Shell approval into a resumable denial or successor", async () => {
  const f = await setup();
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  const turnId = (await f.agentHost.workSnapshot("session-1")).activeTurnId;
  requestShellApproval(f, "session-1", turnId, "cancelled-shell-approval", "cancelled-shell-call");
  await f.action("cancel");

  assert.deepEqual(f.resolvedTools, []);
  assert.equal(f.aborts.length, 1, "Cancel uses the existing interrupt path");
  assert.equal(f.prompts.length, 1);
  assert.deepEqual(f.agentHost.pendingApprovals("session-1").map((approval) => approval.id), ["cancelled-shell-approval"]);
  await f.finish("session-1", checkpoint("Cancelled pending approval", next("Must not continue")), "interrupted", []);
  const state = await f.host.snapshot();
  assert.equal(state.runs[0].completionKey, state.runs[0].id + ":terminal");
  assert.equal(state.workstreams[0].status, "cancelled");
  assert.equal(f.prompts.length, 1);
});

test("Pausing an already-started Shell asks it to stop gracefully without resolving approval or aborting", async () => {
  const f = await setup();
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  const turnId = (await f.agentHost.workSnapshot("session-1")).activeTurnId;
  f.agentHost.ingest({ sessionId: "session-1", turnId, ts: Date.parse(timestamp),
    event: { type: "tool_start", toolCallId: "started-shell-call", toolName: "Bash", args: { command: "npm test" } } });
  await f.action("pause");
  assert.deepEqual(f.resolvedTools, []);
  assert.deepEqual(f.aborts, []);
  assert.ok(f.stops.includes("session-1"), "the active runner receives a graceful stop request");
  await f.finish("session-1", checkpoint("Started Shell did not report a final exit code", next("Reconcile before retry")), "interrupted", [
    { id: "started-shell-call", role: "tool", content: "command interrupted", status: "complete", createdAt: timestamp,
      toolName: "Bash", toolCallId: "started-shell-call", toolStatus: "error",
      toolResult: { isError: true, terminate: true, details: { code: "TOOL_ABORTED" } } },
  ]);
  const state = await f.host.snapshot();
  assert.equal(state.runs[0].effects.find((effect) => effect.id === "started-shell-call")?.state, "unknown");
  assert.equal(state.runs[0].completionKey, state.runs[0].id + ":terminal");
  assert.equal(f.prompts.length, 1);
  assert.equal(f.agentHost.getTurn(turnId).status, "interrupted");
});

test("Old decision result cannot replace a current candidate", async () => {
  const f = await setup();
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  f.host.edit((s) => s.workstreams[0].decisionRevision++);
  const artifact = { id: "old-candidate", projectId: "project-1", workstreamId: "work-1", label: "Old", kind: "candidate", revision: "old-rev", environment: "synthetic", entryPoint: "/old", source: { kind: "run", ref: "old" }, createdAt: timestamp };
  await f.finish("session-1", checkpoint("Stale result retained", undefined, { artifacts: [artifact] }));
  assert.equal((await f.host.snapshot()).artifacts.length, 0);
});

test("Context uses only effective, scoped canonical resources and never proposals or superseded decisions", async () => {
  const f = await setup((s) => {
    s.decisions.push(...["effective", "proposed", "superseded"].map((state) => ({ id: state, projectId: "project-1", workstreamId: "work-1", state, title: state, statement: `decision-${state}`, sources: [], createdAt: timestamp })));
    s.resources.push({ id: "constraint", projectId: "project-1", label: "Canonical", uri: "file:///canonical/CONSTRAINTS.md", kind: "constraint", revision: "r3", updatedAt: timestamp, state: "effective", source: { kind: "file", ref: "/canonical/CONSTRAINTS.md" } });
  });
  const s = await f.host.snapshot();
  const context = assembleWorkflowContext(s, s.workstreams[0]);
  assert.match(context, /decision-effective|CONSTRAINTS.md/);
  assert.doesNotMatch(context, /decision-proposed|decision-superseded/);
});

test("Explore returns a source-backed proposal only; side-only conclusions stay private", async () => {
  const f = await setup();
  const side = await f.action("side.create", { purpose: "explore", visibility: "project", readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true }, task: "Explore a smaller design" });
  await f.finish(side.sessionId, checkpoint("Use a smaller design", undefined));
  const state = await f.host.snapshot();
  assert.equal(state.decisions[0].state, "proposed");
  assert.equal(state.decisions[0].sources[0].ref, side.sessionId);
  assert.doesNotMatch(await f.runtime.contextForSession("session-1"), /Use a smaller design/);
  const privateSide = await f.action("side.create", { purpose: "explore", visibility: "side_only", readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true }, task: "Private alternative" });
  await f.finish(privateSide.sessionId, checkpoint("Keep this alternative private", undefined));
  assert.equal((await f.host.snapshot()).decisions.length, 1);
});

test("Restart recovers a missed terminal callback; a torn settlement publishes and dispatches once", async () => {
  const f = await setup();
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  f.host.failOnce("delivery.consume");
  await assert.rejects(() => f.finish("session-1", checkpoint("Produced before crash", next("Check after restart"))), /Synthetic Host interruption/);
  assert.equal((await f.host.snapshot()).runs[0].completionKey, undefined);
  const restarted = f.restart(true);
  await restarted.action({ kind: "reconcile", commandId: "restart-reconcile", projectId: "project-1", workstreamId: "work-1", expectedRevision: (await f.host.snapshot()).revision });
  const state = await f.host.snapshot();
  assert.equal(state.deliveries.length, 1);
  assert.equal(state.runs.length, 2);
  assert.equal(f.prompts.length, 2);
  assert.ok(state.runs[0].completionKey);
});

test("Restart cannot replay a dispatch whose outcome or external effects are unknown", async () => {
  const f = await setup();
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  const restarted = f.restart(true);
  await restarted.action({ kind: "reconcile", commandId: "restart-unknown", projectId: "project-1", workstreamId: "work-1", expectedRevision: (await f.host.snapshot()).revision });
  const state = await f.host.snapshot();
  assert.equal(state.runs[0].state, "unknown");
  assert.equal(state.workstreams[0].status, "awaiting_user");
  assert.equal(f.prompts.length, 1);
});

test("Tool effects remain visible, and a partially failed external tool blocks automatic continuation", async () => {
  const f = await setup();
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  await f.finish("session-1", checkpoint("A command failed after starting", next("Do not retry")), "completed", [{ id: "tool-row", role: "tool", content: "Failed", toolName: "Bash", toolCallId: "tool-1", toolStatus: "error", createdAt: timestamp }]);
  const state = await f.host.snapshot();
  assert.equal(state.runs[0].effects.find((e) => e.id === "tool-1").state, "unknown");
  assert.equal(state.workstreams[0].status, "awaiting_user");
  assert.equal(f.prompts.length, 1);
});

test("Per-turn ceiling survives queue admission and cannot widen the existing session grant", async () => {
  const f = await setup();
  const first = await f.agentHost.startTurn(principal, { sessionId: "session-1", input: { text: "ordinary" }, context: { requestId: "first" } });
  const queued = await f.agentHost.startTurn(principal, { sessionId: "session-1", permissionCeiling: "ask", admission: "queue", input: { text: "narrow scoped work" }, context: { requestId: "second" }, idempotencyKey: "same" });
  assert.equal(queued.turn.effectivePermissionMode, "ask");
  await assert.rejects(() => f.agentHost.startTurn(principal, { sessionId: "session-1", permissionCeiling: "auto", admission: "queue", input: { text: "narrow scoped work" }, context: { requestId: "changed-ceiling" }, idempotencyKey: "same" }), { code: "IDEMPOTENCY_CONFLICT" });
  const prompt = f.modelEdge.prompt.bind(f.modelEdge);
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  f.modelEdge.prompt = async (request) => { const result = await prompt(request); resolveStarted(request); return result; };
  f.agentHost.endTurn("session-1", first.turn.id, "completed");
  const request = await started;
  assert.equal(request.effectivePermissionMode, "ask");
});

test("A queued workflow can pause before execution and resume without repeating external work", async () => {
  const f = await setup();
  await f.agentHost.startTurn(principal, { sessionId: "session-1", input: { text: "Existing unrelated turn" }, context: { requestId: "busy" } });
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  assert.equal((await f.host.snapshot()).runs[0].state, "queued");
  await f.action("pause");
  assert.equal((await f.host.snapshot()).runs[0].state, "cancelled");
  assert.match((await f.host.snapshot()).runs[0].completionKey, /paused-before-start$/);
  await f.action("resume");
  const state = await f.host.snapshot();
  assert.equal(state.runs.length, 2);
  assert.equal(state.runs[1].state, "queued");
  assert.equal(state.workstreams[0].status, "executing");
  assert.equal(f.prompts.length, 1, "only the unrelated turn has actually executed");
});

test("Queued result delivery remains unconsumed if the pending owner turn is cancelled", async () => {
  const f = await setup();
  await f.agentHost.startTurn(principal, { sessionId: "session-1", input: { text: "Existing unrelated turn" }, context: { requestId: "busy" } });
  const side = await f.action("side.create", { purpose: "work", visibility: "project", readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true }, task: "Bounded side test", authorizationId: "auth-side" });
  await f.finish(side.sessionId, checkpoint("Side output awaits actual use", undefined));
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  let state = await f.host.snapshot();
  assert.equal(state.runs.at(-1).state, "queued");
  assert.equal(state.deliveries[0].state, "delivered");
  await f.action("pause");
  state = await f.host.snapshot();
  assert.equal(state.deliveries[0].state, "delivered");
  assert.equal(state.deliveries[0].disposition, "pending");
});

test("A complete assistant checkpoint is not proof that a pre-crash turn terminated", async () => {
  const f = await setup();
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  f.transcripts.get("session-1").push({ id: "intermediate-checkpoint", role: "assistant", content: checkpoint("Still executing a later tool", next("Must not replay")), status: "complete", createdAt: timestamp });
  const restarted = f.restart(true);
  await restarted.action({ kind: "reconcile", commandId: "restart-before-terminal", projectId: "project-1", workstreamId: "work-1", expectedRevision: (await f.host.snapshot()).revision });
  assert.equal((await f.host.snapshot()).runs[0].state, "unknown");
  assert.equal(f.prompts.length, 1);
});

test("An established main line sees newly effective constraints and skills at the next boundary", async () => {
  const f = await setup();
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  f.host.edit((state) => state.resources.push({ id: "new-skill", projectId: "project-1", label: "New canonical skill", uri: "file:///synthetic/project/SKILL.md", kind: "skill", revision: "r2", updatedAt: timestamp, state: "effective", source: { kind: "file", ref: "/synthetic/project/SKILL.md" } }));
  assert.match(await f.runtime.contextForSession("session-1"), /new-skill/);
  await f.finish("session-1", checkpoint("First step", next("Use the current skill")));
  assert.match(f.prompts.at(-1).content, /new-skill/);
});

test("A late trusted terminal receipt can reconcile unknown execution without replaying the action", async () => {
  const f = await setup();
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  f.host.edit((state) => {
    const run = state.runs[0]; run.state = "unknown"; run.completionKey = `${run.id}:terminal`;
    run.effects.push({ ...run.effects[0], id: "terminal-outcome", state: "unknown", detail: "Missing receipt" });
  });
  await f.finish("session-1", checkpoint("Trusted late completion", undefined));
  const state = await f.host.snapshot();
  assert.equal(state.runs[0].state, "completed");
  assert.equal(state.runs[0].effects.find((e) => e.id === "terminal-outcome").state, "confirmed");
  assert.equal(f.prompts.length, 1);
});

test("Consumer-only Chat cannot silently become a tool-capable Work session", async () => {
  let called = false;
  const execution = createProjectWorkflowExecution({
    getAgentHost: () => { called = true; throw new Error("must not reach Agent Host"); },
    getHost: () => { throw new Error("not used"); }, createSession: async () => "chat-session", flushTranscript: async () => true,
    assertExecutableSession: async () => { throw Object.assign(new Error("Choose an executable Agent session; consumer Chat is discussion-only"), { code: "INVALID_ARGUMENT" }); },
  });
  await assert.rejects(() => execution.start({ run: { sessionId: "chat-session" }, authorization: {}, content: "Implement" }), /Choose an executable Agent session/);
  assert.equal(called, false);
});

test("A user counterexample routes the exact candidate, revision and environment back into authorized work", async () => {
  const f = await setup();
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  await f.finish("session-1", checkpoint("Candidate produced", undefined));
  f.host.edit((state) => {
    Object.assign(state.workstreams[0], { status: "ready", currentCandidateId: "candidate-1" });
    state.feedback.push({ id: "counterexample-1", projectId: "project-1", workstreamId: "work-1", candidateId: "candidate-1", candidateRevision: "rev-7",
      environment: "local-desktop", acceptanceId: "ac-1", comment: "Fails on my empty input", source: { kind: "user", ref: "feedback-button" }, createdAt: timestamp });
  });
  const event = { kind: "feedback.add", projectId: "project-1", workstreamId: "work-1", revision: (await f.host.snapshot()).revision, commandId: "feedback-command" };
  await f.runtime.onHostChanged(event);
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[1].content, /candidate-1@rev-7|local-desktop|Fails on my empty input/);
  await f.runtime.onHostChanged(event);
  assert.equal(f.prompts.length, 2);
});

test("An explicit corrected Start can recover a known admission rejection without an automatic retry", async () => {
  const f = await setup();
  const prompt = f.modelEdge.prompt;
  f.modelEdge.prompt = async () => { throw Object.assign(new Error("Choose an executable session"), { code: "INVALID_ARGUMENT" }); };
  await assert.rejects(() => f.action("start", { authorizationId: "auth-1", sessionId: "session-1" }), /Choose an executable session/);
  assert.equal((await f.host.snapshot()).runs[0].state, "failed");
  assert.equal(f.prompts.length, 0);
  f.modelEdge.prompt = prompt;
  f.host.edit((state) => { state.workstreams[0].nextAction = "Implement using the corrected explicit execution session"; });
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  assert.equal(f.prompts.length, 1);
});

test("Overlapping side Work fails before session creation; generic check labels do not imply read-only", async () => {
  const f = await setup();
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  const before = await f.host.snapshot();
  await assert.rejects(() => f.action("side.create", { purpose: "work", visibility: "project", authorizationId: "auth-1",
    readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true }, task: "Run a check in the same scope" }), { code: "CONFLICT" });
  const after = await f.host.snapshot();
  assert.equal(after.runs.length, before.runs.length);
  assert.equal(after.conversations.length, before.conversations.length);
  assert.equal(after.workstreams[0].status, "executing");
  const side = await f.action("side.create", { purpose: "work", visibility: "project", authorizationId: "auth-side",
    readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true }, task: "Use the explicitly disjoint scope" });
  assert.ok(side.runId); assert.equal(f.prompts.length, 2);
});

test("Path scope arbitration catches parents and symlink aliases of not-yet-created outputs", async () => {
  const { resourcesOverlap } = load("project-workflow-resources");
  const root = await fsPromises.mkdtemp("/tmp/project-workflow-scope-");
  try {
    await fsPromises.mkdir(nodePath.join(root, "real"));
    await fsPromises.symlink(nodePath.join(root, "real"), nodePath.join(root, "alias"));
    assert.equal(await resourcesOverlap(nodePath.join(root, "real"), nodePath.join(root, "alias", "future.txt")), true);
    assert.equal(await resourcesOverlap(nodePath.join(root, "real"), nodePath.join(root, "unrelated")), false);
    assert.equal(await resourcesOverlap("/synthetic/project", "/synthetic/project2"), false);
  } finally { await fsPromises.rm(root, { recursive: true, force: true }); }
});

test("Future case-only output names follow the existing target volume's case semantics", async () => {
  const { resourcesOverlap } = load("project-workflow-resources");
  const root = await fsPromises.mkdtemp("/tmp/project-workflow-case-");
  try {
    const alternate = nodePath.basename(root).replace(/[a-z]/, (letter) => letter.toUpperCase());
    const original = await fsPromises.stat(root);
    let sameEntry = false;
    try {
      const alias = await fsPromises.stat(nodePath.join(nodePath.dirname(root), alternate));
      sameEntry = alias.dev === original.dev && alias.ino === original.ino;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    assert.equal(await resourcesOverlap(nodePath.join(root, "Output.txt"), nodePath.join(root, "output.txt")), sameEntry);
    assert.equal(await resourcesOverlap(nodeUrl.pathToFileURL(nodePath.join(root, "Output.txt")).href, nodePath.join(root, "output.txt")), sameEntry);
  } finally { await fsPromises.rm(root, { recursive: true, force: true }); }
});

test("A resource-blocked successor resumes its original action and resource subset", async () => {
  const a = "/synthetic/project/a", b = "/synthetic/project/b";
  const f = await setup((state) => {
    state.authorizations.find((auth) => auth.id === "auth-1").resources = [a, b];
    state.authorizations.find((auth) => auth.id === "auth-side").resources = [a];
  });
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  await f.finish("session-1", checkpoint("Initial implementation", next("Check B only", "check", [b])));
  const side = await f.action("side.create", { purpose: "work", visibility: "project", authorizationId: "auth-side",
    readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true }, task: "Work on A independently" });
  await f.finish("session-1", checkpoint("B checked", next("Document A only", "document", [a])));
  assert.equal((await f.host.snapshot()).workstreams[0].status, "blocked");
  assert.equal(f.prompts.length, 3);
  await f.finish(side.sessionId, checkpoint("A side result", undefined));
  const state = await f.host.snapshot();
  const resumed = state.runs.filter((run) => run.sessionId === "session-1").at(-1);
  assert.equal(state.workstreams[0].status, "executing");
  assert.equal(f.prompts.length, 4);
  assert.deepEqual(resumed.effects.map(({ action, resource }) => ({ action, resource })), [{ action: "document", resource: a }]);
  assert.equal(JSON.parse(resumed.effects[0].detail).step.prompt, "Document A only");
});

test("Discuss cannot relink the live Work session into a branch", async () => {
  const f = await setup();
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  await assert.rejects(() => f.action("discuss", { sessionId: "session-1", pause: false }), { code: "CONFLICT" });
  assert.equal((await f.host.snapshot()).conversations.find((c) => c.sessionId === "session-1").relation, "main");
  assert.equal(f.stops.length, 0);
});

test("Repurposing a running Explore session cannot substitute its old checkpoint for queued Work", async () => {
  const f = await setup();
  const explore = await f.action("side.create", { purpose: "explore", visibility: "project",
    readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true }, task: "Explore a candidate" });
  await f.action("start", { authorizationId: "auth-1", sessionId: explore.sessionId });
  await f.finish(explore.sessionId, checkpoint("Old Explore checkpoint must stay discussion", next("Never execute this old suggestion")));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.prompts.length, 2);
  await f.finish(explore.sessionId, checkpoint("Actual Work result", undefined));
  const state = await f.host.snapshot();
  assert.deepEqual(state.deliveries.map((delivery) => delivery.summary), ["Actual Work result"]);
  assert.equal(f.prompts.length, 2);
});

test("A resource denial keeps its precise authorization guidance and never dispatches a successor", async () => {
  const f = await setup();
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  const turnId = (await f.agentHost.workSnapshot("session-1")).activeTurnId;
  const reason = "WORKFLOW_RESOURCE_DENIED: Write /synthetic/other requires explicit workflow resource authorization";
  f.transcripts.get("session-1").push({ id: "denied-write", role: "tool", content: reason, status: "complete", createdAt: timestamp,
    toolName: "Write", toolCallId: "denied-write", toolStatus: "error",
    toolResult: { isError: true, terminate: true, details: { code: "WORKFLOW_RESOURCE_DENIED", error: reason } } });
  f.agentHost.ingest({ sessionId: "session-1", turnId, ts: Date.parse(timestamp),
    event: { type: "error", error: { code: "WORKFLOW_RESOURCE_DENIED", message: reason, retriable: false } } });
  await f.runtime.onTurnSettled("session-1");
  const state = await f.host.snapshot();
  assert.equal(state.runs[0].state, "failed");
  assert.equal(state.workstreams[0].status, "awaiting_user");
  assert.match(state.workstreams[0].blocker.reason, /Write \/synthetic\/other requires explicit workflow resource authorization/);
  assert.equal(state.runs[0].effects.find((effect) => effect.id === "denied-write").state, "failed", "a trusted pre-effect refusal is not an uncertain external effect");
  assert.equal(f.prompts.length, 1);
  f.host.edit((snapshot) => { snapshot.workstreams[0].nextAction = "Write only the authorized output after explicit user correction"; });
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  assert.equal(f.prompts.length, 2, "only a fresh explicit user start may recover the known refusal");
});

for (const { code, approvalScope, expected } of [
  { code: "TOOL_DENIED", approvalScope: "workflow-shell", expected: "failed" },
  { code: "TOOL_ABORTED", approvalScope: "workflow-shell", expected: "failed" },
  { code: "TOOL_ABORTED", approvalScope: undefined, expected: "unknown" },
  { code: "TOOL_TIMEOUT", approvalScope: undefined, expected: "unknown" },
  { code: "TOOL_FAILED", approvalScope: undefined, expected: "unknown" },
]) test(`Shell ${code} ${approvalScope ?? "after admission"} retains ${expected} effect without retry`, async () => {
  const f = await setup();
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  const turnId = (await f.agentHost.workSnapshot("session-1")).activeTurnId;
  const reason = `${code}: exact Shell approval was refused or the command was interrupted`;
  f.transcripts.get("session-1").push({ id: "shell-call", role: "tool", content: reason, status: "complete", createdAt: timestamp,
    toolName: "Bash", toolCallId: "shell-call", toolStatus: "error",
    toolResult: { isError: true, terminate: true, details: { code, ...(approvalScope ? { approvalScope } : {}), error: reason } } });
  f.agentHost.ingest({ sessionId: "session-1", turnId, ts: Date.parse(timestamp),
    event: { type: "error", error: { code, message: reason, retriable: false } } });
  await f.runtime.onTurnSettled("session-1");
  const state = await f.host.snapshot();
  assert.equal(state.runs[0].state, "failed");
  assert.equal(state.runs[0].effects.find((effect) => effect.id === "shell-call").state, expected);
  assert.equal(state.workstreams[0].status, "awaiting_user");
  assert.match(state.workstreams[0].blocker.reason, new RegExp(code));
  assert.equal(f.prompts.length, 1);
  if (expected === "unknown") {
    await assert.rejects(() => f.action("start", { authorizationId: "auth-1", sessionId: "session-1" }), { code: "CONFLICT" });
  } else {
    f.host.edit((snapshot) => { snapshot.workstreams[0].nextAction = "Continue only after this explicit user correction"; });
    await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
    assert.equal(f.prompts.length, 2);
  }
});

test("A signalled Shell without an integer exit receipt keeps effects unknown even if projected as success", async () => {
  const f = await setup();
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  await f.finish("session-1", checkpoint("Shell interrupted", undefined), "failed", [
    { id: "signal-check", role: "tool", content: "terminated by signal", status: "complete", createdAt: timestamp,
      toolName: "Bash", toolStatus: "success", toolResult: { details: { exitCode: null, stdout: "partial output" } } },
  ]);
  const state = await f.host.snapshot();
  assert.equal(state.runs[0].effects.find((effect) => effect.id === "signal-check").state, "unknown");
  assert.equal(f.prompts.length, 1);
  await assert.rejects(() => f.action("start", { authorizationId: "auth-1", sessionId: "session-1" }), { code: "CONFLICT" });
});

test("A completed Shell check failure remains evidence while an authorized fix/check cycle continues", async () => {
  const f = await setup();
  await f.action("start", { authorizationId: "auth-1", sessionId: "session-1" });
  await f.finish("session-1", checkpoint("Check failed, fix applied, recheck passed", next("Document the observed repair", "document")), "completed", [
    { id: "failed-check", role: "tool", content: "test assertion failed", status: "complete", createdAt: timestamp,
      toolName: "Bash", toolStatus: "error", toolResult: { isError: true, details: { exitCode: 1, stderr: "test assertion failed" } } },
    { id: "fixed-code", role: "tool", content: "written", status: "complete", createdAt: timestamp, toolName: "Write", toolStatus: "success" },
    { id: "passed-check", role: "tool", content: "test passed", status: "complete", createdAt: timestamp,
      toolName: "Bash", toolStatus: "success", toolResult: { details: { exitCode: 0, stdout: "test passed" } } },
  ]);
  const state = await f.host.snapshot();
  assert.equal(state.runs[0].state, "completed");
  assert.equal(state.runs[0].effects.find((effect) => effect.id === "failed-check").state, "confirmed");
  assert.equal(f.transcripts.get("session-1").find((row) => row.id === "failed-check").toolStatus, "error");
  assert.equal(f.prompts.length, 2);
  assert.equal(state.workstreams[0].acceptance[0]?.status, "pending");
});
