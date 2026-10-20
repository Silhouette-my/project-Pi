#!/usr/bin/env node
/** Real Electron/Main/AgentHost/Rust workflow acceptance; only the loopback model is synthetic.
 * Usage: node scripts/e2e-project-workflow.mjs --built-commit <build-source-commit> [--output /absolute/evidence-directory]
 * Requires the current worktree's built Desktop and Rust Host. Never deletes evidence.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, realpath, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repositoryRoot, resolveElectronBinary, assertDesktopBuild } from "./e2e/boot.mjs";
import { Host } from "./e2e/host.mjs";

const root = resolve(repositoryRoot());
assertDesktopBuild(root);
const outputFlag = process.argv.indexOf("--output");
const builtFlag = process.argv.indexOf("--built-commit");
assert.ok(builtFlag >= 0 && process.argv[builtFlag + 1], "--built-commit must name the exact source commit used for the existing build");
const builtCommit = process.argv[builtFlag + 1];
const output = outputFlag < 0 ? await mkdtemp(join(tmpdir(), "pi-workflow-e2e-")) : resolve(process.argv[outputFlag + 1]);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(output, "state-"));
const home = join(scratch, "home"), data = join(scratch, "data"), workspace = join(scratch, "workspace");
for (const directory of [home, data, workspace, join(workspace, "main"), join(workspace, "side")]) await mkdir(directory, { recursive: true });
const canonicalWorkspace = await realpath(workspace);
const mainResource = join(canonicalWorkspace, "main"), sideResource = join(canonicalWorkspace, "side");
const sidePath = join(sideResource, "measurement.json"), candidatePath = join(mainResource, "candidate.txt");
const json = JSON.stringify;
const shellResource = join(canonicalWorkspace, "work-shell");
const shellBuildCommand = `printf 'build\\n' >> ${json(join(shellResource, "build.log"))}; printf 'candidate-v1' > ${json(join(shellResource, "candidate.txt"))}`;
const shellCheckCommand = `if grep -q 'candidate-v2' ${json(join(shellResource, "candidate.txt"))}; then printf 'check-passed\\n'; else printf 'check-failed\\n'; exit 1; fi`;
const shellRecheckCommand = `grep -q 'candidate-v2' ${json(join(shellResource, "candidate.txt"))} && printf 'check-passed\\n'`;
const shellDeniedCommand = `printf 'unsafe' > ${json(join(canonicalWorkspace, "unsafe-bash.txt"))}`;
const pendingCommand = key => `printf '${key}\\n' >> ${json(join(canonicalWorkspace, `pending-${key}.txt`))}`;
const hostBinary = join(root, "target/debug/pi-desktop-host-core");
const requests = [], checkpoints = [], coverage = [], conflictRefreshes = [];
const held = new Map(), runRequests = new Map();
let sequence = 0, log = "", fixtureFailure, heldMain, projectId, main, page, child;
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
function hold(res, model, key, partial = "") {
  if (partial) res.write(`data: ${json({ id: `workflow-${++sequence}`, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: partial }, finish_reason: null }] })}\n\n`);
  else res.write(": bounded work remains active\n\n");
  held.set(key, () => {
    if (!partial) return reply(res, model, checkpoint(`Completed ${key}`));
    res.write(`data: ${json({ id: `workflow-${++sequence}`, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
}
async function absent(path) {
  try { await access(path); return false; } catch (error) { if (error.code === "ENOENT") return true; throw error; }
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
      reply(res, body.model, prompt.includes("ADOPT_EXPLORE") ? checkpoint("NEW_DECISION_MARKER: Use the newly adopted bounded decision.") : prompt.includes("DISCUSSION_MARKER") ? "DISCUSSION_MARKER: Work remains independent while discussing." : prompt.includes("EXPLORE_MARKER") ? checkpoint("EXPLORE_PROPOSAL: Prefer measured value 42.") : "ASK_ONLY_MARKER: A local explanation; no project changes.");
      return;
    }
    runRequests.set(runId, (runRequests.get(runId) ?? 0) + 1);
    const invokeTool = (id, name, args) => {
      if (!body.tools?.some(tool => tool.function?.name === name)) {
        reply(res, body.model, null, { id: `discover-${id}`, name: "ToolSearch", args: { query: name } });
      } else reply(res, body.model, null, { id, name, args });
    };
    if (prompt.includes("SHELL_PENDING_PAUSE") || prompt.includes("SHELL_PENDING_CANCEL")) {
      const key = prompt.includes("SHELL_PENDING_PAUSE") ? "pause" : "cancel";
      const toolId = `pending-shell-${key}-${runId}`;
      if (toolResults.some(result => result.tool_call_id === toolId)) {
        assert.equal(key, "pause", "a cancelled pending command must never execute");
        assert.equal(await readFile(join(canonicalWorkspace, "pending-pause.txt"), "utf8"), "pause\n", "fresh Resume approval executes exactly once");
        reply(res, body.model, checkpoint("Resumed the same bounded assignment with fresh Shell approval; executed exactly once"));
      } else {
        assert.equal(runRequests.get(runId), 1, "a revoked pending shell approval never retries the model");
        reply(res, body.model, null, { id: toolId, name: "Bash", args: { command: pendingCommand(key) } });
      }
    } else if (prompt.includes("SHELL_PIPELINE")) {
      if (prompt.includes("SHELL_DOCUMENT_STEP")) {
        if (!toolResults.some(result => result.tool_call_id === "shell-document")) invokeTool("shell-document", "Write", { path: join(shellResource, "report.md"), content: "Build executed once. Check observed candidate-v1 failure. Typed fix produced candidate-v2. User acceptance pending." });
        else reply(res, body.model, checkpoint("Documented the actual build/check/fix sequence; user review needed"));
      } else if (prompt.includes("SHELL_RECHECK_STEP")) {
        if (!toolResults.some(result => result.tool_call_id === "shell-recheck")) reply(res, body.model, null, { id: "shell-recheck", name: "Bash", args: { command: shellRecheckCommand } });
        else {
          const result = JSON.parse(toolResults.find(result => result.tool_call_id === "shell-recheck").content);
          assert.equal(result.exitCode, 0, "actual corrected candidate check exits zero");
          assert.match(result.stdout, /check-passed/);
          reply(res, body.model, checkpoint("Actual recheck passed after the bounded fix", { next: { action: "document", resources: [shellResource], prompt: "SHELL_DOCUMENT_STEP: Document actual failing and passing checks plus the fix." } }));
        }
      } else if (prompt.includes("SHELL_FIX_STEP")) {
        if (!toolResults.some(result => result.tool_call_id === "shell-fix")) invokeTool("shell-fix", "Write", { path: join(shellResource, "candidate.txt"), content: "candidate-v2" });
        else reply(res, body.model, checkpoint("Fixed the observed candidate-v1 check failure", { next: { action: "check", resources: [shellResource], prompt: "SHELL_RECHECK_STEP: Run the actual check against the corrected candidate." } }));
      } else if (prompt.includes("SHELL_CHECK_STEP")) {
        if (!toolResults.some(result => result.tool_call_id === "shell-check")) reply(res, body.model, null, { id: "shell-check", name: "Bash", args: { command: shellCheckCommand } });
        else {
          const result = JSON.parse(toolResults.find(result => result.tool_call_id === "shell-check").content);
          assert.equal(result.exitCode, 1, "the real failed check has integer nonzero exit status");
          assert.match(result.stdout, /check-failed/, "real shell check observes the unfixed candidate");
          reply(res, body.model, checkpoint("Actual check found candidate-v1; bounded fix required", { next: { action: "implement", resources: [shellResource], prompt: "SHELL_FIX_STEP: Fix the actual failed candidate using typed Write." } }));
        }
      } else if (!toolResults.some(result => result.tool_call_id === "shell-build")) reply(res, body.model, null, { id: "shell-build", name: "Bash", args: { command: shellBuildCommand } });
      else reply(res, body.model, checkpoint("Actual shell build produced candidate-v1", { next: { action: "check", resources: [shellResource], prompt: "SHELL_CHECK_STEP: Check the actual built candidate." } }));
    } else if (prompt.includes("DENY_OUTSIDE") || prompt.includes("DENY_BASH")) {
      assert.equal(runRequests.get(runId), 1, "a scope denial terminates the bounded turn without a model retry");
      const bash = prompt.includes("DENY_BASH");
      reply(res, body.model, null, { id: bash ? "denied-bash" : "denied-outside", name: bash ? "Bash" : "Write", args: bash ? { command: shellDeniedCommand } : { path: join(canonicalWorkspace, "outside-grant.txt"), content: "not-authorized" } });
    } else if (prompt.includes("ADOPT_MAIN")) {
      if (prompt.includes('"statement": "NEW_DECISION_MARKER:')) {
        reply(res, body.model, checkpoint("Adopted context reached authorized continuation at a safe boundary"));
      } else {
        const staleArtifact = { ...artifact(runId, "must-not-be-current", "candidate", join(canonicalWorkspace, "adopt", "stale.txt"), "stale-r1"), workstreamId: "work-adopt" };
        hold(res, body.model, "adopt-old", checkpoint("Old decision partial candidate must be fenced", { artifacts: [staleArtifact] }));
      }
    } else if (prompt.includes("HOLD_SURVIVOR")) {
      hold(res, body.model, "survivor");
    } else if (prompt.includes("HOLD_PAUSE")) {
      hold(res, body.model, "pause");
    } else if (prompt.includes("HOLD_CANCEL")) {
      hold(res, body.model, "cancel");
    } else if (prompt.includes("SIDE_MEASURE")) {
      if (!toolResults.some(result => result.tool_call_id === "side-write")) {
        invokeTool("side-write", "Write", { path: sidePath, content: '{"measurement":42,"environment":"synthetic-local"}' });
      } else {
        assert.equal(JSON.parse(await readFile(sidePath, "utf8")).measurement, 42);
        reply(res, body.model, checkpoint("Side measurement produced", { artifacts: [artifact(runId, "side-artifact", "report", sidePath, "side-r1")] }));
      }
    } else if (prompt.includes("CHECK_INTEGRATE")) {
      if (!toolResults.some(result => result.tool_call_id === "read-side")) {
        invokeTool("read-side", "Read", { path: sidePath });
      } else if (!toolResults.some(result => result.tool_call_id === "write-candidate")) {
        assert.match(json(toolResults.find(result => result.tool_call_id === "read-side")), /measurement.*42/, "actual Read result reaches the model");
        invokeTool("write-candidate", "Write", { path: candidatePath, content: "Integrated measurement: 42" });
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
  await observePermissions();
}
async function observePermissions() {
  await page.evaluate("window.__workflowPermissionEvents = []; window.piDesktop.on(window.piDesktop.channels.event.agentMessage, envelope => { if (envelope.event?.type === 'tool_permission_request') window.__workflowPermissionEvents.push(envelope); });");
}
async function reloadRenderer() {
  await page.call("Page.enable", {});
  const loaded = new Promise((done, reject) => {
    const timer = setTimeout(() => { page.ws.removeEventListener("message", listener); reject(new Error("Renderer reload did not finish")); }, 30000);
    function listener({ data }) {
      if (JSON.parse(String(data)).method !== "Page.loadEventFired") return;
      clearTimeout(timer); page.ws.removeEventListener("message", listener); done();
    }
    page.ws.addEventListener("message", listener);
  });
  await page.call("Page.reload", { ignoreCache: true });
  await loaded;
  await until(() => page.evaluate("!!window.piDesktop && !!window.__PI_DESKTOP__"), "normal reloaded renderer startup");
  await observePermissions();
}
const invoke = async (key, ...args) => {
  const result = await page.evaluate(`piDesktop.invoke(piDesktop.channels.invoke[${json(key)}],...${json(args)})`);
  assert.equal(result.ok, true, `${key}: ${json(result)}`);
  return result.data;
};
const snapshot = () => invoke("projectWorkflowSnapshot", { projectId });
async function workflowWrite(channel, kind, fields) {
  // A background terminal receipt may advance the global CAS between the user
  // snapshot and intent. Only an explicit pre-admission conflict is refreshed;
  // model/tool failures and admitted commands are never retried here.
  for (let attempt = 0; attempt < 4; attempt++) {
    const expectedRevision = (await snapshot()).revision;
    const command = { kind, commandId: `e2e-${channel}-${++sequence}`, expectedRevision, ...fields };
    const result = await page.evaluate(`piDesktop.invoke(piDesktop.channels.invoke[${json(channel)}],${json(command)})`);
    if (result.ok) return result.data;
    assert.equal(result.error?.code, "CONFLICT", `${channel}: ${json(result)}`);
    const actualRevision = (await snapshot()).revision;
    assert.notEqual(actualRevision, expectedRevision, "refresh only a genuinely changed authoritative revision");
    conflictRefreshes.push({ channel, kind, expectedRevision, actualRevision });
  }
  throw new Error(`Repeated pre-admission CAS conflicts: ${channel}/${kind}`);
}
const mutate = (kind, fields) => workflowWrite("projectWorkflowMutate", kind, fields);
const action = (kind, fields = {}, workstreamId = "work-main") => workflowWrite("projectWorkflowAction", kind, { projectId, workstreamId, ...fields });
const workstream = (id, sessionId, goal) => ({ id, projectId, title: id, goal, acceptance: [{ id: "acceptance-1", title: "Measured candidate", status: "pending", evidenceIds: [] }], owner: { kind: "session", ref: sessionId }, status: "ready", priority: 0, order: 0, dependencyIds: [], nextAction: goal, revision: 0, decisionRevision: 0, createdAt: stamp(), updatedAt: stamp() });
const grant = (id, workstreamId, resources) => mutate("authorization.grant", { authorization: { id, projectId, workstreamId, actions: ["implement", "check", "document"], resources, source: { kind: "user", ref: "explicit-isolated-e2e-authorization" }, permissionCeiling: "auto", maxRuns: 8, stopConditions: [], revoked: false } });
const seenApprovalIds = new Set();
async function shellApproval(sessionId, command, label) {
  const permission = await until(() => page.evaluate(`window.__workflowPermissionEvents.filter(envelope => envelope.sessionId === ${json(sessionId)}).map(envelope => envelope.event.request).find(request => request.argsPreview?.command === ${json(command)} && !${json([...seenApprovalIds])}.includes(request.requestId))`), `${label} real permissions.request`);
  assert.equal(permission.approvalScope, "workflow-shell");
  assert.equal(permission.argsPreview.command, command, "Host preserves the full exact command for review");
  seenApprovalIds.add(permission.requestId);
  const detail = await invoke("sessionGet", { id: sessionId });
  await page.evaluate(`window.__PI_DESKTOP__.setPage('chat'); window.__PI_DESKTOP__.selectSession(${json(sessionId)})`);
  await until(() => page.evaluate(`document.querySelector('.ct-title')?.textContent === ${json(detail.session.title)} && document.querySelector('.permission-card-meta span')?.title === ${json(canonicalWorkspace)}`), `${label} loaded session title and project metadata`);
  const card = await until(() => page.evaluate(`(() => { const card = document.querySelector('.permission-card'); if (!card || !card.querySelector('.permission-card-args')?.textContent.includes(${json(command)})) return null; return { text: card.textContent, command: card.querySelector('.permission-card-args')?.textContent, warning: card.querySelector('[role="note"]')?.textContent, buttons: [...card.querySelectorAll('.permission-card-actions button')].map(button => button.textContent) }; })()`), `${label} actual permission card`);
  assert.ok(card.command.includes(command), "the actual card renders the entire exact command");
  assert.ok(card.warning && /separate approval|单独批准|個別核准/.test(card.warning), `independent Shell approval warning is visible: ${json(card)}`);
  assert.equal(card.buttons.length, 2, "workflow Shell offers deny and allow-once only, never a session grant");
  assert.ok(card.buttons.every(text => !/session|会话|工作階段/i.test(text)));
  await writeFile(join(output, `${label}-approval.json`), json({ permission, card }, null, 2));
  const screenshot = await page.call("Page.captureScreenshot", { format: "png" });
  await writeFile(join(output, `${label}-approval.png`), Buffer.from(screenshot.data, "base64"));
  return permission;
}
async function clickShellDecision(allow) {
  await page.evaluate(`document.querySelectorAll('.permission-card-actions button')[${allow ? 1 : 0}].click()`);
}
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
  coverage.push("Real Main/AgentHost/Rust execution; disjoint parallel side Work; actual Write/Read tools; delivery consumption; automatic implement/check/document; current candidate and evidence revisions; pending user acceptance");
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
  const createWork = async (id, goal) => {
    const created = await invoke("sessionCreate", { title: id, mode: "agent", providerId: setup.providerId, modelId: setup.modelId, projectPath: canonicalWorkspace, permissionMode: "auto" });
    const sessionId = created.session.id, resource = join(canonicalWorkspace, id);
    await invoke("sessionConfigure", sessionId, { mode: "agent", permissionMode: "auto" });
    assert.equal((await invoke("sessionGet", { id: sessionId })).session.permissionMode, "auto", "the boundary scenario uses an actual auto-permission session");
    // Direct setup IPC does not perform the normal UI store insertion. A real
    // renderer reload reads the authoritative session list without injecting it.
    await reloadRenderer();
    await mkdir(resource);
    await mutate("workstream.create", { workstream: workstream(id, sessionId, goal) });
    await grant(`auth-${id}`, id, [resource]);
    return { sessionId, resource, start: () => action("start", { sessionId, authorizationId: `auth-${id}` }, id) };
  };
  const runsFor = (state, id) => state.runs.filter(run => run.workstreamId === id);
  const active = run => ["queued", "executing"].includes(run.state);
  for (const [id, marker, forbiddenFile] of [["deny-outside", "DENY_OUTSIDE", "outside-grant.txt"], ["deny-bash", "DENY_BASH", "unsafe-bash.txt"]]) {
    const denied = await createWork(id, `${marker}: Attempt only the deliberately forbidden operation; Host must terminate it.`);
    const started = await denied.start();
    if (marker === "DENY_BASH") {
      await shellApproval(denied.sessionId, shellDeniedCommand, "shell-denied");
      assert.equal(await absent(join(canonicalWorkspace, forbiddenFile)), true, "pending Shell approval has no effect before a user decision");
      await clickShellDecision(false);
    }
    const state = await until(async () => { const state = await snapshot(); return runsFor(state, id).some(run => !active(run) && run.completionKey) ? state : null; }, `${marker} boundary terminal receipt`);
    const run = runsFor(state, id)[0];
    assert.ok(["failed", "interrupted", "cancelled"].includes(run.state), `scope denial must be a failed/stopped turn, not successful completion: ${json(run)}`);
    assert.equal(runRequests.get(started.runId), 1, "denial makes one model request and no retry");
    assert.equal(await absent(join(canonicalWorkspace, forbiddenFile)), true, "denied mutation has no filesystem effect");
    const detail = await invoke("sessionGet", { id: denied.sessionId });
    if (marker === "DENY_OUTSIDE") assert.match(json(detail.session.messages), /WORKFLOW_RESOURCE_DENIED/, "actual Host boundary error is visible in the transcript");
    else assert.ok(detail.session.messages.some(message => message.toolName === "Bash" && (message.toolStatus === "denied" || message.toolResult?.isError)), "the declined actual Shell command is recorded as denied/error");
  }
  coverage.push("Actual Host contains out-of-grant Write; auto-session Shell requires a real independent permission card and explicit denial; no file effect, one model request and terminal boundary stop");

  const shell = await createWork("work-shell", "SHELL_PIPELINE: Execute the local build and check only after independent approvals, fix the observed failure and document.");
  await shell.start();
  const firstShellApproval = await shellApproval(shell.sessionId, shellBuildCommand, "shell-build");
  assert.equal(await absent(join(shellResource, "build.log")), true, "the first pending command has not executed");
  await clickShellDecision(true);
  const secondShellApproval = await shellApproval(shell.sessionId, shellCheckCommand, "shell-check");
  assert.notEqual(secondShellApproval.requestId, firstShellApproval.requestId, "allow-once for build never becomes approval for the check command");
  assert.equal(await readFile(join(shellResource, "build.log"), "utf8"), "build\n", "one approval runs the build exactly once");
  await clickShellDecision(true);
  const thirdShellApproval = await shellApproval(shell.sessionId, shellRecheckCommand, "shell-recheck");
  assert.notEqual(thirdShellApproval.requestId, secondShellApproval.requestId, "the corrected check requires its own allow-once approval");
  await clickShellDecision(true);
  const shellFinished = await until(async () => { const state = await snapshot(); return state.workstreams.find(work => work.id === "work-shell").status === "awaiting_user" && runsFor(state, "work-shell").every(run => run.state === "completed" && run.completionKey) ? state : null; }, "actual approved build → failed check → typed fix → document");
  assert.equal(runsFor(shellFinished, "work-shell").length, 5);
  assert.equal(await readFile(join(shellResource, "candidate.txt"), "utf8"), "candidate-v2");
  assert.match(await readFile(join(shellResource, "report.md"), "utf8"), /Check observed candidate-v1 failure/);
  assert.equal(await readFile(join(shellResource, "build.log"), "utf8"), "build\n");
  coverage.push("Real Shell build, failing check(exit1) and successful recheck(exit0) each need a distinct exact-command approval card; warning and no session-grant button; one build execution; actual failure leads to typed fix, passing recheck and documentation");

  const adopting = await createWork("work-adopt", "ADOPT_MAIN: Continue under existing bounded authorization when an explicitly adopted decision changes.");
  const old = await adopting.start();
  await until(() => held.has("adopt-old"), "old-decision Work is actively streaming");
  const discussion = await action("discuss", { pause: false }, "work-adopt");
  assert.notEqual(discussion.sessionId, adopting.sessionId);
  await invoke("agentPrompt", { sessionId: discussion.sessionId, content: "DISCUSSION_MARKER: Discuss the ongoing work without pausing or changing its decisions." });
  await until(async () => (await invoke("sessionGet", { id: discussion.sessionId })).session.messages.some(message => message.role === "assistant" && message.content?.includes("DISCUSSION_MARKER: Work remains")), "real Discuss response while Work runs");
  assert.ok(runsFor(await snapshot(), "work-adopt").some(run => run.id === old.runId && active(run)), "Discuss with pause=false leaves real Work active");
  const exploration = await action("side.create", { purpose: "explore", visibility: "project", sourceSessionId: adopting.sessionId, readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true }, task: "ADOPT_EXPLORE: Propose the NEW_DECISION_MARKER conclusion only." }, "work-adopt");
  const proposalId = `explore:${exploration.sessionId}:conclusion`;
  const proposed = await until(async () => { const state = await snapshot(); return state.decisions.some(decision => decision.id === proposalId && decision.state === "proposed") ? state : null; }, "midflight Explore durable proposal");
  assert.equal(proposed.workstreams.find(work => work.id === "work-adopt").decisionRevision, 0);
  assert.equal(runsFor(proposed, "work-adopt").length, 1, "unadopted Explore does not steer or restart Work");
  await action("adopt", { decisionId: proposalId, source: { kind: "user", ref: "explicit-midflight-e2e-adoption" } }, "work-adopt");
  // Graceful adoption lets the already admitted model step reach its actual
  // terminal checkpoint; the old revision must then be fenced by the runtime.
  held.get("adopt-old")();
  const continued = await until(async () => { const state = await snapshot(); const runs = runsFor(state, "work-adopt"); return runs.some(run => run.id !== old.runId && run.decisionRevision === 1 && run.state === "completed" && run.completionKey) ? state : null; }, "automatic authorized continuation observes adopted context without another Start");
  assert.equal(runsFor(continued, "work-adopt").length, 2, "adoption dispatches exactly one bounded successor");
  assert.ok(!continued.artifacts.some(artifact => artifact.id === "must-not-be-current"), "old-decision partial candidate never enters effective artifact state");
  assert.equal(continued.workstreams.find(work => work.id === "work-adopt").decisionRevision, 1);
  const discussionState = await invoke("sessionGet", { id: discussion.sessionId });
  assert.ok(discussionState.session.messages.some(message => message.content?.startsWith("Work checkpoint since this discussion began:")), "Discuss receives execution delta automatically without copied handoff");
  coverage.push("Real Discuss while Work continues; Explore proposal cannot steer; midflight Adopt fences old partial output and automatically continues under unchanged valid authorization/new decision context; discussion receives checkpoint delta");

  const survivor = await createWork("work-survivor", "HOLD_SURVIVOR: Keep unrelated work active during scoped controls.");
  const survivorRun = await survivor.start();
  await until(() => held.has("survivor"), "unrelated survivor real request");
  for (const control of ["pause", "cancel"]) {
    const target = await createWork(`work-${control}`, `SHELL_PENDING_${control.toUpperCase()}: Revoke only this pending Shell request before it executes.`);
    const initial = await target.start();
    const originalApproval = await shellApproval(target.sessionId, pendingCommand(control), `shell-pending-${control}`);
    assert.equal(await absent(join(canonicalWorkspace, `pending-${control}.txt`)), true);
    await action(control, {}, `work-${control}`);
    const controlled = await until(async () => { const state = await snapshot(); return state.workstreams.find(work => work.id === `work-${control}`).status === (control === "pause" ? "paused" : "cancelled") && runsFor(state, `work-${control}`).every(run => !active(run) && run.completionKey) ? state : null; }, `${control} affects only selected workstream`);
    assert.ok(controlled.runs.some(run => run.id === survivorRun.runId && active(run)), "unrelated work survives scoped pause/cancel");
    assert.equal(await absent(join(canonicalWorkspace, `pending-${control}.txt`)), true, `${control} revokes the pending Shell command with no execution`);
    await until(() => page.evaluate("!document.querySelector('.permission-card')"), `${control} clears the revoked actual permission card`);
    if (control === "pause") {
      await action("resume", {}, "work-pause");
      const freshApproval = await shellApproval(target.sessionId, pendingCommand(control), "shell-resumed-pause");
      assert.notEqual(freshApproval.requestId, originalApproval.requestId, "Resume requires a fresh request, never reuses revoked approval");
      assert.equal(await absent(join(canonicalWorkspace, "pending-pause.txt")), true, "Resume does not execute before fresh explicit approval");
      await clickShellDecision(true);
      const resumed = await until(async () => { const state = await snapshot(); return runsFor(state, "work-pause").some(run => run.id !== initial.runId && run.state === "completed" && run.completionKey) && state.workstreams.find(work => work.id === "work-pause").status === "awaiting_user" ? state : null; }, "Resume continues the same assignment without another Start");
      const pauseRuns = runsFor(resumed, "work-pause");
      assert.equal(pauseRuns.length, 2, "one paused no-effect attempt and exactly one resumed run");
      assert.ok(pauseRuns.every(run => run.authorizationId === "auth-work-pause"), "Resume retains the existing explicit authorization");
      assert.ok(pauseRuns.every(run => run.effects[0].resource === target.resource), "Resume retains the original bounded resource assignment");
      assert.equal(await readFile(join(canonicalWorkspace, "pending-pause.txt"), "utf8"), "pause\n");
      assert.ok(resumed.runs.some(run => run.id === survivorRun.runId && active(run)), "unrelated Work survives pause and Resume approval");
    }
  }
  held.get("survivor")();
  await until(async () => runsFor(await snapshot(), "work-survivor").every(run => run.state === "completed" && run.completionKey), "unrelated survivor completes normally");
  coverage.push("Pause revokes pending Shell without effects; Resume (no Start/auth change) retains assignment, requires fresh approval, executes once and terminates; Cancel independently revokes pending Shell without execution or continuation; unrelated Work survives and completes");

  // Feedback is retained after the user explicitly closes the old execution grant.
  // This tests candidate identity without accidentally authorizing correction work.
  await mutate("authorization.revoke", { projectId, workstreamId: "work-main", authorizationId: "auth-main" });
  await mutate("feedback.add", { feedback: { id: "feedback-1", projectId, workstreamId: "work-main", candidateId: "candidate-1", candidateRevision: "candidate-r1", environment: "loopback-synthetic-model", acceptanceId: "acceptance-1", comment: "Request a separately authorized improvement", source: { kind: "user", ref: "fixture-user" }, createdAt: stamp() } });
  lastSnapshot = await snapshot(); assert.equal(lastSnapshot.feedback[0].candidateRevision, "candidate-r1");
  const totalRunsBeforeRestart = lastSnapshot.runs.length;
  const countBeforeRestart = requests.length;
  await writeFile(join(output, "before-restart.json"), json(lastSnapshot, null, 2));
  await stopApp(); await startApp();
  lastSnapshot = await snapshot();
  assert.equal(lastSnapshot.runs.length, totalRunsBeforeRestart); assert.equal(lastSnapshot.artifacts.find(item => item.id === "candidate-1").revision, "candidate-r1");
  assert.equal(lastSnapshot.feedback[0].candidateRevision, "candidate-r1");
  for (const sessionId of new Set(lastSnapshot.runs.map(run => run.sessionId))) {
    const status = await invoke("agentGetStatus", sessionId);
    assert.equal(status.status?.isRunning, false, "post-recovery real AgentHost is idle");
  }
  assert.equal(requests.length, countBeforeRestart, "completed run recovery sends no model request");
  coverage.push("Actual app/profile restart preserves candidate/evidence/feedback and does not replay completed work");
  const shot = await page.call("Page.captureScreenshot", { format: "png" });
  await writeFile(join(output, "production-renderer.png"), Buffer.from(shot.data, "base64"));
  await writeFile(join(output, "result.json"), json({ ok: true, builtCommit, output, scratch, projectId, coverage, gaps: ["B Project Console DOM/visual interactions are a separate final integration check", "Ambiguous crash recovery is covered by lower-level tests, not this completed-run restart", "No live account or deployment"], modelRequests: requests.length }, null, 2));
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
  await writeFile(join(output, "failure.json"), json({ message: error.message, stack: error.stack, builtCommit, scratch, projectId, coverage, diagnostics }, null, 2));
  console.error(`FAIL production workflow; evidence retained: ${output}`); throw error;
} finally {
  await writeFile(join(output, "electron.log"), log);
  await writeFile(join(output, "model-requests.json"), json(requests, null, 2));
  await writeFile(join(output, "model-checkpoints.json"), json(checkpoints, null, 2));
  await writeFile(join(output, "cas-refreshes.json"), json(conflictRefreshes, null, 2));
  if (lastSnapshot) await writeFile(join(output, "snapshot.json"), json(lastSnapshot, null, 2));
  await stopApp(); model.closeAllConnections(); await new Promise(done => model.close(done));
}
