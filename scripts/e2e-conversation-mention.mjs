#!/usr/bin/env node
/** Production Electron renderer journey for @-mentions of conversations.
 * Usage: node scripts/e2e-conversation-mention.mjs [--output /absolute/evidence-dir]
 *
 * E2E-CHAT-conversation-mention. A real chat is driven against a loopback model
 * fixture. In the main Composer, typing `@` opens the list (current project, other
 * projects), a mid-word `@` does not, Enter inserts an atomic `@title` chip that
 * Backspace deletes whole, and the sent message shows the token (tooltip, click
 * opens it) while the model request carries the referenced conversation's context
 * block. The same holds for the plain-textarea composer of a chat side chat.
 * All mutable Host data is isolated; input is real CDP input.
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
const output = outputArg < 0 ? await mkdtemp(join(tmpdir(), "pi-mention-")) : resolve(process.argv[outputArg + 1]);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "pi-mention-state-"));
const home = join(scratch, "home"), data = join(scratch, "data");
for (const path of [home, data]) await mkdir(path, { recursive: true });
const hostBinary = process.env.PI_DESKTOP_HOST_BIN || join(root, "target/debug/pi-desktop-host-core");
const electronBinary = process.env.PI_DESKTOP_ELECTRON_BIN || resolveElectronBinary(root).electronBinary;
const json = JSON.stringify, sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let sequence = 0, main, page, child, log = "";
const coverage = [], modelRequests = [];
const MARKER = "REFERENCE_MARKER_7731";

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
    id: `mention-${modelRequests.length}`, object: "chat.completion.chunk", created: 1,
    model: request.model, choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  frame({ role: "assistant", content: `FIXTURE_REPLY_${modelRequests.length}: ` });
  await sleep(100);
  frame({ content: "a short answer." });
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
const realClick = async (selector, name) => {
  const target = await until(() => rectOf(selector), name);
  await move(target.x, target.y);
  await sleep(80);
  const settled = await rectOf(selector);
  assert.equal(settled.disabled, false, `${name} is enabled`);
  await clickAt(settled.x, settled.y);
};
const KEYS = { Enter: 13, Backspace: 8, ArrowDown: 40, ArrowUp: 38, Escape: 27, Tab: 9 };
const pressKey = async (key) => {
  const base = { key, code: key, windowsVirtualKeyCode: KEYS[key], nativeVirtualKeyCode: KEYS[key] };
  await page.call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, ...(key === "Enter" ? { text: "\r" } : {}) });
  await page.call("Input.dispatchKeyEvent", { type: "keyUp", ...base });
};
const typeText = (text) => page.call("Input.insertText", { text });
const focus = (selector) => page.evaluate(`(() => { const el=document.querySelector(${json(selector)}); if(!el) return false; el.focus(); if (el.isContentEditable) { const r=document.createRange(); r.selectNodeContents(el); r.collapse(false); const s=getSelection(); s.removeAllRanges(); s.addRange(r); } else { el.setSelectionRange(el.value.length, el.value.length); } return true })()`);
const sessions = async () => (await invoke("sessionList")).sessions;
const visibleMainSession = () => page.evaluate(`document.querySelector('.main-pane [data-session-pane][data-visible="true"]')?.dataset.sessionPane ?? null`);
const openSession = async (id) => {
  await until(() => page.evaluate(`(() => { const row=document.querySelector('[data-sidebar-session-row="${id}"]'); if(!row) return false; (row.querySelector('button')||row).click(); return true })()`), `sidebar row ${id}`);
  await until(async () => (await visibleMainSession()) === id || page.evaluate(`!!document.querySelector('[data-sidebar-session-row="${id}"] [aria-current=page], [data-sidebar-session-row="${id}"][aria-current=page]')`), `session ${id} active`);
};
const sendMain = async (text) => {
  await until(() => page.evaluate("!!document.querySelector('.composer-input')"), "composer");
  await focus(".composer-input");
  await typeText(text);
  await until(() => page.evaluate("!!document.querySelector('.composer-toolbar .send-btn:not(:disabled)')"), "send enabled");
  await pressKey("Enter");
};
const options = () => page.evaluate(`[...document.querySelectorAll('.composer-autocomplete [role=option].mention-row')].map((el) => ({ title: el.querySelector('.mention-row-title')?.textContent ?? el.textContent, secondary: el.querySelector('.mention-row-secondary')?.textContent ?? '' }))`);
const groupLabels = () => page.evaluate(`[...document.querySelectorAll('.composer-autocomplete .composer-model-group-label')].map((el) => el.textContent)`);
const requestWith = (needle, from = 0) => modelRequests.slice(from).filter((request) => json(request.messages ?? []).includes(needle));

try {
  const seed = new Host(hostBinary, data, { env: { HOME: home }, quiet: true });
  try { await seed.start(); } finally { await seed.stop(); }
  await startApp();
  const setup = await main.evaluate(`globalThis.__PI_DESKTOP_PLAN_UI_PROBE({operation:'liveSetup',workspace:${json(join(root, "apps"))}})`);
  assert.equal(setup.ok, true, json(setup));
  const currentId = setup.sessionId;
  await invoke("settingsSet", { ...await invoke("settingsGet"), defaultProviderId: setup.providerId, defaultModelId: setup.modelId });
  const create = (title, projectPath) => invoke("sessionCreate", { title, mode: "agent", providerId: setup.providerId, modelId: setup.modelId, projectPath, permissionMode: "auto" });
  const sibling = (await create("Alpha ledger notes", join(root, "apps"))).session;
  const other = (await create("Beta elsewhere", join(root, "packages"))).session;
  await page.call("Page.reload");
  await until(() => page.evaluate("!!document.querySelector('.app-shell:not(.is-booting)')"), "renderer reload after Host setup");

  // 0. The sibling gets real content so its context is distinguishable.
  await openSession(sibling.id);
  await sendMain(`${MARKER} ledger totals for the quarter`);
  await until(() => page.evaluate("document.querySelector('.main-pane')?.innerText.includes('FIXTURE_REPLY')"), "sibling reply");
  const siblingTitle = (await sessions()).find((item) => item.id === sibling.id).title;
  const otherTitle = (await sessions()).find((item) => item.id === other.id).title;
  const query = siblingTitle.slice(0, 5);
  await openSession(currentId);
  await page.evaluate("document.documentElement.dataset.theme='light'");

  // 1. Mid-word `@` is text; `@` after whitespace opens the list.
  await focus(".composer-input");
  await typeText("mail me@");
  await sleep(300);
  assert.equal((await options()).length, 0, "an @ inside a word opens nothing");
  await page.evaluate(`(() => { const el=document.querySelector('.composer-input'); el.textContent=''; el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContent'})); })()`);
  await focus(".composer-input");
  await typeText("compare @");
  await until(async () => (await options()).length >= 2, "mention list");
  let rows = await options();
  assert.ok(rows.some((row) => row.title === siblingTitle), `sibling listed: ${json(rows)}`);
  assert.ok(rows.some((row) => row.title === otherTitle && row.secondary === "packages"), `other project row with its project: ${json(rows)}`);
  assert.ok(!rows.some((row) => row.title === setup.title), "the current conversation is excluded");
  const labels = await groupLabels();
  assert.ok(labels.length >= 2, `group labels: ${json(labels)}`);
  await capture("01-mention-popover-light.png");
  coverage.push("@ after whitespace opens the list with the current project, other projects and project names, excluding the current conversation; a mid-word @ opens nothing");

  // 2. Search-as-you-type narrows; arrows move; Enter inserts an atomic chip.
  await typeText(query);
  await until(async () => (await options()).length === 1, "list narrowed by the query");
  assert.equal((await options())[0].title, siblingTitle);
  await pressKey("Enter");
  await until(() => page.evaluate("!!document.querySelector('.composer-input .composer-chip[data-mention]')"), "mention chip inserted");
  const chip = await page.evaluate(`(() => { const el=document.querySelector('.composer-input .composer-chip[data-mention]'); return { text: el.textContent, title: el.title, icons: el.querySelectorAll('.composer-chip-icon,svg').length }; })()`);
  assert.equal(chip.text, `@${siblingTitle}`);
  assert.ok(chip.title.includes(siblingTitle), `tooltip: ${chip.title}`);
  assert.equal(chip.icons, 0, "no icon");
  assert.equal((await options()).length, 0, "the list closed");
  await capture("02-mention-chip-in-draft-light.png");
  coverage.push("Search narrows the list, Enter inserts a quiet @title chip with a tooltip and no icon");

  // 3. Backspace deletes the whole token.
  await pressKey("Backspace");
  await until(() => page.evaluate("!document.querySelector('.composer-input .composer-chip[data-mention]')"), "Backspace removed the chip whole");
  await typeText("@");
  await until(async () => (await options()).length >= 2, "list reopens");
  await pressKey("Escape");
  await until(async () => (await options()).length === 0, "Escape closes the list");
  await page.evaluate(`(() => { const el=document.querySelector('.composer-input'); el.textContent=''; el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContent'})); })()`);
  await focus(".composer-input");
  await typeText("@");
  await until(async () => (await options()).length >= 2, "list for the send");
  await typeText(query);
  await until(async () => (await options()).length === 1, "narrowed again");
  await realClick(".composer-autocomplete [role=option].mention-row", "click a row");
  await until(() => page.evaluate("!!document.querySelector('.composer-input .composer-chip[data-mention]')"), "click inserted the chip");
  coverage.push("Backspace removes the token whole, Escape closes the list, a row click inserts the chip");

  // 4. Send: the message shows the token; the model receives the referenced context.
  await typeText(" what were the totals?");
  await until(() => page.evaluate("!!document.querySelector('.composer-toolbar .send-btn:not(:disabled)')"), "send enabled");
  const sentBefore = modelRequests.length;
  await pressKey("Enter");
  await until(() => modelRequests.length > sentBefore, "request reached the model");
  const mainRequest = requestWith(MARKER, sentBefore).at(-1);
  assert.ok(mainRequest, "the referenced conversation's context reached the model");
  const mainText = json(mainRequest.messages);
  assert.ok(mainText.includes("session_reference") && mainText.includes(siblingTitle), "the context block names the conversation");
  assert.ok(mainText.includes("what were the totals?"), "the user's words are kept");
  await until(() => page.evaluate("!!document.querySelector('.main-pane .message-row.user [data-action=open-session-reference]')"), "sent token");
  const sent = await page.evaluate(`(() => { const el=document.querySelector('.main-pane .message-row.user [data-action=open-session-reference]'); return { text: el.textContent, title: el.title, id: el.dataset.sessionId, icons: el.querySelectorAll('svg').length }; })()`);
  assert.equal(sent.text, `@${siblingTitle}`);
  assert.equal(sent.id, sibling.id);
  assert.ok(sent.title.includes(siblingTitle));
  assert.equal(sent.icons, 0);
  await until(() => page.evaluate("document.querySelectorAll('.main-pane .message-row.assistant').length >= 1"), "reply");
  await capture("03-mention-sent-light.png");
  // The chip can sit under the docked project Agent panel at this window size, so the handler is invoked directly.
  await page.evaluate("document.querySelector('.main-pane .message-row.user [data-action=open-session-reference]').click()");
  await until(async () => (await visibleMainSession()) === sibling.id, "the token opens that conversation");
  coverage.push("The sent message renders the token inline with its tooltip, a click opens the conversation, and the model request carries the referenced conversation's context block next to the user's words");

  // 5. Plain-textarea composer: a chat side chat.
  await openSession(currentId);
  await until(() => page.evaluate("!!document.querySelector('.main-pane [data-side-chat-role=assistant]')"), "Ask in side chat entry");
  await realClick(".main-pane [data-side-chat-role=assistant]", "Ask in side chat button");
  const SIDE = ".work-panel [data-side-chat-form] textarea";
  await until(() => page.evaluate(`!!document.querySelector(${json(SIDE)})`), "side chat textarea");
  await focus(SIDE);
  await typeText("see @");
  await until(() => page.evaluate("!!document.querySelector('.mention-popover [role=option]')"), "side chat mention list");
  await typeText(query);
  await until(async () => (await options()).length === 1, "side list narrowed");
  await capture("04-side-chat-popover-light.png");
  await pressKey("Enter");
  await until(() => page.evaluate(`document.querySelector(${json(SIDE)}).value.includes('@' + ${json(siblingTitle)})`), "token text in the draft");
  await until(() => page.evaluate("!!document.querySelector('.work-panel .mention-mirror mark')"), "token tile painted");
  await typeText("SIDE_Q what did it say?");
  await capture("05-side-chat-token-light.png");
  const sideBefore = modelRequests.length;
  await realClick(".work-panel [data-side-chat-form] .send-btn", "side chat send");
  await until(() => modelRequests.length > sideBefore, "side chat request reached the model");
  const sideRequest = requestWith("SIDE_Q", sideBefore).at(-1);
  assert.ok(sideRequest && json(sideRequest.messages).includes(MARKER), "the side chat model request carries the referenced context");
  await until(() => page.evaluate("!!document.querySelector('.work-panel [data-action=open-session-reference]')"), "token in the side chat transcript");
  await capture("06-side-chat-sent-light.png");
  coverage.push("The plain-textarea side chat composer opens the same list at the caret, inserts a tiled @title token, and its first Send gives the model the referenced context");

  await writeFile(join(output, "result.json"), json({ ok: true, coverage, modelRequestCount: modelRequests.length }, null, 2));
  await rm(join(output, "failure.txt"), { force: true }); await rm(join(output, "failure.png"), { force: true });
} catch (error) {
  await writeFile(join(output, "failure.txt"), String(error.stack ?? error) + "\n" + log.slice(-9000));
  if (page) { try { await capture("failure.png"); } catch {} }
  throw error;
} finally { await stopApp(); model.close(); await rm(scratch, { recursive: true, force: true }); }
console.log(`Conversation mention passed: ${output}`);
