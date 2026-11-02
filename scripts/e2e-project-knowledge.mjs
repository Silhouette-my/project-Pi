#!/usr/bin/env node
/** Real Desktop/AgentHost/Rust continuity; only the loopback provider is scripted. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repositoryRoot, resolveElectronBinary, assertDesktopBuild } from "./e2e/boot.mjs";
import { Host } from "./e2e/host.mjs";

const root = resolve(repositoryRoot());
assertDesktopBuild(root);
const outputArg = process.argv.indexOf("--output");
const output = outputArg < 0 ? await mkdtemp(join(tmpdir(), "pi-knowledge-e2e-")) : resolve(process.argv[outputArg + 1]);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(output, "state-"));
const home = join(scratch, "home"), data = join(scratch, "data");
for (const path of [home, data, join(scratch, "project-a"), join(scratch, "project-b")]) await mkdir(path);
const projectA = await realpath(join(scratch, "project-a"));
const projectB = await realpath(join(scratch, "project-b"));
const hostBinary = process.env.PI_DESKTOP_HOST_BIN || join(root, "target/debug/pi-desktop-host-core");
const json = JSON.stringify;
const oldFact = "KNOWLEDGE_OLD_FACT_7b19";
const newFact = "KNOWLEDGE_CORRECTED_FACT_9c32";
const userNote = "USER_AUTHORED_NOTE_KEEP_4d72";
let sequence = 0, log = "", failure, child, main, page, projectId, setup;
const observed = [], coverage = [];

async function until(check, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    const value = await check();
    if (value) return value;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${label}\n${log.slice(-4000)}`);
}
async function freePort() {
  const server = createNetServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}
function reply(res, model, text, tool) {
  const frame = (delta, finish_reason = null) => res.write(`data: ${json({ id: `knowledge-${++sequence}`, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  frame(tool ? { role: "assistant", tool_calls: [{ index: 0, id: tool.id, type: "function", function: { name: tool.name, arguments: json(tool.args) } }] } : { role: "assistant", content: text });
  frame({}, tool ? "tool_calls" : "stop");
  res.end("data: [DONE]\n\n");
}
const model = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(json({ object: "list", data: [{ id: "knowledge-fixture", object: "model", owned_by: "local-fixture" }] }));
      return;
    }
    assert.equal(req.url, "/v1/chat/completions");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const userIndex = body.messages.findLastIndex(message => message.role === "user");
    const input = body.messages[userIndex].content;
    const prompt = typeof input === "string" ? input : input.filter(part => part.type === "text").map(part => part.text).join("\n");
    const marker = prompt.match(/KNOW_[A-Z_]+/)?.[0];
    assert.ok(marker, "fixture only accepts its own synthetic prompts");
    const system = body.messages.filter(message => message.role === "system" || message.role === "developer").map(message => json(message.content)).join("\n");
    observed.push({ marker, system });
    const results = body.messages.slice(userIndex + 1).filter(message => message.role === "tool");
    const result = id => results.find(message => message.tool_call_id === id);
    const invokeTool = (id, name, args) => {
      const advertised = body.tools?.some(tool => tool.function?.name === name);
      reply(res, body.model, null, advertised ? { id, name, args } : { id: `discover-${id}`, name: "ToolSearch", args: { query: name } });
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (marker === "KNOW_REMEMBER" || marker === "KNOW_REPLACE") {
      if (!result("read-knowledge")) invokeTool("read-knowledge", "ProjectKnowledgeRead", {});
      else if (!result("write-knowledge")) {
        const state = JSON.parse(result("read-knowledge").content);
        assert.equal(state.version, 1, "read tool returns the Host snapshot");
        const replacing = marker === "KNOW_REPLACE";
        const previous = state.entries.find(entry => entry.content === oldFact && entry.status === "active");
        if (replacing) assert.ok(previous, "correction targets the existing active record");
        invokeTool("write-knowledge", "ProjectKnowledgeWrite", {
          action: replacing ? "replace" : "remember", expectedRevision: state.revision, expectedProjectId: state.projectId,
          ...(replacing ? { entryId: previous.id } : {}), kind: "knowledge",
          title: "Synthetic architecture finding", content: replacing ? newFact : oldFact,
        });
      } else {
        const state = JSON.parse(result("write-knowledge").content);
        assert.ok(state.entries.some(entry => entry.status === "active" && entry.content === (marker === "KNOW_REPLACE" ? newFact : oldFact)), "tool write persisted successfully");
        reply(res, body.model, `${marker}_DONE`);
      }
      return;
    }
    if (marker === "KNOW_EXPECT_OLD") {
      assert.ok(system.includes(oldFact)); assert.ok(system.includes(userNote));
    } else if (marker === "KNOW_EXPECT_NEW") {
      assert.ok(system.includes(newFact)); assert.ok(!system.includes(oldFact)); assert.ok(system.includes(userNote));
    } else if (marker === "KNOW_EXPECT_FORGOTTEN") {
      assert.ok(!system.includes(newFact)); assert.ok(!system.includes(oldFact)); assert.ok(system.includes(userNote));
    } else if (marker === "KNOW_OTHER_PROJECT") {
      assert.ok(!system.includes(newFact)); assert.ok(!system.includes(oldFact)); assert.ok(!system.includes(userNote));
    } else throw new Error(`Unknown marker ${marker}`);
    reply(res, body.model, `${marker}_DONE`);
  } catch (error) {
    failure = error;
    if (!res.headersSent) res.writeHead(500);
    res.end(String(error));
  }
});

async function connect(port, type) {
  const target = await until(async () => {
    let response;
    try { response = await fetch(`http://127.0.0.1:${port}/json/list`); }
    catch (error) { if (error.cause?.code === "ECONNREFUSED") return null; throw error; }
    return (await response.json()).find(item => item.type === type && (type !== "page" || item.url.includes("/out/renderer/index.html") && !item.url.includes("surface=")));
  }, `CDP ${type}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl), pending = new Map();
  await new Promise((done, reject) => { ws.addEventListener("open", done, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  ws.addEventListener("message", ({ data }) => {
    const packet = JSON.parse(String(data)), entry = pending.get(packet.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(packet.id);
    packet.error ? entry.reject(new Error(json(packet.error))) : entry.resolve(packet.result);
  });
  const call = (method, params) => new Promise((resolveResult, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 30000);
    pending.set(id, { resolve: resolveResult, reject, timer }); ws.send(json({ id, method, params }));
  });
  return { ws, call, evaluate: async expression => {
    const value = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (value.exceptionDetails) throw new Error(json(value.exceptionDetails));
    return value.result.value;
  } };
}
async function startApp() {
  const ports = [await freePort(), await freePort()];
  const env = { ...process.env, HOME: home, PI_DESKTOP_DATA_DIR: data, PI_DESKTOP_HOST_BIN: hostBinary,
    PI_DESKTOP_PLAN_UI_PROBE: "1", PI_DESKTOP_TEST_API_KEY: "local-fixture", PI_DESKTOP_TEST_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, PI_DESKTOP_TEST_MODEL: "knowledge-fixture", ELECTRON_RENDERER_URL: "", PI_DESKTOP_START_MAXIMIZED: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(resolveElectronBinary(root).electronBinary, [`--remote-debugging-port=${ports[0]}`, `--inspect=${ports[1]}`, `--user-data-dir=${join(scratch, "profile")}`, "."], { cwd: join(root, "apps/desktop"), env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout.on("data", value => { log += value; }); child.stderr.on("data", value => { log += value; });
  main = await connect(ports[1], "node"); page = await connect(ports[0], "page");
  await until(() => page.evaluate("!!window.piDesktop"), "public preload");
  await until(() => main.evaluate("typeof globalThis.__PI_DESKTOP_PLAN_UI_PROBE === 'function'"), "setup probe");
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
const invokeRaw = (key, ...args) => page.evaluate(`piDesktop.invoke(piDesktop.channels.invoke[${json(key)}],...${json(args)})`);
async function invoke(key, ...args) {
  const result = await invokeRaw(key, ...args);
  assert.equal(result.ok, true, `${key}: ${json(result)}`);
  return result.data;
}
const snapshot = () => invoke("projectKnowledgeGet", { groupId: projectId });
async function createSession(path = projectA) {
  const created = await invoke("sessionCreate", { title: "Project knowledge fixture", mode: "agent", providerId: setup.providerId, modelId: setup.modelId, projectPath: path, permissionMode: "auto" });
  await invoke("sessionConfigure", created.session.id, { mode: "agent", permissionMode: "auto", thinkingLevel: "off" });
  return created.session.id;
}
async function prompt(sessionId, marker) {
  await invoke("agentPrompt", { sessionId, content: `${marker}: Follow this synthetic scenario only.` });
  await until(async () => (await invoke("sessionGet", { id: sessionId })).session.messages.some(message => message.role === "assistant" && message.content === `${marker}_DONE`), marker);
}

try {
  await new Promise((done, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", done); });
  const seed = new Host(hostBinary, data, { env: { HOME: home }, quiet: true });
  try {
    await seed.start();
    projectId = (await seed.call("project.group.create", { name: "Knowledge A", folders: [projectA] })).group.id;
    await seed.call("project.group.create", { name: "Knowledge B", folders: [projectB] });
    await seed.call("project.group.memory.set", { groupId: projectId, entries: [{ id: "fixture-user-note", title: "User note", content: userNote }] });
  } finally { await seed.stop(); }
  await startApp();
  setup = await main.evaluate(`globalThis.__PI_DESKTOP_PLAN_UI_PROBE({operation:'liveSetup',workspace:${json(projectA)}})`);
  assert.equal(setup.ok, true, json(setup));
  const author = await createSession();
  await prompt(author, "KNOW_REMEMBER");
  const first = await snapshot();
  assert.equal(first.entries.length, 1);
  const source = first.entries[0].source;
  const authorMessages = (await invoke("sessionGet", { id: author })).session.messages;
  assert.equal(source.sessionId, author);
  assert.ok(authorMessages.some(message => message.id === source.messageId && message.role === "user"), "Host retains the actual source user message");
  const reader = await createSession();
  await prompt(reader, "KNOW_EXPECT_OLD");
  coverage.push("Real Agent tools → Host write with bound source → fresh ordinary session context; user notes unchanged");
  await prompt(await createSession(), "KNOW_REPLACE");
  const corrected = await snapshot();
  const active = corrected.entries.find(entry => entry.status === "active");
  assert.equal(active.content, newFact);
  assert.equal(active.supersedesId, first.entries[0].id);
  assert.equal(corrected.entries.find(entry => entry.id === first.entries[0].id).status, "superseded");
  await prompt(reader, "KNOW_EXPECT_NEW");
  await prompt(await createSession(), "KNOW_EXPECT_NEW");
  coverage.push("Correction preserves history and refreshes both reused and new-session model context");
  const stale = await invokeRaw("projectKnowledgeForget", { groupId: projectId, entryId: active.id, expectedRevision: first.revision });
  assert.equal(stale.ok, false); assert.equal(stale.error.code, "CONFLICT");
  assert.equal((await snapshot()).revision, corrected.revision);
  const pruned = await invoke("projectKnowledgeClearHistory", { groupId: projectId, expectedRevision: corrected.revision });
  assert.equal(pruned.entries.length, 1); assert.equal(pruned.entries[0].id, active.id);
  assert.equal(pruned.entries[0].content, newFact, "history cleanup preserves the active record");
  await invoke("projectKnowledgeForget", { groupId: projectId, entryId: active.id, expectedRevision: pruned.revision });
  await prompt(await createSession(), "KNOW_EXPECT_FORGOTTEN");
  await prompt(await createSession(projectB), "KNOW_OTHER_PROJECT");
  coverage.push("IPC history cleanup preserves active records; forget/CAS conflict without partial persistence; cross-project isolation");
  await stopApp(); await startApp();
  await prompt(await createSession(), "KNOW_EXPECT_FORGOTTEN");
  assert.equal((await snapshot()).entries.find(entry => entry.id === active.id).status, "forgotten");
  coverage.push("Desktop/Host restart retains history and forgotten state without resurrecting current context");
  await writeFile(join(output, "result.json"), json({ passed: true, coverage, requests: observed.length, projectId, final: await snapshot() }, null, 2));
  console.log(`PASS ${coverage.join("; ")}\nEvidence: ${output}`);
} catch (error) {
  await writeFile(join(output, "failure.json"), json({ passed: false, error: String(error), stack: error.stack, coverage, observed }, null, 2));
  throw error;
} finally {
  await stopApp();
  model.closeAllConnections(); await new Promise(done => model.close(done));
  await writeFile(join(output, "desktop.log"), log);
}
