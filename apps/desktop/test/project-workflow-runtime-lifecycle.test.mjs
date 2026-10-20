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
const timestamp = "2026-10-20T00:00:00Z";
const checkpoint = (summary, next, overrides = {}) => "Done\n```project-workflow-checkpoint\n" + JSON.stringify({ summary, next, stop: false, artifacts: [], evidence: [], ...overrides }) + "\n```";
const next = (prompt, action = "check", resources = ["/synthetic/project"]) => ({ prompt, action, resources });

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
          for (const effect of command.run.effects) {
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
        case "delivery.consume": Object.assign(state.deliveries.find((d) => d.id === command.deliveryId), { state: "consumed", disposition: command.disposition }); break;
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
  const transcripts = new Map([["session-1", []]]);
  const prompts = [], stops = [], aborts = [];
  let count = 0, ids = 0, sessions = 1;
  const summaries = new Map([["session-1", { id: "session-1", title: "Main", mode: "agent", permissionMode: "auto", createdAt: timestamp, updatedAt: timestamp }]]);
  const modelEdge = {
    async prompt(request) {
      prompts.push(request);
      transcripts.get(request.sessionId).push({ id: request.userMessageId, role: "user", content: request.content, status: "complete", createdAt: timestamp });
      return { turnId: `turn-${++count}` };
    },
    async stop(sessionId) { stops.push(sessionId); return { requested: true }; },
    async abort(sessionId) { aborts.push(sessionId); },
    async respondInput() {},
  };
  const agentOptions = { runtime: modelEdge,
    sessions: { get: async (id) => summaries.get(id) ?? null, history: async () => ({ items: [], hasMore: false }) },
    approvals: { listPending: async () => [], resolveTool: async () => {}, resolveContract: async () => {} },
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
  return { host, runtime, execution, agentHost, modelEdge, prompts, stops, aborts, transcripts, action, finish,
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
