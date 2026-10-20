#!/usr/bin/env node
/** Production Electron renderer journey for Project Console and workflow navigation.
 * Usage: node scripts/e2e-project-workflow-ui.mjs [--output /absolute/evidence-dir]
 * Seeds durable state through the real Rust Host; all acceptance interactions use the real DOM.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repositoryRoot, assertDesktopBuild, resolveElectronBinary } from "./e2e/boot.mjs";
import { Host } from "./e2e/host.mjs";

const root = resolve(repositoryRoot());
assertDesktopBuild(root);
const sourceCommitAtRun = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const sourceChangesAtRun = execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }).trim();
const builtCommitArg = process.argv.indexOf("--built-commit");
const builtCommit = builtCommitArg >= 0 ? process.argv[builtCommitArg + 1] : undefined;
if (builtCommitArg >= 0 && !builtCommit) throw new Error("--built-commit requires the commit identifier used for the built Electron JavaScript");
const hostBuiltCommitArg = process.argv.indexOf("--host-built-commit");
const hostBuiltCommit = hostBuiltCommitArg >= 0 ? process.argv[hostBuiltCommitArg + 1] : null;
if (hostBuiltCommitArg >= 0 && !hostBuiltCommit) throw new Error("--host-built-commit requires the source commit used to build the Rust Host binary");
const outputArg = process.argv.indexOf("--output");
const output = outputArg < 0 ? await mkdtemp(join(tmpdir(), "pi-workflow-ui-production-")) : resolve(process.argv[outputArg + 1]);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(output, "state-"));
const home = join(scratch, "home"), data = join(scratch, "data");
for (const path of [home, data]) await mkdir(path, { recursive: true });
const hostBinary = process.env.PI_DESKTOP_HOST_BIN || join(root, "target/debug/pi-desktop-host-core");
const electronBinary = process.env.PI_DESKTOP_ELECTRON_BIN || resolveElectronBinary(root).electronBinary;
const json = JSON.stringify, stamp = () => new Date().toISOString(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let sequence = 0, projectId, main, page, child, log = "", finalSnapshot;
const coverage = [], layout = {}, modelRequests = [];
const model = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(json({ object: "list", data: [{ id: "ui-fixture", object: "model", owned_by: "local-fixture" }] }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404); res.end(); return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const request = JSON.parse(raw);
  modelRequests.push(request);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const frame = (delta, finish_reason = null) => res.write(`data: ${json({
    id: `project-agent-${modelRequests.length}`, object: "chat.completion.chunk", created: 1,
    model: request.model, choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  frame({ role: "assistant", content: `PROJECT_AGENT_REPLY_${modelRequests.length}: We can discuss the project before creating work.` });
  frame({}, "stop");
  res.end("data: [DONE]\n\n");
});
await new Promise((done, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", done); });
async function freePort() {
  const server = createNetServer(); await new Promise(done => server.listen(0, "127.0.0.1", done));
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}
async function until(check, name, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(100); }
  throw new Error(`Timed out waiting for ${name}\n${log.slice(-5000)}`);
}
async function connect(port, type) {
  const target = await until(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === type && (type !== "page" || item.url.includes("/out/renderer/index.html") && !item.url.includes("surface="))); }
    catch { return null; }
  }, `CDP ${type}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl), pending = new Map();
  await new Promise(done => ws.addEventListener("open", done, { once: true }));
  ws.addEventListener("message", ({ data }) => { const msg = JSON.parse(String(data)), item = pending.get(msg.id); if (!item) return; clearTimeout(item.timer); pending.delete(msg.id); msg.error ? item.reject(new Error(json(msg.error))) : item.resolve(msg.result); });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); ws.send(json({ id, method, params }));
  });
  return { ws, call, evaluate: async expression => { const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(json(result.exceptionDetails)); return result.result.value; } };
}
async function stopApp() {
  main?.ws.close(); page?.ws.close(); main = page = undefined;
  if (!child || child.exitCode !== null) return;
  const current = child, exited = new Promise(done => current.once("exit", done));
  try { process.kill(-current.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  const timer = setTimeout(() => { try { process.kill(-current.pid, "SIGKILL"); } catch {} }, 5000);
  await exited; clearTimeout(timer);
}
async function startApp() {
  const ports = [await freePort(), await freePort()];
  const env = { ...process.env, HOME: home, PI_DESKTOP_DATA_DIR: data, PI_DESKTOP_HOST_BIN: hostBinary,
    PI_DESKTOP_PLAN_UI_PROBE: "1", PI_DESKTOP_TEST_API_KEY: "local-fixture", PI_DESKTOP_TEST_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, PI_DESKTOP_TEST_MODEL: "ui-fixture", ELECTRON_RENDERER_URL: "", PI_DESKTOP_START_MAXIMIZED: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electronBinary, [`--remote-debugging-port=${ports[0]}`, `--inspect=${ports[1]}`, `--user-data-dir=${join(scratch, "profile")}`, "."], { cwd: join(root, "apps/desktop"), env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout.on("data", chunk => { log += chunk; }); child.stderr.on("data", chunk => { log += chunk; });
  main = await connect(ports[1], "node"); page = await connect(ports[0], "page");
  await until(() => page.evaluate("!!window.piDesktop && !!window.__PI_DESKTOP__"), "renderer and preload");
  await until(() => main.evaluate("typeof globalThis.__PI_DESKTOP_PLAN_UI_PROBE === 'function'"), "setup probe");
}
const invoke = async (key, ...args) => {
  const result = await page.evaluate(`piDesktop.invoke(piDesktop.channels.invoke[${json(key)}],...${json(args)})`);
  assert.equal(result.ok, true, `${key}: ${json(result)}`); return result.data;
};
const snapshot = () => invoke("projectWorkflowSnapshot", { projectId });
const mutate = async (kind, fields) => invoke("projectWorkflowMutate", { kind, commandId: `ui-e2e-${++sequence}`, expectedRevision: (await snapshot()).revision, ...fields });
const clickText = async (text, selector = "button") => page.evaluate(`(() => { const el=[...document.querySelectorAll(${json(selector)})].find(x=>x.textContent?.trim().includes(${json(text)}) && !x.disabled); if(!el) return false; el.click(); return true })()`);
const clickAria = async (label, selector = "button[aria-label]") => page.evaluate(`(() => { const el=[...document.querySelectorAll(${json(selector)})].find(x=>x.getAttribute('aria-label')===${json(label)} && !x.disabled); if(!el) return false; el.click(); return true })()`);
const fillByLabel = async (label, value) => page.evaluate(`(() => { const labels=[...document.querySelectorAll('label')]; const label=labels.find(x=>x.textContent?.trim().startsWith(${json(label)})); const input=label?.querySelector('input,textarea,select') || (label?.htmlFor && document.getElementById(label.htmlFor)); if(!input) return false; const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value')?.set; setter?.call(input,${json(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); return true })()`);
const fillControl = async (selector, value) => page.evaluate(`(() => { const input=document.querySelector(${json(selector)}); if(!input) return false; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value').set.call(input,${json(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); return true })()`);
const submitForm = async selector => page.evaluate(`(() => { const form=document.querySelector(${json(selector)}); if(!form) return false; form.requestSubmit(); return true })()`);
const capture = async name => { const shot = await page.call("Page.captureScreenshot", { format: "png" }); await writeFile(join(output, name), Buffer.from(shot.data, "base64")); };
try {
  const seed = new Host(hostBinary, data, { env: { HOME: home }, quiet: true });
  let setup, hostProtocolVersion;
  try {
    const handshake = await seed.start();
    hostProtocolVersion = handshake.protocolVersion;
    // The production sidebar renders rows for open roots. Reuse the app's already-open
    // repository root as a read-only visible anchor; all mutable Host data stays isolated.
    projectId = (await seed.call("project.group.create", { name: "Workflow UI Production", folders: [join(root, "apps")] })).group.id;
  } finally { await seed.stop(); }
  await startApp();
  setup = await main.evaluate(`globalThis.__PI_DESKTOP_PLAN_UI_PROBE({operation:'liveSetup',workspace:${json(join(root, "apps"))}})`);
  assert.equal(setup.ok, true, json(setup));
  await invoke("settingsSet", { ...await invoke("settingsGet"), defaultProviderId: setup.providerId, defaultModelId: setup.modelId });
  await until(() => page.evaluate(`!![...document.querySelectorAll('button')].find(x=>x.textContent?.trim()==='apps')`), "empty project in sidebar", 60000);
  await clickText("apps");
  await until(() => page.evaluate(`!!document.querySelector('[data-workflow="project-intent"] textarea')`), "empty project Agent composer");
  assert.equal((await snapshot()).workstreams.length, 0);
  assert.ok(await fillControl('[data-workflow="project-intent"] textarea', "PROJECT_AGENT_EMPTY_PROJECT: discuss before working"));
  assert.ok(await submitForm('[data-workflow="project-intent"]'));
  await until(() => page.evaluate(`document.body.innerText.includes('PROJECT_AGENT_REPLY_1')`), "actual Agent response rendered");
  const projectAgentSession = (await snapshot()).projectAgents.find(agent => agent.projectId === projectId).sessionId;
  assert.equal((await snapshot()).workstreams.length, 0, "discussion creates no hidden workstream");
  assert.equal((await snapshot()).runs.length, 0, "discussion starts no workflow run");
  assert.equal(modelRequests.length, 1);
  assert.equal(modelRequests[0].tools?.length ?? 0, 0, "project Agent has no execution catalog");
  assert.ok(await page.evaluate(`!!document.querySelector('.workflow-conversation-bar') && !document.querySelector('.composer-mode') && !document.querySelector('.composer-permission')`));
  await capture("renderer-project-agent.png");
  await page.evaluate(`document.querySelector('.workflow-conversation-bar button').click()`);
  await until(() => page.evaluate(`!!document.querySelector('.workflow-agent-tab')`), "project return route");
  await page.evaluate(`document.querySelector('.workflow-agent-tab').click()`);
  await until(() => page.evaluate(`!!document.querySelector('.workflow-conversation-bar')`), "project Agent reopened");
  assert.equal((await snapshot()).projectAgents[0].sessionId, projectAgentSession);
  assert.equal(modelRequests.length, 1, "reopening never sends another prompt");
  coverage.push("Empty project opens canonical Agent from the overview, renders an actual loopback-model reply in ChatSurface, preserves it on revisit, and creates no Workstream/Run or tool catalog");
  await stopApp();
  await startApp();
  await until(() => page.evaluate(`!![...document.querySelectorAll('button')].find(x=>x.textContent?.trim()==='apps')`), "project restored after restart", 60000);
  await clickText("apps");
  await until(() => page.evaluate(`!!document.querySelector('[data-workflow="project-intent"] textarea')`), "project composer after restart");
  await page.evaluate(`document.querySelector('.workflow-agent-tab').click()`);
  await until(() => page.evaluate(`!!document.querySelector('.workflow-conversation-bar') && !!document.querySelector('.composer-input')`), "resumed Agent Composer");
  assert.ok(await page.evaluate(`(() => { const input=document.querySelector('.composer-input'); if(!input) return false; input.focus(); input.textContent='PROJECT_AGENT_RESTART: continue the same discussion'; input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'PROJECT_AGENT_RESTART: continue the same discussion'})); return true })()`));
  await until(() => page.evaluate(`!!document.querySelector('.composer-toolbar .send-btn:not(:disabled)')`), "real Composer send enabled");
  await page.evaluate(`document.querySelector('.composer-toolbar .send-btn').click()`);
  await until(() => page.evaluate(`document.body.innerText.includes('PROJECT_AGENT_REPLY_2')`), "resumed discussion response");
  assert.equal((await snapshot()).projectAgents[0].sessionId, projectAgentSession);
  assert.equal(modelRequests.length, 2);
  assert.equal(modelRequests[1].tools?.length ?? 0, 0);
  coverage.push("Restart keeps the same project Agent and transcript; the existing Composer sends the next message with its configured model and still no execution tools");
  await page.evaluate(`document.querySelector('.workflow-conversation-bar button').click()`);
  await until(() => page.evaluate(`!!document.querySelector('[data-workflow="console"]')`), "return before work creation");
  await main.evaluate(`(() => { const makeRequire=process.getBuiltinModule('module').createRequire; const req=makeRequire(${json(join(root, "apps/desktop/package.json"))}); const shell=req('electron').shell; globalThis.__workflowOpenedPaths=[]; shell.openPath=async path=>{ globalThis.__workflowOpenedPaths.push(path); return ''; }; })()`);
  const now = stamp(), workstreamId = "ui-workstream", candidateId = "ui-candidate", resourceId = "ui-resource";
  const workstream = { id: workstreamId, projectId, title: "Measured rollout", goal: "Ship the measured release", acceptance: [{ id: "ui-acceptance", title: "Candidate reviewed", status: "pending", evidenceIds: [] }], owner: { kind: "session", ref: setup.sessionId }, status: "draft", priority: 0, order: 0, dependencyIds: [], nextAction: "Review the candidate", blocker: { reason: "Candidate review is pending", owner: "Release lead", resumeWhen: "Approve candidate-r7" }, mainSessionId: setup.sessionId, revision: 0, decisionRevision: 0, createdAt: now, updatedAt: now };
  await mutate("workstream.create", { workstream });
  const recordedPath = join(root, "apps/desktop/package.json");
  await mutate("artifact.put", { artifact: { id: candidateId, projectId, workstreamId, label: "Candidate build", kind: "candidate", revision: "candidate-r7", environment: "synthetic local", entryPoint: recordedPath, source: { kind: "user", ref: "isolated-ui-e2e" }, createdAt: now } });
  await mutate("workstream.update", { projectId, workstreamId, patch: { currentCandidateId: candidateId } });
  await mutate("evidence.add", { evidence: { id: "ui-evidence", projectId, workstreamId, candidateId, candidateRevision: "candidate-r7", environment: "synthetic local", scenario: "smoke-test", acceptanceId: "ui-acceptance", outcome: "passed", kind: "rendered", limits: "fixture data", source: { kind: "user", ref: "isolated-ui-e2e" }, createdAt: now } });
  await mutate("resource.put", { resource: { id: resourceId, projectId, workstreamId, label: "Release checklist", uri: recordedPath, kind: "doc", revision: "doc-r3", updatedAt: now, state: "effective", source: { kind: "user", ref: "isolated-ui-e2e", revision: "src-r2" } } });
  await mutate("feedback.add", { feedback: { id: "ui-feedback", projectId, workstreamId, candidateId, candidateRevision: "candidate-r7", environment: "synthetic local", acceptanceId: "ui-acceptance", comment: "Review the migration notes.", source: { kind: "user", ref: "isolated-ui-e2e" }, createdAt: now } });
  const initial = await snapshot();
  assert.equal(initial.artifacts.find(item => item.id === candidateId)?.revision, "candidate-r7");
  assert.equal(initial.resources.find(item => item.id === resourceId)?.source.revision, "src-r2");
  // The user path opens the project without selecting the seeded Agent session.
  await until(() => page.evaluate(`!![...document.querySelectorAll('button')].find(x=>x.textContent?.trim()==='apps')`), "open project appears in real sidebar", 60000);
  await clickText("apps");
  await until(() => page.evaluate(`!!document.querySelector('[data-workflow="console"][data-project-id="${projectId}"]')`), "Project Console opens from sidebar");
  coverage.push("Opened the real Project Console from the sidebar; no active session was selected by the harness");

  await clickText("新建工作流");
  await until(() => page.evaluate(`!!document.querySelector('[data-workflow="workstream-editor"]')`), "new workstream editor");
  for (const [label, value] of [["标题", "UI-created workstream"], ["目标", "Create from production renderer"], ["验收条件", "Visible in the workstream list"], ["责任人", "user"], ["下一步", "Verify UI save"]]) {
    assert.ok(await fillByLabel(label, value), `field exists: ${label}`);
  }
  assert.ok(await submitForm('[data-workflow="workstream-editor"]'));
  await until(() => page.evaluate(`document.querySelector('[data-workflow="console"]')?.textContent?.includes('UI-created workstream')`), "workstream saved through UI");
  const created = await snapshot();
  assert.ok(created.workstreams.some(item => item.title === "UI-created workstream"));
  coverage.push("Created a workstream with title, goal, acceptance, owner, and next action through rendered controls");

  // Search is submitted and selected through visible controls; inspect hit breadcrumbs and focus target.
  assert.ok(await clickAria("搜索此项目"), "project search is available in its header");
  const searchInput = await page.evaluate(`!!document.querySelector('.workflow-search input[type=search]')`);
  assert.ok(searchInput, "project-scoped search control is rendered");
  await fillByLabel("搜索此项目", "Candidate build");
  await submitForm(".workflow-search-form");
  await until(() => page.evaluate(`document.querySelector('.workflow-search-results')?.textContent?.includes('Candidate build')`), "candidate search result");
  const searchBefore = await page.evaluate(`({text:document.querySelector('.workflow-search-results')?.innerText, resultCount:document.querySelectorAll('.workflow-search-results li').length})`);
  assert.match(searchBefore.text, /Measured rollout/);
  await clickText("Candidate build", ".workflow-search-results button");
  await until(() => page.evaluate(`document.querySelector('[data-workflow-artifact="${candidateId}"]')?.contains(document.activeElement)`), "search breadcrumb opens and focuses candidate");
  coverage.push("Searched durable project state and opened the candidate at its artifact breadcrumb");

  // Candidate feedback is created with an explicit candidate revision and environment by the UI form.
  await clickText("提交反馈");
  await until(() => page.evaluate(`!!document.querySelector('[data-workflow-feedback-editor="${candidateId}"]')`), "candidate feedback editor");
  assert.ok(await fillByLabel("环境", "synthetic local"));
  assert.ok(await fillByLabel("观察或反例", "Retain the tested candidate revision."));
  await submitForm(`[data-workflow-feedback-editor="${candidateId}"]`);
  await until(async () => (await snapshot()).feedback.some(item => item.comment === "Retain the tested candidate revision."), "revision-pinned feedback");
  finalSnapshot = await snapshot();
  const uiFeedback = finalSnapshot.feedback.find(item => item.comment === "Retain the tested candidate revision.");
  assert.equal(uiFeedback.candidateRevision, "candidate-r7");
  assert.equal(uiFeedback.environment, "synthetic local");
  coverage.push("Added candidate feedback through the UI and verified exact revision/environment in Rust Host snapshot");

  assert.ok(await page.evaluate(`(() => { const button=document.querySelector('[data-workflow-artifact="${candidateId}"] .workflow-reference button'); if(!button) return false; button.click(); return true })()`));
  await until(() => main.evaluate(`globalThis.__workflowOpenedPaths?.length===1`), "candidate reference routed to isolated shell boundary");
  const candidateOpenedPath = await main.evaluate(`globalThis.__workflowOpenedPaths[0]`);
  assert.equal(candidateOpenedPath, recordedPath);

  // Context resource appears in its real tab and carries the source revision.
  await clickText("共享上下文");
  await until(() => page.evaluate(`!!document.querySelector('[data-workflow-resource="${resourceId}"]')`), "project resource context");
  const resourceUi = await page.evaluate(`document.querySelector('[data-workflow-resource="${resourceId}"]')?.innerText`);
  assert.match(resourceUi, /src-r2/);
  assert.ok(await page.evaluate(`(() => { const button=document.querySelector('[data-workflow-resource="${resourceId}"] .workflow-reference button'); if(!button) return false; button.click(); return true })()`));
  await until(() => main.evaluate(`globalThis.__workflowOpenedPaths?.length===2`), "resource reference routed to isolated shell boundary");
  const resourceOpenedPath = await main.evaluate(`globalThis.__workflowOpenedPaths[1]`);
  assert.equal(resourceOpenedPath, recordedPath);
  coverage.push("Opened the resource context through the actual tab, read its source revision, and verified both candidate/resource references resolve to their recorded path through the production IPC boundary");

  // Folder management and chat placement/removal are actual sidebar DOM actions.
  const createFolder = async (name, parentId = "") => {
    assert.ok(await clickAria("新建文件夹"), "new folder control is available");
    await until(() => page.evaluate(`!![...document.querySelectorAll('label')].find(x=>x.textContent?.trim().startsWith('文件夹名称'))`), "folder editor");
    assert.ok(await fillByLabel("文件夹名称", name));
    if (parentId) assert.ok(await fillByLabel("上级文件夹", parentId));
    assert.ok(await submitForm(".workflow-navigation-editor"));
    return until(async () => (await snapshot()).folders.find(folder => folder.name === name), `folder ${name} persisted`);
  };
  const folderRoot = await createFolder("UI Evidence");
  const folderNested = await createFolder("Nested Evidence", folderRoot.id);
  assert.equal(folderNested.parentId, folderRoot.id);
  coverage.push("Created a top-level folder and a shallow nested folder through the real sidebar editor");

  assert.ok(await clickAria("整理对话"), "chat organization mode opens");
  assert.ok(await page.evaluate(`(() => { const folder=document.querySelector('[data-workflow-folder="${folderRoot.id}"] .workflow-navigation-label'); if(!folder) return false; folder.click(); return true })()`), "parent folder can be expanded");
  await until(() => page.evaluate(`!!document.querySelector('[data-workflow-folder="${folderNested.id}"]')`), "nested folder row");
  assert.ok(await page.evaluate(`(() => { const button=document.querySelector('[data-workflow-folder="${folderNested.id}"] button[aria-label="新建对话"]'); if(!button) return false; button.click(); return true })()`), "new chat action is available in nested folder");
  const nestedChat = await until(async () => (await snapshot()).navigation.find(item => item.folderId === folderNested.id), "chat created in nested folder");
  const sessionsResult = await invoke("sessionList");
  const setupSession = sessionsResult.sessions.find(session => session.id === nestedChat.sessionId);
  assert.ok(setupSession, "new folder chat appears in the ordinary session inventory");
  await page.evaluate(`document.querySelector('[data-workflow-folder="${folderNested.id}"] .workflow-navigation-label')?.click()`);
  await until(() => page.evaluate(`!!document.querySelector('[data-workflow-folder="${folderNested.id}"] .workflow-navigation-chat input[type=checkbox]')`), "folder chat selectable in organization mode");
  const selectedChat = await page.evaluate(`(() => { const input=document.querySelector('[data-workflow-folder="${folderNested.id}"] .workflow-navigation-chat input[type=checkbox]'); if(!input) return false; input.click(); return true })()`);
  assert.ok(selectedChat, "folder chat can be selected without opening its transcript");
  await until(() => page.evaluate(`!![...document.querySelectorAll('label')].find(x=>x.textContent?.includes('移动所选的'))`), "move-selected destination");
  assert.ok(await fillByLabel("移动所选的", folderRoot.id));
  assert.ok(await clickText("移动"));
  await until(async () => (await snapshot()).navigation.find(item => item.sessionId === nestedChat.sessionId)?.folderId === folderRoot.id, "folder chat moved through sidebar organization controls");
  coverage.push("Created a chat inside the nested folder and moved it to another folder with the sidebar organize controls");

  assert.ok(await clickAria("移除文件夹", `[data-workflow-folder="${folderNested.id}"] button[aria-label]`));
  await until(() => page.evaluate(`!!document.querySelector('.workflow-navigation-editor[role=alert]')`), "non-destructive folder confirmation");
  assert.ok(await clickText("移除文件夹"));
  await until(async () => !(await snapshot()).folders.some(folder => folder.id === folderNested.id), "nested folder removal");
  const retainedNavigation = (await snapshot()).navigation.find(item => item.sessionId === nestedChat.sessionId);
  assert.equal(retainedNavigation?.folderId, folderRoot.id, "removing the empty nested folder leaves moved chat in its destination");
  assert.ok((await invoke("sessionList")).sessions.some(session => session.id === nestedChat.sessionId), "folder removal leaves the underlying chat accessible");
  coverage.push("Removed the now-empty nested folder non-destructively and verified its chat remains available in the session inventory");
  await clickText("apps");
  await until(() => page.evaluate(`!!document.querySelector('[data-workflow="console"][data-project-id="${projectId}"]')`), "return to Project Console from chat navigation");
  await clickText("共享上下文");
  await until(() => page.evaluate(`!!document.querySelector('[data-workflow-resource="${resourceId}"]')`), "resource panel restored after chat navigation");

  // Resize the actual Electron window (not the emulated CSS viewport) to its supported minimum.
  const nativeSize = await main.evaluate(`(() => { const require=process.getBuiltinModule('module').createRequire(${json(join(root, "apps/desktop/package.json"))}); const {BrowserWindow}=require('electron'); const win=BrowserWindow.getAllWindows().find(item=>!item.isDestroyed() && item.webContents.getURL().includes('/out/renderer/index.html')); if(!win) throw new Error('workflow window not found'); win.setContentSize(800,600); return win.getContentSize(); })()`);
  await until(() => page.evaluate("innerWidth===800 && innerHeight===600"), "native 800x600 renderer resize");
  assert.deepEqual(nativeSize, [800, 600]);

  // Inspect the workstream owner, blocker, and current candidate on Overview at both themes.
  await clickText("概览");
  await until(() => page.evaluate(`!!document.querySelector('[data-workflow="project-intent"]')`), "Overview view");

  // At the native supported minimum, capture both themes and the shared context surface.
  for (const [name, theme] of [["renderer-overview-light.png", "light"], ["renderer-overview-dark.png", "dark"]]) {
    await page.evaluate(`document.documentElement.dataset.theme=${json(theme)}`);
    await until(() => page.evaluate(`document.documentElement.dataset.theme===${json(theme)}`), `${theme} theme`);
    await page.evaluate("window.scrollTo(0,0); document.querySelector('.workflow-console')?.scrollTo(0,0)"); await sleep(250);
    layout[name] = await page.evaluate(`(() => { const actions=document.querySelector('.workflow-header .workflow-actions')?.getBoundingClientRect(); return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,consoleWidth:document.querySelector('[data-workflow="console"]')?.getBoundingClientRect().width,headerActions:actions?{top:actions.top,bottom:actions.bottom}:null,selectedConsoleControl:document.querySelector('[data-workflow="console"] [aria-pressed=true]')?.innerText || null} })()`);
    await capture(name);
  }
  for (const [name, metrics] of Object.entries(layout)) {
    assert.equal(metrics.width, 800, `${name} uses native content width`);
    assert.ok(metrics.documentWidth <= 801 && metrics.consoleWidth <= 801, `${name} overflows supported width: ${json(metrics)}`);
    assert.ok(metrics.headerActions && metrics.headerActions.top >= 46 && metrics.headerActions.bottom <= 600, `${name} overlaps native titlebar or clips header actions: ${json(metrics)}`);
  }
  await clickText("Measured rollout", ".workflow-workstream-list button");
  await until(() => page.evaluate(`!!document.querySelector('.workflow-detail .workflow-blocker') && !!document.querySelector('.workflow-candidate-summary')`), "workstream owner, blocker, and candidate details");
  const overviewText = await page.evaluate(`document.querySelector('.workflow-detail')?.innerText`);
  assert.match(overviewText, /Release lead/);
  assert.match(overviewText, /Approve candidate-r7/);
  assert.match(overviewText, /candidate-r7/);
  coverage.push("Opened a work item from Overview and inspected its owner, blocker/resume condition, and current candidate in its separate detail view");
  await page.evaluate(`document.documentElement.dataset.theme='light'; document.querySelector('.workflow-detail')?.scrollIntoView({block:'start'})`);
  await until(() => page.evaluate(`(() => { const block=document.querySelector('.workflow-blocker')?.getBoundingClientRect(), candidate=document.querySelector('.workflow-candidate-summary')?.getBoundingClientRect(); return !!block && !!candidate && block.top >= 0 && block.bottom <= innerHeight && candidate.top >= 0 && candidate.bottom <= innerHeight })()`), "Overview blocker and candidate visible in viewport");
  const overviewDetail = await page.evaluate(`(() => { const rect=selector=>{const r=document.querySelector(selector)?.getBoundingClientRect(); return r?{top:r.top,bottom:r.bottom,left:r.left,right:r.right}:null}; return {text:document.querySelector('.workflow-detail')?.innerText,owner:rect('.workflow-detail .workflow-muted'),blocker:rect('.workflow-blocker'),candidate:rect('.workflow-candidate-summary'),width:innerWidth,height:innerHeight} })()`);
  assert.match(overviewDetail.text, /Release lead/);
  assert.ok(overviewDetail.blocker?.top >= 0 && overviewDetail.blocker.bottom <= 600, `Overview blocker is not visible: ${json(overviewDetail)}`);
  assert.ok(overviewDetail.candidate?.top >= 0 && overviewDetail.candidate.bottom <= 600, `Overview candidate is not visible: ${json(overviewDetail)}`);
  await capture("renderer-overview-detail.png");

  await clickText("共享上下文");
  await until(() => page.evaluate(`!!document.querySelector('[data-workflow-resource="${resourceId}"]')`), "shared context screenshot");
  await page.evaluate("document.documentElement.dataset.theme='light'; document.querySelector('.workflow-console')?.scrollTo(0,0)"); await sleep(250);
  layout["renderer-context-light.png"] = await page.evaluate(`({width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,consoleWidth:document.querySelector('[data-workflow="console"]')?.getBoundingClientRect().width})`);
  await capture("renderer-context-light.png");
  assert.equal(layout["renderer-context-light.png"].width, 800);
  assert.ok(layout["renderer-context-light.png"].documentWidth <= 801 && layout["renderer-context-light.png"].consoleWidth <= 801);
  await page.evaluate("document.documentElement.dataset.theme='dark'"); await sleep(250);
  layout["renderer-context-dark.png"] = await page.evaluate(`({width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,consoleWidth:document.querySelector('[data-workflow="console"]')?.getBoundingClientRect().width})`);
  await capture("renderer-context-dark.png");
  assert.equal(layout["renderer-context-dark.png"].width, 800);
  assert.ok(layout["renderer-context-dark.png"].documentWidth <= 801 && layout["renderer-context-dark.png"].consoleWidth <= 801);
  coverage.push("Captured actual native Electron renderer at 800x600 in light/dark Overview and Shared Context, plus an Overview-detail frame showing owner, blocker, and candidate; checked page bounds and visible header actions");

  await writeFile(join(output, "snapshot.json"), json(finalSnapshot, null, 2));
  await writeFile(join(output, "result.json"), json({ ok: true, output, scratch, projectId, setupSessionId: setup.sessionId, projectAgentSession, modelRequestCount: modelRequests.length, metadata: { sourceCommitAtRun, sourceChangesAtRun, ...(builtCommit ? { jsBuiltCommit: builtCommit } : {}), hostBinaryCommit: hostBuiltCommit, hostProtocolVersion, workflowAggregateSchemaVersion: finalSnapshot.schemaVersion }, nativeContentSize: nativeSize, coverage, overviewText, overviewDetail, layout, searchResult: searchBefore, openedPaths: [candidateOpenedPath, resourceOpenedPath], gaps: ["Workflow execution, real account, and deployment are out of scope"] }, null, 2));
  console.log(`PASS production workflow renderer ${output}`);
  if (process.argv.includes("--review-hold")) {
    await clickText("概览");
    await main.evaluate(`(() => { const req=process.getBuiltinModule('module').createRequire(${json(join(root, "apps/desktop/package.json"))}); const win=req('electron').BrowserWindow.getAllWindows().find(item=>!item.isDestroyed() && item.webContents.getURL().includes('/out/renderer/index.html')); win.setContentSize(1040,760); win.show(); })()`);
    console.log("READY_NATIVE_REVIEW: press Enter to close the isolated application");
    await new Promise(done => process.stdin.once("data", done));
    process.stdin.pause();
  }
} catch (error) {
  const diagnostics = [];
  if (page) {
    try {
      finalSnapshot = await snapshot();
      const dom = await page.evaluate(`({title:document.title,body:document.body.innerText.slice(0,16000),buttons:[...document.querySelectorAll('button')].map(x=>x.innerText.trim()).filter(Boolean).slice(0,150),inputs:[...document.querySelectorAll('input,textarea,select')].map(x=>({tag:x.tagName,type:x.type,value:x.value,aria:x.getAttribute('aria-label')}))})`);
      await writeFile(join(output, "dom-failure.json"), json(dom, null, 2));
      const shot = await page.call("Page.captureScreenshot", { format: "png" }); await writeFile(join(output, "failure-renderer.png"), Buffer.from(shot.data, "base64"));
    } catch (cause) { diagnostics.push(cause.message); }
  }
  await writeFile(join(output, "failure.json"), json({ message: error.message, stack: error.stack, scratch, projectId, coverage, layout, diagnostics }, null, 2));
  console.error(`FAIL production workflow renderer; evidence retained: ${output}`); throw error;
} finally {
  await writeFile(join(output, "electron.log"), log);
  if (finalSnapshot) await writeFile(join(output, "snapshot.json"), json(finalSnapshot, null, 2));
  await stopApp(); model.closeAllConnections(); await new Promise(done => model.close(done));
}
