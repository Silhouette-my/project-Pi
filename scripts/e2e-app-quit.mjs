#!/usr/bin/env node
/** Production Electron quit journey: the app must exit promptly and cleanly.
 * Usage: node scripts/e2e-app-quit.mjs [--output /absolute/evidence-dir] [--budget-ms 5000]
 *
 * E2E-QUIT-prompt-exit. An app with a real chat turn and a side chat (a workspace chat, so
 * the project Agent tab is open too) is terminated three ways while idle: SIGTERM (what a supervisor or system shutdown sends), SIGINT, and
 * CDP Browser.close. Each asserts that the main process and every descendant (host-core,
 * agent sidecar, plugin hosts, renderers) are gone within the budget, that the quit
 * confirmation did not hold the exit, that main logged an ordered `app shutdown`, and that
 * `PRAGMA integrity_check` on the profile database is `ok`.
 * A fourth run quits (the plain Cmd+Q path) while a turn is still running: the confirmation
 * dialog must hold the app until answered, then exit promptly on Confirm. Idle explicit quits
 * (Browser.close above) never wait on that dialog.
 * All mutable data is isolated in a temp dir; only PIDs this script started are signalled.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repositoryRoot, assertDesktopBuild, resolveElectronBinary } from "./e2e/boot.mjs";
import { Host } from "./e2e/host.mjs";

const root = resolve(repositoryRoot());
assertDesktopBuild(root);
const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const output = arg("--output") ? resolve(arg("--output")) : await mkdtemp(join(tmpdir(), "pi-quit-"));
const budgetMs = Number(arg("--budget-ms") ?? 5000);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "pi-quit-state-"));
const home = join(scratch, "home"), data = join(scratch, "data"), profile = join(scratch, "profile");
for (const path of [home, data, profile]) await mkdir(path, { recursive: true });
const hostBinary = process.env.PI_DESKTOP_HOST_BIN || join(root, "target/debug/pi-desktop-host-core");
const electronBinary = process.env.PI_DESKTOP_ELECTRON_BIN || resolveElectronBinary(root).electronBinary;
const json = JSON.stringify, sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let sequence = 0, main, page, browser, child, log = "";
const results = [], modelRequests = [];
const step = (name) => console.log(`[e2e-quit ${new Date().toISOString()}] ${name}`);
let completed = 0;
const holdTurn = Promise.withResolvers();

const model = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(json({ object: "list", data: [{ id: "ui-fixture", object: "model", owned_by: "local-fixture" }] }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const request = JSON.parse(raw);
  modelRequests.push(request);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const frame = (delta, finish_reason = null) => res.write(`data: ${json({
    id: `quit-${modelRequests.length}`, object: "chat.completion.chunk", created: 1,
    model: request.model, choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  const lastUser = [...(request.messages ?? [])].reverse().find((message) => message.role === "user");
  if (json(lastUser?.content ?? "").includes("HOLD_TURN")) {
    frame({ role: "assistant", content: "HOLDING: " });
    await holdTurn.promise;
  }
  frame({ role: "assistant", content: `QUIT_REPLY_${modelRequests.length}: ` });
  await sleep(100);
  frame({ content: "a short answer." });
  frame({}, "stop");
  res.end("data: [DONE]\n\n");
  completed += 1;
});
await new Promise((done, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", done); });

async function freePort() {
  const server = createNetServer(); await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port; await new Promise((done) => server.close(done)); return port;
}
async function until(check, name, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(60); }
  throw new Error(`Timed out waiting for ${name}\n${log.slice(-3000)}`);
}
async function connect(url) {
  const ws = new WebSocket(url), pending = new Map();
  await new Promise((done, reject) => { ws.addEventListener("open", done, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  ws.addEventListener("message", ({ data: raw }) => { const msg = JSON.parse(String(raw)), item = pending.get(msg.id); if (!item) return; pending.delete(msg.id); msg.error ? item.reject(new Error(json(msg.error))) : item.resolve(msg.result); });
  const call = (method, params = {}) => new Promise((resolveCall, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 30000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolveCall(v); }, reject: (e) => { clearTimeout(timer); reject(e); } }); ws.send(json({ id, method, params }));
  });
  return { ws, call, evaluate: async (expression) => { const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(json(r.exceptionDetails)); return r.result.value; } };
}
const targetFor = async (port, type) => until(async () => {
  try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === type && (type !== "page" || item.url.includes("/out/renderer/index.html") && !item.url.includes("surface="))); }
  catch { return null; }
}, `CDP ${type}`);

/** Every process whose ancestry reaches `pid`. */
function descendants(pid) {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const found = new Set([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [id, parent] of rows) if (found.has(parent) && !found.has(id)) { found.add(id); grew = true; }
  }
  return [...found];
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function startApp({ confirmationEnabled = false } = {}) {
  log = "";
  const ports = [await freePort(), await freePort()];
  const env = { ...process.env, HOME: home, PI_DESKTOP_DATA_DIR: data, PI_DESKTOP_HOST_BIN: hostBinary,
    PI_DESKTOP_PLAN_UI_PROBE: "1", PI_DESKTOP_TEST_API_KEY: "local-fixture", PI_DESKTOP_TEST_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, PI_DESKTOP_TEST_MODEL: "ui-fixture", ELECTRON_RENDERER_URL: "", PI_DESKTOP_START_MAXIMIZED: "0" };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PI_DESKTOP_SKIP_QUIT_CONFIRM;
  child = spawn(electronBinary, [`--remote-debugging-port=${ports[0]}`, `--inspect=${ports[1]}`, `--user-data-dir=${profile}`, "."], { cwd: join(root, "apps/desktop"), env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout.on("data", (chunk) => { log += chunk; }); child.stderr.on("data", (chunk) => { log += chunk; });
  main = await connect((await targetFor(ports[1], "node")).webSocketDebuggerUrl);
  page = await connect((await targetFor(ports[0], "page")).webSocketDebuggerUrl);
  const version = await until(async () => { try { return await (await fetch(`http://127.0.0.1:${ports[0]}/json/version`)).json(); } catch { return null; } }, "CDP version");
  browser = await connect(version.webSocketDebuggerUrl);
  await until(() => page.evaluate("!!window.piDesktop && !!document.querySelector('.app-shell:not(.is-booting)')"), "React-ready renderer");
  await until(() => main.evaluate("typeof globalThis.__PI_DESKTOP_PLAN_UI_PROBE === 'function'"), "setup probe");
}
const invoke = async (key, ...args) => {
  const result = await page.evaluate(`piDesktop.invoke(piDesktop.channels.invoke[${json(key)}],...${json(args)})`);
  assert.equal(result.ok, true, `${key}: ${json(result)}`); return result.data;
};
const move = (x, y) => page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
const clickAt = async (x, y) => {
  await move(x, y);
  await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};
const rectOf = (selector) => page.evaluate(`(() => { const el=document.querySelector(${json(selector)}); if(!el) return null; el.scrollIntoView({block:'nearest'}); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,disabled:!!el.disabled}; })()`);
const realClick = async (selector, name) => {
  const target = await until(() => rectOf(selector), name);
  await move(target.x, target.y); await sleep(80);
  const settled = await rectOf(selector);
  await clickAt(settled.x, settled.y);
};
const setTextarea = (selector, value) => page.evaluate(`(() => { const input=document.querySelector(${json(selector)}); if(!input) return false; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value').set.call(input,${json(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.focus(); return true })()`);

/** Real work to lose: a chat reply and a side chat reply, with the project Agent tab open. */
async function seedWork({ hold = false } = {}) {
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });
  const setup = await main.evaluate(`globalThis.__PI_DESKTOP_PLAN_UI_PROBE({operation:'liveSetup',workspace:${json(workspace)}})`);
  assert.equal(setup.ok, true, json(setup));
  await invoke("settingsSet", { ...await invoke("settingsGet"), defaultProviderId: setup.providerId, defaultModelId: setup.modelId });
  await page.call("Page.reload");
  await until(() => page.evaluate("!!document.querySelector('.app-shell:not(.is-booting)')"), "renderer reload");
  // A real click on the row itself (its inner buttons are the status/menu controls).
  await until(() => page.evaluate(`!!document.querySelector('[data-sidebar-session-row="${setup.sessionId}"]')`), "seeded session row");
  await realClick(`[data-sidebar-session-row="${setup.sessionId}"]`, "seeded session row");
  await until(() => page.evaluate(`!!document.querySelector('[data-sidebar-session-row="${setup.sessionId}"].active')`), "seeded session selected");
  await until(() => page.evaluate("!!document.querySelector('.composer-input')"), "composer");
  await page.evaluate(`(() => { const input=document.querySelector('.composer-input'); input.focus(); input.textContent=${json(hold ? 'HOLD_TURN keep this turn running.' : 'Explain the plan in one sentence.')}; input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'x'})); })()`);
  await until(() => page.evaluate("!!document.querySelector('.composer-toolbar .send-btn:not(:disabled)')"), "send enabled");
  await page.evaluate("document.querySelector('.composer-toolbar .send-btn').click()");
  if (hold) {
    await until(() => modelRequests.length >= 1, "the held turn reaches the model");
    return setup;
  }
  await until(() => completed >= 1, "chat reply streamed by the fixture");
  await until(() => page.evaluate("!!document.querySelector('.main-pane [data-side-chat-role=assistant]')"), "side chat entry");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await realClick(".main-pane [data-side-chat-role=assistant]", "Ask in side chat");
    const opened = await until(() => page.evaluate("!!document.querySelector('.work-panel [data-side-chat]')"), "side chat tab", 5000).catch(() => false);
    if (opened) break;
    assert.ok(attempt < 3, "side chat tab never opened");
  }
  assert.ok(await setTextarea(".work-panel [data-side-chat-form] textarea", "SIDE_QUESTION: why?"));
  await realClick(".work-panel [data-side-chat-form] .send-btn", "side chat send");
  await until(() => completed >= 2, "side chat reply streamed by the fixture", 30000);
  return setup;
}

function integrity() {
  const out = execFileSync("sqlite3", [join(data, "pi.sqlite"), "PRAGMA integrity_check;"], { encoding: "utf8" }).trim();
  assert.equal(out, "ok", `integrity_check: ${out}`);
}

/** Quit by `how`, then assert everything is gone within the budget. */
async function quitAndMeasure(label, how) {
  const mainPid = child.pid, tree = descendants(mainPid);
  assert.ok(tree.length > 3, `app has helper processes: ${tree.length}`);
  // An attached Node inspector client holds the main process open at exit (it waits for the
  // frontend to detach), so the harness lets go of it before quitting; only the app is judged.
  main.ws.close(); main = undefined;
  const started = Date.now();
  await how(mainPid);
  await until(() => !tree.some(alive), `${label}: every process exits`, budgetMs + 5000).catch((error) => { throw new Error(`${label}: ${error.message}\nstill alive: ${tree.filter(alive)}`); });
  const elapsed = Date.now() - started;
  assert.ok(elapsed <= budgetMs, `${label}: exited in ${elapsed}ms, budget ${budgetMs}ms`);
  assert.match(log, /"event":"app\.shutdown"/, `${label}: ordered shutdown ran`);
  assert.doesNotMatch(log, /host\.core\.exited\.unexpectedly/, `${label}: host stopped as part of shutdown`);
  page?.ws.close(); browser?.ws.close(); page = browser = undefined;
  integrity();
  results.push(`${label}: all ${tree.length} processes gone in ${elapsed}ms; integrity_check ok`);
}

try {
  const seed = new Host(hostBinary, data, { env: { HOME: home }, quiet: true });
  try { await seed.start(); } finally { await seed.stop(); }

  const scenarios = [
    ["SIGTERM", (pid) => process.kill(pid, "SIGTERM")],
    ["SIGINT", (pid) => process.kill(pid, "SIGINT")],
    ["CDP Browser.close", () => { void browser.call("Browser.close").catch(() => undefined); }],
  ];
  for (const [index, [label, how]] of scenarios.entries()) {
    step(`start ${label}`);
    await startApp();
    step(`started ${label}`);
    if (index === 0) await seedWork();
    else await sleep(1500);
    step(`quit ${label}`);
    await quitAndMeasure(label, how);
  }

  // The plain Cmd+Q path asks while a turn is running: pending means alive, Confirm means prompt exit.
  step("start Cmd+Q with a running turn");
  await startApp();
  await seedWork({ hold: true });
  const mainPid = child.pid, tree = descendants(mainPid);
  await main.evaluate(`setImmediate(() => process.mainModule.require('electron').app.quit()), 0`);
  main.ws.close(); main = undefined;
  await until(() => page.evaluate("!!document.querySelector('.lifecycle-confirmation-dialog')"), "quit confirmation dialog");
  await sleep(1500);
  assert.ok(alive(mainPid), "the app waits for the answer");
  const confirmedAt = Date.now();
  await page.evaluate("[...document.querySelectorAll('.lifecycle-confirmation-actions button')].at(-1).click()");
  await until(() => !tree.some(alive), "confirmed quit exits", budgetMs + 5000);
  const confirmedMs = Date.now() - confirmedAt;
  assert.ok(confirmedMs <= budgetMs, `confirmed quit exited in ${confirmedMs}ms`);
  holdTurn.resolve();
  results.push(`Cmd+Q with a running turn: dialog held the app until Confirm, then all processes gone in ${confirmedMs}ms`);
  page?.ws.close(); browser?.ws.close(); page = browser = undefined;
  integrity();

  const report = ["E2E-QUIT-prompt-exit PASS", ...results, `budget ${budgetMs}ms`, `model requests ${modelRequests.length}`].join("\n");
  await writeFile(join(output, "result.txt"), report + "\n");
  console.log(report);
} catch (error) {
  const dom = await page?.evaluate("[...document.querySelectorAll('.main-pane [data-session-pane]')].map((e) => e.dataset.visible + ':' + e.innerText.slice(-200)).join('|')").catch(() => "n/a");
  const shot = await page?.call("Page.captureScreenshot", { format: "png" }).catch(() => null);
  if (shot) await writeFile(join(output, "failure.png"), Buffer.from(shot.data, "base64"));
  await writeFile(join(output, "failure.log"), `${error.stack}\n\nrequests=${modelRequests.length}\nDOM=${dom}\n\n${log}`).catch(() => {});
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  try { if (child?.pid) for (const pid of descendants(child.pid)) { try { process.kill(pid, "SIGKILL"); } catch {} } } catch {}
  model.close();
  await rm(scratch, { recursive: true, force: true });
}
