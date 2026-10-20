#!/usr/bin/env node
/** Real Electron/Main/AgentHost/Rust workflow acceptance; only the loopback model is synthetic.
 * Usage: node scripts/e2e-project-workflow.mjs [--output /absolute/evidence-directory]
 * Requires the current worktree's built Desktop and Rust Host. Never deletes evidence.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repositoryRoot, resolveElectronBinary, assertDesktopBuild } from "./e2e/boot.mjs";
import { Host } from "./e2e/host.mjs";

const root = resolve(repositoryRoot());
assertDesktopBuild(root);
const outputFlag = process.argv.indexOf("--output");
const output = outputFlag < 0 ? await mkdtemp(join(tmpdir(), "pi-workflow-e2e-")) : resolve(process.argv[outputFlag + 1]);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(output, "state-"));
const home = join(scratch, "home"), data = join(scratch, "data"), workspace = join(scratch, "workspace");
for (const directory of [home, data, workspace, join(workspace, "main"), join(workspace, "side")]) await mkdir(directory, { recursive: true });
const canonicalWorkspace = await realpath(workspace);
const mainResource = join(canonicalWorkspace, "main"), sideResource = join(canonicalWorkspace, "side");
const sidePath = join(sideResource, "measurement.json"), candidatePath = join(mainResource, "candidate.txt");
const hostBinary = join(root, "target/debug/pi-desktop-host-core");
const requests = [], checkpoints = [], coverage = [];
let sequence = 0, log = "", fixtureFailure, heldMain, projectId, main, page, child;
const json = JSON.stringify;
const stamp = () => new Date().toISOString();
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(check, description, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fixtureFailure) throw fixtureFailure;
    const result = await check();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`Timed out: ${description}\n${log.slice(-4000)}`);
}
async function freePort() {
  const socket = createNetServer();
  await new Promise(done => socket.listen(0, "127.0.0.1", done));
  const port = socket.address().port;
  await new Promise(done => socket.close(done));
  return port;
}
function reply(res, model, content, tool) {
  const frame = (delta, finish_reason = null) => res.write(`data: ${json({ id: `workflow-${++sequence}`, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (tool) frame({ role: "assistant", tool_calls: [{ index: 0, id: tool.id, type: "function", function: { name: tool.name, arguments: json(tool.args) } }] });
  else frame({ role: "assistant", content });
  frame({}, tool ? "tool_calls" : "stop");
  res.end("data: [DONE]\n\n");
}
const checkpoint = (summary, fields = {}) => {
  const value = { summary, stop: false, artifacts: [], evidence: [], consumedDeliveryIds: [], ...fields };
  checkpoints.push(value);
  return "```project-workflow-checkpoint\n" + json(value) + "\n```";
};
function artifact(runId, id, kind, entryPoint, revision) {
  return { id, projectId, workstreamId: "work-main", label: id, kind, revision, environment: "loopback-synthetic-model", entryPoint, source: { kind: "run", ref: runId }, createdAt: stamp() };
}
const model = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(json({ object: "list", data: [{ id: "workflow-fixture", object: "model", owned_by: "local-fixture" }] }));
      return;
    }
    assert.equal(req.url, "/v1/chat/completions", "fixture accepts only the intended local model route");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const index = body.messages.findLastIndex(message => message.role === "user");
    const input = body.messages[index].content;
    const prompt = typeof input === "string" ? input : input.filter(part => part.type === "text").map(part => part.text).join("\n");
    const tail = body.messages.slice(index + 1);
    const toolResults = tail.filter(message => message.role === "tool");
    const runId = prompt.match(/Run identity: ([^\n]+)/)?.[1];
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (!runId) {
      reply(res, body.model, prompt.includes("EXPLORE_MARKER") ? checkpoint("EXPLORE_PROPOSAL: Prefer measured value 42.") : "ASK_ONLY_MARKER: A local explanation; no project changes.");
      return;
    }
    const invokeTool = (id, name, args) => {
      if (!body.tools?.some(tool => tool.function?.name === name)) {
        reply(res, body.model, null, { id: `discover-${id}`, name: "ToolSearch", args: { query: name } });
      } else reply(res, body.model, null, { id, name, args });
    };
    if (prompt.includes("SIDE_MEASURE")) {
      if (!toolResults.some(result => result.tool_call_id === "side-write")) {
        invokeTool("side-write", "Bash", { command: `printf '%s' '{"measurement":42,"environment":"synthetic-local"}' > ${json(sidePath)}` });
      } else {
        assert.equal(JSON.parse(await readFile(sidePath, "utf8")).measurement, 42);
        reply(res, body.model, checkpoint("Side measurement produced", { artifacts: [artifact(runId, "side-artifact", "report", sidePath, "side-r1")] }));
      }
    } else if (prompt.includes("CHECK_INTEGRATE")) {
      if (!toolResults.some(result => result.tool_call_id === "read-side")) {
        invokeTool("read-side", "Read", { path: sidePath });
      } else if (!toolResults.some(result => result.tool_call_id === "write-candidate")) {
        assert.match(json(toolResults.find(result => result.tool_call_id === "read-side")), /measurement.*42/, "actual Read result reaches the model");
        invokeTool("write-candidate", "Bash", { command: `printf '%s' 'Integrated measurement: 42' > ${json(candidatePath)}` });
      } else {
        assert.equal(await readFile(candidatePath, "utf8"), "Integrated measurement: 42");
        const deliveryText = prompt.split("Results to consume:\n")[1]?.split("\nRun identity:")[0];
        const delivered = JSON.parse(deliveryText).find(delivery => delivery.artifactIds.includes("side-artifact"));
        assert.ok(delivered, "side output is an actual delivered record");
        reply(res, body.model, checkpoint("Read side measurement and integrated 42 into the candidate", {
          artifacts: [artifact(runId, "candidate-1", "candidate", candidatePath, "candidate-r1")], consumedDeliveryIds: [delivered.id],
          next: { action: "document", resources: [mainResource], prompt: "DOCUMENT_FINAL: Record local verification and wait for user acceptance." },
        }));
      }
    } else if (prompt.includes("DOCUMENT_FINAL")) {
      reply(res, body.model, checkpoint("Documented local candidate; user acceptance remains pending", { evidence: [{ id: "evidence-1", projectId, workstreamId: "work-main", candidateId: "candidate-1", candidateRevision: "candidate-r1", environment: "loopback-synthetic-model", scenario: "read-delivered-measurement", acceptanceId: "acceptance-1", outcome: "passed", kind: "integration", limits: "Local synthetic model and filesystem only; no real account or deployment", source: { kind: "run", ref: runId }, createdAt: stamp() }] }));
    } else if (prompt.includes("HOLD_FOR_CANCEL")) {
      res.write(": held bounded work\n\n");
    } else {
      assert.match(prompt, /EFFECTIVE_DECISION_MARKER/, "main execution has adopted decision context");
      assert.ok(!prompt.includes("UNADOPTED_PROPOSAL_MARKER"), "pending proposal is excluded from execution");
      assert.ok(!heldMain, "one initial main request");
      heldMain = () => reply(res, body.model, checkpoint("Initial implementation checkpoint", { next: { action: "check", resources: [mainResource], prompt: "CHECK_INTEGRATE: Read the side measurement and produce the candidate." } }));
      res.write(": waiting for independent side delivery\n\n");
    }
  } catch (error) {
    fixtureFailure = error;
    if (!res.headersSent) res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise((done, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", done); });
async function connect(port, type) {
  const target = await until(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === type && (type !== "page" || item.url.includes("/out/renderer/index.html") && !item.url.includes("surface="))); }
    catch { return null; }
  }, `CDP ${type}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl), pending = new Map();
  await new Promise(done => ws.addEventListener("open", done, { once: true }));
  ws.addEventListener("message", ({ data }) => {
    const packet = JSON.parse(String(data)), entry = pending.get(packet.id);
    if (entry) { clearTimeout(entry.timer); pending.delete(packet.id); packet.error ? entry.reject(new Error(json(packet.error))) : entry.resolve(packet.result); }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); ws.send(json({ id, method, params }));
  });
  return { ws, call, evaluate: async expression => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(json(result.exceptionDetails));
    return result.result.value;
  } };
}
async function stopApp() {
  main?.ws.close(); page?.ws.close(); main = page = undefined;
  if (!child || child.exitCode !== null) return;
  const current = child, exited = new Promise(done => current.once("exit", done));
  const signal = value => { try { process.kill(-current.pid, value); } catch (error) { if (error.code !== "ESRCH") throw error; } };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 5000);
  await exited; clearTimeout(timer);
}
async function startApp() {
  const ports = [await freePort(), await freePort()];
  const env = { ...process.env, HOME: home, PI_DESKTOP_DATA_DIR: data, PI_DESKTOP_HOST_BIN: hostBinary,
    PI_DESKTOP_PLAN_UI_PROBE: "1", PI_DESKTOP_TEST_API_KEY: "local-fixture", PI_DESKTOP_TEST_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, PI_DESKTOP_TEST_MODEL: "workflow-fixture", ELECTRON_RENDERER_URL: "", PI_DESKTOP_START_MAXIMIZED: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const electronBinary = process.env.PI_DESKTOP_E2E_ELECTRON_BIN || resolveElectronBinary(root).electronBinary;
  child = spawn(electronBinary, [`--remote-debugging-port=${ports[0]}`, `--inspect=${ports[1]}`, `--user-data-dir=${join(scratch, "profile")}`, "."], { cwd: join(root, "apps/desktop"), env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout.on("data", chunk => { log += chunk; }); child.stderr.on("data", chunk => { log += chunk; });
  main = await connect(ports[1], "node"); page = await connect(ports[0], "page");
  await until(() => page.evaluate("!!window.piDesktop && !!window.__PI_DESKTOP__"), "renderer and public preload");
  await until(() => main.evaluate("typeof globalThis.__PI_DESKTOP_PLAN_UI_PROBE === 'function'"), "main setup probe");
}
const invoke = async (key, ...args) => {
  const result = await page.evaluate(`piDesktop.invoke(piDesktop.channels.invoke[${json(key)}],...${json(args)})`);
  assert.equal(result.ok, true, `${key}: ${json(result)}`);
  return result.data;
};
const snapshot = () => invoke("projectWorkflowSnapshot", { projectId });
const mutate = async (kind, fields) => invoke("projectWorkflowMutate", { kind, commandId: `e2e-mutation-${++sequence}`, expectedRevision: (await snapshot()).revision, ...fields });
const action = async (kind, fields = {}, workstreamId = "work-main") => invoke("projectWorkflowAction", { kind, commandId: `e2e-action-${++sequence}`, expectedRevision: (await snapshot()).revision, projectId, workstreamId, ...fields });
const workstream = (id, sessionId, goal) => ({ id, projectId, title: id, goal, acceptance: [{ id: "acceptance-1", title: "Measured candidate", status: "pending", evidenceIds: [] }], owner: { kind: "session", ref: sessionId }, status: "ready", priority: 0, order: 0, dependencyIds: [], nextAction: goal, revision: 0, decisionRevision: 0, createdAt: stamp(), updatedAt: stamp() });
const grant = (id, workstreamId, resources) => mutate("authorization.grant", { authorization: { id, projectId, workstreamId, actions: ["implement", "check", "document"], resources, source: { kind: "user", ref: "explicit-isolated-e2e-authorization" }, permissionCeiling: "auto", maxRuns: 8, stopConditions: [], revoked: false } });
let lastSnapshot;
try {
  const seed = new Host(hostBinary, data, { env: { HOME: home }, quiet: true });
  try { await seed.start(); projectId = (await seed.call("project.group.create", { name: "Production Workflow E2E", folders: [canonicalWorkspace] })).group.id; }
  finally { await seed.stop(); }
  await startApp();
  const setup = await main.evaluate(`globalThis.__PI_DESKTOP_PLAN_UI_PROBE({operation:'liveSetup',workspace:${json(canonicalWorkspace)}})`);
  assert.equal(setup.ok, true, json(setup));
  await invoke("sessionConfigure", setup.sessionId, { mode: "agent", providerId: setup.providerId, modelId: setup.modelId, thinkingLevel: "off", permissionMode: "auto" });
  await page.evaluate(`window.__PI_DESKTOP__.refreshProviders().then(()=>window.__PI_DESKTOP__.selectSession(${json(setup.sessionId)}))`);
  await mutate("workstream.create", { workstream: workstream("work-main", setup.sessionId, "IMPLEMENT_MAIN: Produce a measured candidate using the independent side output.") });
  for (const [id, statement] of [["effective", "EFFECTIVE_DECISION_MARKER: Use the measured value."], ["pending", "UNADOPTED_PROPOSAL_MARKER: Do not execute this proposal."]]) {
    await mutate("decision.propose", { decision: { id, projectId, workstreamId: "work-main", title: id, statement, state: "proposed", sources: [{ kind: "user", ref: "fixture-user" }], createdAt: stamp() } });
  }
  await mutate("decision.resolve", { projectId, workstreamId: "work-main", decisionId: "effective", resolution: "adopt", source: { kind: "user", ref: "fixture-user" } });
  await grant("auth-main", "work-main", [mainResource]); await grant("auth-side", "work-main", [sideResource]);
  await action("start", { sessionId: setup.sessionId, authorizationId: "auth-main" });
  await until(() => heldMain, "initial real model request");
  const side = await action("side.create", { purpose: "work", visibility: "side_only", sourceSessionId: setup.sessionId, readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true }, task: "SIDE_MEASURE: Write a local JSON measurement 42.", authorizationId: "auth-side" });
  assert.notEqual(side.sessionId, setup.sessionId);
  await until(async () => (await snapshot()).deliveries.some(delivery => delivery.artifactIds.includes("side-artifact") && delivery.state === "delivered"), "side artifact actually delivered");
  heldMain();
  lastSnapshot = await until(async () => { const state = await snapshot(); return state.workstreams.find(work => work.id === "work-main")?.status === "awaiting_user" && state.evidence.length === 1 ? state : null; }, "implement → check → document → awaiting user");
  assert.equal(await readFile(candidatePath, "utf8"), "Integrated measurement: 42");
  assert.equal(lastSnapshot.runs.length, 4); assert.ok(lastSnapshot.runs.every(run => run.state === "completed" && run.completionKey));
  assert.equal(lastSnapshot.deliveries.find(delivery => delivery.artifactIds.includes("side-artifact")).state, "consumed");
  assert.equal(lastSnapshot.artifacts.find(item => item.id === "candidate-1").revision, "candidate-r1");
  assert.equal(lastSnapshot.evidence[0].candidateRevision, "candidate-r1");
  assert.equal(lastSnapshot.workstreams[0].acceptance[0].status, "pending");
  coverage.push("Real Main/AgentHost/Rust execution; disjoint parallel side Work; actual Bash/Read tools; delivery consumption; automatic implement/check/document; current candidate and evidence revisions; pending user acceptance");
  const runCount = lastSnapshot.runs.length, decisionRevision = lastSnapshot.workstreams[0].decisionRevision;
  for (const purpose of ["ask", "explore"]) {
    const result = await action("side.create", { purpose, visibility: purpose === "ask" ? "side_only" : "project", sourceSessionId: setup.sessionId, readContext: { selection: purpose === "ask" ? "ASK_ONLY_MARKER" : "EXPLORE_MARKER", resourceIds: [], includeDecisions: true, includeArtifacts: true }, task: purpose === "ask" ? "ASK_ONLY_MARKER: Explain only." : "EXPLORE_MARKER: Propose an alternative only." });
    await until(async () => { const detail = await invoke("sessionGet", { id: result.sessionId }); return detail.session.messages.some(message => message.role === "assistant" && message.content?.includes(purpose === "ask" ? "ASK_ONLY_MARKER:" : "EXPLORE_PROPOSAL:")); }, `${purpose} terminal output`);
    const state = await snapshot(); assert.equal(state.runs.length, runCount); assert.equal(state.workstreams[0].decisionRevision, decisionRevision);
    if (purpose === "ask") {
      const request = requests.find(request => json(request.messages.at(-1)?.content).includes("ASK_ONLY_MARKER"));
      assert.ok(request, "Ask reached the real provider");
      assert.ok(!json(request.messages).includes("EFFECTIVE_DECISION_MARKER"), "Ask receives selected explanation context rather than project execution decisions");
    } else {
      const proposalId = `explore:${result.sessionId}:conclusion`;
      await until(async () => (await snapshot()).decisions.some(decision => decision.id === proposalId && decision.state === "proposed"), "Explore result is a durable proposal, not effective authority");
      await action("adopt", { decisionId: proposalId, source: { kind: "user", ref: "explicit-e2e-adoption" } });
      const adopted = await snapshot();
      assert.equal(adopted.decisions.find(decision => decision.id === proposalId).state, "effective");
      assert.equal(adopted.workstreams[0].decisionRevision, decisionRevision + 1);
      assert.equal(adopted.runs.length, runCount, "adoption at awaiting-user boundary does not silently authorize execution");
    }
  }
  coverage.push("Ask/Explore real Plan sessions; Ask context isolation; Explore durable proposal and explicit sourced adoption without implicit execution");
  await mutate("feedback.add", { feedback: { id: "feedback-1", projectId, workstreamId: "work-main", candidateId: "candidate-1", candidateRevision: "candidate-r1", environment: "loopback-synthetic-model", acceptanceId: "acceptance-1", comment: "Request a separately authorized improvement", source: { kind: "user", ref: "fixture-user" }, createdAt: stamp() } });
  lastSnapshot = await snapshot(); assert.equal(lastSnapshot.feedback[0].candidateRevision, "candidate-r1");
  const countBeforeRestart = requests.length;
  await writeFile(join(output, "before-restart.json"), json(lastSnapshot, null, 2));
  await stopApp(); await startApp();
  lastSnapshot = await snapshot();
  assert.equal(lastSnapshot.runs.length, runCount); assert.equal(lastSnapshot.artifacts.find(item => item.id === "candidate-1").revision, "candidate-r1");
  assert.equal(lastSnapshot.feedback[0].candidateRevision, "candidate-r1");
  await sleep(1200); assert.equal(requests.length, countBeforeRestart, "completed run recovery sends no model request");
  coverage.push("Actual app/profile restart preserves candidate/evidence/feedback and does not replay completed work");
  const shot = await page.call("Page.captureScreenshot", { format: "png" });
  await writeFile(join(output, "production-renderer.png"), Buffer.from(shot.data, "base64"));
  await writeFile(join(output, "result.json"), json({ ok: true, output, scratch, projectId, coverage, gaps: ["B Project Console DOM/visual interactions are a separate final integration check", "Pause/cancel and ambiguous crash recovery are not exercised by this harness", "No live account or deployment"], modelRequests: requests.length }, null, 2));
  console.log(`PASS production workflow ${output}`);
} catch (error) {
  const diagnostics = [];
  if (page) {
    try {
      lastSnapshot = await snapshot();
      for (const sessionId of new Set(lastSnapshot.conversations.map(link => link.sessionId))) {
        await writeFile(join(output, `session-${sessionId}.json`), json(await invoke("sessionGet", { id: sessionId }), null, 2));
      }
      const shot = await page.call("Page.captureScreenshot", { format: "png" });
      await writeFile(join(output, "failure-renderer.png"), Buffer.from(shot.data, "base64"));
    } catch (diagnosticError) { diagnostics.push(diagnosticError.message); }
  }
  await writeFile(join(output, "failure.json"), json({ message: error.message, stack: error.stack, scratch, projectId, coverage, diagnostics }, null, 2));
  console.error(`FAIL production workflow; evidence retained: ${output}`); throw error;
} finally {
  await writeFile(join(output, "electron.log"), log);
  await writeFile(join(output, "model-requests.json"), json(requests, null, 2));
  await writeFile(join(output, "model-checkpoints.json"), json(checkpoints, null, 2));
  if (lastSnapshot) await writeFile(join(output, "snapshot.json"), json(lastSnapshot, null, 2));
  await stopApp(); model.closeAllConnections(); await new Promise(done => model.close(done));
}
