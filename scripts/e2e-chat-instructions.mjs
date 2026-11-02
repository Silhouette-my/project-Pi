#!/usr/bin/env node
/** Production Electron renderer journey for chat instructions on every provider.
 * Usage: node scripts/e2e-chat-instructions.mjs [--output /absolute/evidence-dir]
 *
 * E2E-CHAT-instructions-all-sessions (D671). A real non-ChatGPT session (OpenAI-compatible
 * loopback fixture) shows the Chat instructions chip defaulting to None; choosing a bundled
 * preset appends its text to the agent system prompt of the next model request while the
 * agent prompt stays; a chat side chat shows the same chip starting on None even though
 * its parent has a preset, and a preset picked before the first Send is applied to the
 * forked child. All mutable Host data is isolated; input is real CDP pointer input.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repositoryRoot, assertDesktopBuild, resolveElectronBinary } from "./e2e/boot.mjs";
import { Host } from "./e2e/host.mjs";

const root = resolve(repositoryRoot());
assertDesktopBuild(root);
const outputArg = process.argv.indexOf("--output");
const output = outputArg < 0 ? await mkdtemp(join(tmpdir(), "pi-chat-instructions-")) : resolve(process.argv[outputArg + 1]);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "pi-chat-instructions-state-"));
const home = join(scratch, "home"), data = join(scratch, "data");
for (const path of [home, data]) await mkdir(path, { recursive: true });
const hostBinary = process.env.PI_DESKTOP_HOST_BIN || join(root, "target/debug/pi-desktop-host-core");
const electronBinary = process.env.PI_DESKTOP_ELECTRON_BIN || resolveElectronBinary(root).electronBinary;
const json = JSON.stringify, sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let sequence = 0, main, page, child, log = "";
const coverage = [], modelRequests = [];
let holdParent = null;

const lastUserText = (request) => {
  const last = [...(request.messages ?? [])].reverse().find((message) => message.role === "user");
  const content = last?.content;
  return typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
};
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
  const prompt = lastUserText(request);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const frame = (delta, finish_reason = null) => res.write(`data: ${json({
    id: `side-chat-${modelRequests.length}`, object: "chat.completion.chunk", created: 1,
    model: request.model, choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  if (prompt.includes("HOLD_PARENT") && holdParent) await holdParent.promise;
  // A side-chat request whose newest user turn is not the question is the summary prompt.
  const sideHistory = json(request.messages ?? []).includes("SIDE_QUESTION");
  const label = prompt.includes("SIDE_QUESTION") ? "SIDE_REPLY" : sideHistory ? "SIDE_SUMMARY" : "MAIN_REPLY";
  frame({ role: "assistant", content: `${label}_${modelRequests.length}: ` });
  await sleep(label === "SIDE_SUMMARY" ? 900 : 120);
  frame({ content: `a short answer for request ${modelRequests.length}.` });
  frame({}, "stop");
  res.end("data: [DONE]\n\n");
});
await new Promise((done, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", done); });

async function freePort() {
  const server = createNetServer(); await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port; await new Promise((done) => server.close(done)); return port;
}
async function until(check, name, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(60); }
  throw new Error(`Timed out waiting for ${name}\n${log.slice(-4000)}`);
}
async function connect(port, type) {
  const target = await until(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === type && (type !== "page" || item.url.includes("/out/renderer/index.html") && !item.url.includes("surface="))); }
    catch { return null; }
  }, `CDP ${type}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl), pending = new Map();
  await new Promise((done) => ws.addEventListener("open", done, { once: true }));
  ws.addEventListener("message", ({ data: raw }) => { const msg = JSON.parse(String(raw)), item = pending.get(msg.id); if (!item) return; clearTimeout(item.timer); pending.delete(msg.id); msg.error ? item.reject(new Error(json(msg.error))) : item.resolve(msg.result); });
  const call = (method, params = {}) => new Promise((resolveCall, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 30000);
    pending.set(id, { resolve: resolveCall, reject, timer }); ws.send(json({ id, method, params }));
  });
  return { ws, call, evaluate: async (expression) => { const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(json(result.exceptionDetails)); return result.result.value; } };
}
async function stopApp() {
  main?.ws.close(); page?.ws.close(); main = page = undefined;
  if (!child || child.exitCode !== null) return;
  const current = child, exited = new Promise((done) => current.once("exit", done));
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
  child.stdout.on("data", (chunk) => { log += chunk; }); child.stderr.on("data", (chunk) => { log += chunk; });
  main = await connect(ports[1], "node"); page = await connect(ports[0], "page");
  await until(() => page.evaluate("!!window.piDesktop && !!document.querySelector('.app-shell:not(.is-booting)')"), "React-ready renderer and preload");
  await until(() => main.evaluate("typeof globalThis.__PI_DESKTOP_PLAN_UI_PROBE === 'function'"), "setup probe");
}
const invoke = async (key, ...args) => {
  const result = await page.evaluate(`piDesktop.invoke(piDesktop.channels.invoke[${json(key)}],...${json(args)})`);
  assert.equal(result.ok, true, `${key}: ${json(result)}`); return result.data;
};
const capture = async (name) => { const shot = await page.call("Page.captureScreenshot", { format: "png" }); await writeFile(join(output, name), Buffer.from(shot.data, "base64")); };
const move = (x, y) => page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
const clickAt = async (x, y) => {
  await move(x, y);
  await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};
const rectOf = (selector) => page.evaluate(`(() => { const el=document.querySelector(${json(selector)}); if(!el) return null; el.scrollIntoView({block:'nearest'}); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,width:r.width,height:r.height,disabled:!!el.disabled}; })()`);
/** Real pointer click: hover first so hover-only action rows are laid out, then press. */
const realClick = async (selector, name) => {
  const target = await until(() => rectOf(selector), name);
  await move(target.x, target.y);
  await sleep(80);
  const settled = await rectOf(selector);
  assert.equal(settled.disabled, false, `${name} is enabled`);
  await clickAt(settled.x, settled.y);
};
const setTextarea = (selector, value) => page.evaluate(`(() => { const input=document.querySelector(${json(selector)}); if(!input) return false; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value').set.call(input,${json(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.focus(); return true })()`);
const sessionIds = async () => (await invoke("sessionList")).sessions.map((session) => session.id);
const visibleMainSession = () => page.evaluate(`document.querySelector('.main-pane [data-session-pane][data-visible="true"]')?.dataset.sessionPane ?? null`);

const CHIP = ".composer-chat-instruction-chip";
const WORK_CHIP = `.work-panel ${CHIP}`;
const MAIN_CHIP = `.main-pane ${CHIP}`;
const chipState = (selector) => page.evaluate(`(() => { const el=document.querySelector(${json(selector)}); return el ? { preset: el.dataset.preset, disabled: !!el.disabled, text: el.innerText.trim() } : null })()`);
const systemText = (request) => json((request.messages ?? []).filter((message) => message.role === "system" || message.role === "developer"));
const pick = async (chip, option) => {
  await realClick(chip, "Chat instructions chip");
  await realClick(`[data-chat-instruction-option="${option}"]`, `preset ${option}`);
  await until(async () => (await chipState(chip))?.preset === option, `chip shows ${option}`);
};
const sendMain = async (text) => {
  await page.evaluate(`(() => { const input=document.querySelector('.composer-input'); input.focus(); input.textContent=${json(text)}; input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'x'})); })()`);
  await until(() => page.evaluate("!!document.querySelector('.composer-toolbar .send-btn:not(:disabled)')"), "send enabled");
  await page.evaluate("document.querySelector('.composer-toolbar .send-btn').click()");
};
const panelState = () => page.evaluate(`document.querySelector('.work-panel.edge-panel')?.dataset.edgeState ?? null`);
const sideSession = () => page.evaluate(`document.querySelector('.work-panel [data-side-chat]')?.dataset.sideChatSession ?? null`);
const panelText = () => page.evaluate(`document.querySelector('.work-panel [data-side-chat]')?.innerText ?? ''`);
const RIGHT_FORM = '.work-panel [data-side-chat-form] textarea';
const QA = "问答助手", TECH = "技术讨论伙伴";

try {
  const seed = new Host(hostBinary, data, { env: { HOME: home }, quiet: true });
  try { await seed.start(); } finally { await seed.stop(); }
  await startApp();
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });
  const setup = await main.evaluate(`globalThis.__PI_DESKTOP_PLAN_UI_PROBE({operation:'liveSetup',workspace:${json(workspace)}})`);
  assert.equal(setup.ok, true, json(setup));
  const parentId = setup.sessionId;
  await invoke("settingsSet", { ...await invoke("settingsGet"), defaultProviderId: setup.providerId, defaultModelId: setup.modelId });
  await page.call("Page.reload");
  await until(() => page.evaluate("!!document.querySelector('.app-shell:not(.is-booting)')"), "renderer reload after Host setup");
  await until(() => page.evaluate(`(() => { const row=document.querySelector('[data-sidebar-session-row="${parentId}"]'); if(!row) return false; (row.querySelector('button')||row).click(); return true })()`), "seeded session row");
  await page.evaluate("document.documentElement.dataset.theme='light'");
  await until(() => page.evaluate("!!document.querySelector('.composer-input')"), "composer");
  // The project Agent tab opens with the chat's project; the first part of the journey is the main composer behind it.
  if (await page.evaluate("!!document.querySelector('.work-panel [data-project-agent-dock]')")) {
    const agentChip = await chipState(WORK_CHIP);
    assert.equal(agentChip?.preset, "none", `the project Agent composer shows the chip on None: ${json(agentChip)}`);
    await capture("00-project-agent-chip-none-light.png");
    await realClick(".work-panel .work-panel-tab-close", "close the project Agent tab");
    await until(() => page.evaluate("!document.querySelector('.work-panel [data-project-agent-dock]')"), "Agent tab closed");
  }
  await move(300, 600);
  await page.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until(async () => (await panelState()) === null, "panel auto-hidden", 8000);

  // 1. A non-ChatGPT local session shows the chip, defaulting to None.
  const sessionApi = (await invoke("sessionList")).sessions.find((session) => session.id === parentId);
  assert.notEqual(sessionApi.providerId, undefined);
  await until(async () => (await chipState(MAIN_CHIP)) !== null, "the chip is rendered for a non-ChatGPT provider");
  let chip = await chipState(MAIN_CHIP);
  assert.equal(chip.preset, "none", `new conversation defaults to None: ${json(chip)}`);
  assert.equal(chip.disabled, false);
  assert.equal(sessionApi.promptPreset, "none", "the host stored none for the new session");
  await capture("01-chat-chip-none-light.png");
  coverage.push("A non-ChatGPT local session shows the Chat instructions chip defaulting to None, stored by the host as none");

  // 2. With None the request carries no instruction.
  await sendMain("First question.");
  await until(() => page.evaluate("document.querySelector('.main-pane')?.textContent.includes('MAIN_REPLY_1')"), "first reply");
  assert.ok(!systemText(modelRequests[0]).includes(QA) && !systemText(modelRequests[0]).includes(TECH), "None adds no instruction");
  const agentPromptLength = systemText(modelRequests[0]).length;
  assert.ok(agentPromptLength > 500, "the agent system prompt is present");
  coverage.push("With None the model request carries the agent system prompt and no instruction text");

  // 3. Choosing a preset appends its text to the next request; the agent prompt stays.
  await pick(MAIN_CHIP, "q-and-a");
  await realClick(".main-pane .composer-input", "composer input").catch(() => {});
  await capture("02-chat-chip-qa-light.png");
  await sendMain("Second question.");
  await until(() => page.evaluate("document.querySelector('.main-pane')?.textContent.includes('MAIN_REPLY_2')"), "second reply");
  const second = systemText(modelRequests[1]);
  assert.ok(second.includes(QA), "preset text reaches the fixture model request " + second.length + " " + second.slice(-300) + " " + json(modelRequests[1].messages.map((m) => m.role)));
  assert.ok(second.length > agentPromptLength, "the instruction is appended to the agent prompt");
  assert.ok(Array.isArray(modelRequests[1].tools) && modelRequests[1].tools.length > 0, "tools stay declared");
  const stored = (await invoke("sessionList")).sessions.find((session) => session.id === parentId);
  assert.equal(stored.promptPreset, "q-and-a");
  coverage.push("Choosing Q&A sends its text appended to the unchanged agent prompt (tools still declared) and persists it on the session");

  // 4. Menu screenshots, light and dark.
  await realClick(MAIN_CHIP, "Chat instructions chip");
  await until(() => page.evaluate("!!document.querySelector('.composer-chat-instructions-menu')"), "menu open");
  await capture("03-chat-menu-light.png");
  await page.evaluate("document.documentElement.dataset.theme='dark'");
  await sleep(150);
  await capture("04-chat-menu-dark.png");
  await page.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.evaluate("document.documentElement.dataset.theme='light'");
  await until(() => page.evaluate("!document.querySelector('.composer-chat-instructions-menu')"), "menu closed");

  // 5. A side chat shows the chip starting on None although the parent has a preset.
  await until(() => page.evaluate("!!document.querySelector('.main-pane [data-side-chat-role=assistant]')"), "Ask in side chat entry");
  await realClick(".main-pane [data-side-chat-role=assistant]", "Ask in side chat button");
  await until(async () => (await panelState()) === "open", "panel reveals", 4000);
  await until(async () => (await chipState(WORK_CHIP)) !== null, "the side chat shows the chip");
  assert.equal((await chipState(WORK_CHIP)).preset, "none", "a side chat starts on None");
  await capture("05-side-chat-chip-none-light.png");
  coverage.push("A side chat composer shows the same chip, starting on None even though its parent uses Q&A");

  // 6. A preset picked before the session exists is applied on the first send.
  await pick(WORK_CHIP, "technical-discussion");
  assert.equal(await sideSession(), "", "choosing a preset creates no session");
  await realClick(WORK_CHIP, "Chat instructions chip (side chat)");
  await until(() => page.evaluate("!!document.querySelector('.composer-chat-instructions-menu')"), "side chat menu open");
  await capture("06-side-chat-menu-light.png");
  await page.evaluate("document.documentElement.dataset.theme='dark'");
  await sleep(150);
  await capture("07-side-chat-menu-dark.png");
  await page.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.evaluate("document.documentElement.dataset.theme='light'");
  await until(() => page.evaluate("!document.querySelector('.composer-chat-instructions-menu')"), "menu closed");
  assert.ok(await setTextarea(RIGHT_FORM, "SIDE_QUESTION: why that sentence?"));
  const requestsBefore = modelRequests.length;
  await realClick(".work-panel [data-side-chat-form] .send-btn", "Send");
  const childId = await until(async () => (await sideSession()) || null, "child bound to the tab", 20000);
  await until(() => panelText().then((text) => text.includes("SIDE_REPLY")), "side reply", 30000);
  const sideRequest = modelRequests[requestsBefore];
  assert.ok(systemText(sideRequest).includes(TECH), "the pending preset reaches the first side chat request");
  assert.ok(!systemText(sideRequest).includes(QA), "the parent's Q&A is not inherited");
  assert.equal((await chipState(WORK_CHIP)).preset, "technical-discussion", "the chip now reflects the child session");
  const sessions = (await invoke("sessionList")).sessions;
  assert.equal(sessions.find((session) => session.id === childId).promptPreset, "technical-discussion");
  assert.equal(sessions.find((session) => session.id === parentId).promptPreset, "q-and-a", "the parent keeps its own choice");
  await capture("08-side-chat-applied-light.png");
  coverage.push("A preset picked before the first send is held as pending, applied to the forked child (technical discussion in the request), and the parent keeps Q&A");

  // 7. Without a pick a side chat is None, whatever its parent has.
  // The topbar's New side chat always opens another draft (it sits in the edge-reveal hot zone, so activate it directly).
  await page.evaluate(`document.querySelector('[data-nav="new-side-chat"]').click()`);
  await until(async () => (await sideSession()) === "", "a fresh draft tab", 8000);
  assert.equal((await chipState(WORK_CHIP)).preset, "none");
  assert.ok(await setTextarea(RIGHT_FORM, "SIDE_QUESTION: second question"));
  const beforeSecond = modelRequests.length;
  await realClick(".work-panel [data-side-chat-form] .send-btn", "Send (second)");
  const secondChild = await until(async () => (await sideSession()) || null, "second child", 20000);
  await until(() => panelText().then((text) => text.includes("SIDE_REPLY")), "second side reply", 30000);
  const plainSide = systemText(modelRequests[beforeSecond]);
  assert.ok(!plainSide.includes(QA) && !plainSide.includes(TECH), "an unpicked side chat sends no instruction");
  assert.equal((await invoke("sessionList")).sessions.find((session) => session.id === secondChild).promptPreset, "none");
  coverage.push("A side chat without a pick resets the inherited preset to None before its first request");

  await writeFile(join(output, "result.json"), json({ ok: true, coverage, modelRequestCount: modelRequests.length }, null, 2));
  await rm(join(output, "failure.txt"), { force: true }); await rm(join(output, "failure.png"), { force: true });
} catch (error) {
  await writeFile(join(output, "failure.txt"), String(error.stack ?? error) + "\nmodelRequests=" + modelRequests.length + "\n" + log.slice(-9000));
  if (page) { try { await capture("failure.png"); } catch {} }
  throw error;
} finally { await stopApp(); model.close(); await rm(scratch, { recursive: true, force: true }); }
console.log(`Chat instructions passed: ${output}`);
