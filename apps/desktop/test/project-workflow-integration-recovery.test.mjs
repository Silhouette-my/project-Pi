import assert from "node:assert/strict";
import fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";
import * as nodeUrl from "node:url";
import crypto from "node:crypto";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";
import { projectWorkflowFixture } from "../../../packages/shared/dist/project-workflow-fixtures.js";

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
    if (id.startsWith("./project-workflow-")) return load(id.slice(2));
    throw new Error(`Unexpected import ${id}`);
  }, module.exports, module);
  cache.set(name, module.exports);
  return module.exports;
}
const { createProjectWorkflowRuntime } = load("project-workflow-runtime");
const timestamp = "2026-10-20T00:00:00Z";
const next = { action: "check", resources: ["/synthetic/allowed"], prompt: "Run the accepted narrow check" };
const checkpoint = "```project-workflow-checkpoint\n" + JSON.stringify({ summary: "Implementation complete", next, stop: false,
  artifacts: [], evidence: [], consumedDeliveryIds: ["side-result"] }) + "\n```";

// Rust persistence is the durable boundary; the coordinator and its checkpoint,
// authorization, resource and context collaborators are real.
function setup() {
  const initial = projectWorkflowFixture();
  const w = initial.workstreams[0];
  Object.assign(w, { status: "executing", mainSessionId: "session-1", nextAction: "Must not replace the checkpoint's next step" });
  initial.workstreams.push({ ...structuredClone(w), id: "work-2", mainSessionId: "session-2", owner: { kind: "session", ref: "session-2" } });
  for (let n = 1; n <= 2; n++) {
    initial.conversations.push({ sessionId: `session-${n}`, projectId: "project-1", workstreamId: `work-${n}`, sourceRevision: 0,
      relation: "main", purpose: "work", visibility: "project", readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true },
      returnPolicy: "delivery", archived: false, order: n });
    initial.authorizations.push({ id: `auth-${n}`, projectId: "project-1", workstreamId: `work-${n}`, actions: ["implement", "check"],
      resources: n === 1 ? ["/synthetic/allowed", "/synthetic/unused"] : ["/synthetic/other"], source: { kind: "user", ref: "explicit-local-scope" },
      permissionCeiling: "ask", maxRuns: 10, stopConditions: ["Stop at a required user decision"], revoked: false });
    initial.runs.push({ id: `prior-${n}`, projectId: "project-1", workstreamId: `work-${n}`, sessionId: `session-${n}`, executor: "agent-host",
      workstreamRevision: 0, decisionRevision: 0, authorizationId: `auth-${n}`, state: n === 1 ? "completed" : "executing", outcome: n === 1 ? checkpoint : "",
      effects: [{ id: "dispatch", action: "implement", resource: n === 1 ? "/synthetic/allowed" : "/synthetic/other", state: "confirmed",
        detail: JSON.stringify({ step: { action: "implement", resources: [n === 1 ? "/synthetic/allowed" : "/synthetic/other"], prompt: "Prior bounded step" }, deliveryIds: n === 1 ? ["side-result"] : [] }) }],
      startedAt: timestamp, updatedAt: timestamp });
  }
  initial.deliveries.push({ id: "side-result", projectId: "project-1", workstreamId: "work-1", sourceRunId: "side-run", kind: "result", summary: "Side work",
    artifactIds: [], sources: [{ kind: "run", ref: "side-run" }], decisionRevision: 0, state: "delivered", disposition: "pending", createdAt: timestamp });
  let state = structuredClone(initial), failKind, ids = 0;
  const seen = new Set(), commands = [], admissions = [], observations = [];
  const host = {
    snapshot: async () => structuredClone(state),
    async mutate(command) {
      assert.ok(shared.isProjectWorkflowCommand(command), `Invalid C0 command ${JSON.stringify(command)}`);
      commands.push(command);
      if (command.kind === failKind) { failKind = undefined; throw new Error("Synthetic Host interruption"); }
      if (seen.has(command.commandId)) return { snapshot: structuredClone(state), replayed: true };
      assert.equal(command.expectedRevision, state.revision);
      const w = state.workstreams.find((w) => w.id === (command.workstreamId ?? command.run?.workstreamId));
      switch (command.kind) {
        case "workstream.transition": Object.assign(w, { status: command.status, nextAction: command.nextAction, blocker: command.blocker, revision: w.revision + 1 }); break;
        case "run.observe": Object.assign(state.runs.find((r) => r.id === command.runId), { state: command.state, outcome: command.outcome, effects: command.effects, completionKey: command.completionKey }); break;
        case "delivery.publish": state.deliveries.push(command.delivery); break;
        case "delivery.consume": Object.assign(state.deliveries.find((d) => d.id === command.deliveryId), { state: "consumed", disposition: command.disposition }); break;
        case "run.start": state.runs.push(command.run); break;
        default: throw new Error(`Unexpected Host command ${command.kind}`);
      }
      seen.add(command.commandId); state.revision++;
      return { snapshot: structuredClone(state), replayed: false };
    },
  };
  let observeLater = async (run) => ({ state: "unknown", content: "Runtime outcome unknown", effects: [...run.effects,
    { id: "outcome", action: "implement", resource: "/synthetic/other", state: "unknown", detail: "Lost runtime history" }] });
  const execution = {
    async observe(run) {
      observations.push(run.id);
      if (run.id === "prior-1") return { state: "completed", content: checkpoint, effects: run.effects };
      if (run.id === "prior-2") return observeLater(run);
      return { state: "executing", content: "", effects: run.effects };
    },
    async start(input) { admissions.push(input); return { turnId: "successor-turn", queued: false }; },
    async createSession() { throw new Error("Recovery must reuse the existing session"); },
    async appendContext() {},
    async read() { throw new Error("Recovery must not create read-only work"); },
    async stop() { throw new Error("Recovery must not stop existing work"); },
  };
  const runtime = () => createProjectWorkflowRuntime({ host, execution, now: () => timestamp, id: () => `recovery-${++ids}` });
  return { host, runtime, commands, admissions, observations,
    observeLater(fn) { observeLater = fn; }, failOnce(kind) { failKind = kind; } };
}

for (const laterState of ["unknown", "executing"]) {
  test(`global recovery defers the exact successor until the later ${laterState} run is observed`, async () => {
    const f = setup(), runtime = f.runtime();
    let release, observed, previousAdmissions = 0;
    const pending = new Promise((resolve) => { release = resolve; });
    const reached = new Promise((resolve) => { observed = resolve; });
    f.observeLater(async (run) => {
      assert.equal(f.admissions.length, previousAdmissions, "early workstream must not admit before all observations");
      assert.ok((await f.host.snapshot()).runs[0].completionKey, "first checkpoint is durably settled before the next observation");
      observed(); await pending;
      return { state: laterState, content: laterState === "unknown" ? "Uncertain external effects" : "", effects: run.effects };
    });
    const recovery = runtime.recoverAll();
    await reached;
    assert.equal(f.admissions.length, 0);
    release(); await recovery;
    assert.equal(f.admissions.length, 1);
    const admission = f.admissions[0];
    assert.equal(admission.run.id, "workflow:prior-1:next");
    assert.equal(admission.authorization.id, "auth-1");
    assert.deepEqual(admission.run.effects.map((e) => e.resource), next.resources);
    assert.match(admission.content, /Run the accepted narrow check/);
    assert.doesNotMatch(admission.content, /Assignment:\nMust not replace/);
    const snapshot = await f.host.snapshot();
    assert.equal(snapshot.deliveries.find((d) => d.id === "side-result").disposition, "integrated");
    assert.equal(snapshot.runs.find((r) => r.id === "prior-2").state, laterState);
    previousAdmissions = 1;
    await runtime.recoverAll();
    assert.equal(f.admissions.length, 1, "unknown/active runs and the stable successor are never replayed");
    assert.equal((await f.host.snapshot()).deliveries.filter((d) => d.id === "prior-1:result").length, 1);
  });
}

for (const restart of [false, true]) {
  test(`recovery observation failure leaves dispatch disabled and retains exact retry continuation${restart ? " across runtime recreation" : ""}`, async () => {
    const f = setup();
    let runtime = f.runtime(), fail = true, previousAdmissions = 0;
    f.observeLater(async (run) => {
      if (fail) { fail = false; throw new Error("Synthetic observation unavailable"); }
      assert.equal(f.admissions.length, previousAdmissions);
      return { state: "unknown", content: "Uncertain external outcome", effects: run.effects };
    });
    await assert.rejects(runtime.recoverAll(), /Synthetic observation unavailable/);
    assert.equal(f.admissions.length, 0);
    assert.ok((await f.host.snapshot()).runs[0].completionKey);
    if (restart) runtime = f.runtime();
    await runtime.recoverAll();
    assert.equal(f.admissions.length, 1);
    assert.equal(f.admissions[0].run.id, "workflow:prior-1:next");
    assert.deepEqual(f.admissions[0].run.effects.map((e) => e.resource), next.resources);
    assert.equal(f.admissions[0].authorization.id, "auth-1");
    previousAdmissions = 1;
    await runtime.recoverAll();
    assert.equal(f.admissions.length, 1);
  });
}

test("a Host failure before checkpoint completion can be retried without admission or duplicate delivery", async () => {
  const f = setup(), runtime = f.runtime();
  f.failOnce("delivery.consume");
  await assert.rejects(runtime.recoverAll(), /Synthetic Host interruption/);
  assert.equal(f.admissions.length, 0);
  await runtime.recoverAll();
  assert.equal(f.admissions.length, 1);
  assert.equal((await f.host.snapshot()).deliveries.filter((d) => d.id === "prior-1:result").length, 1);
});
