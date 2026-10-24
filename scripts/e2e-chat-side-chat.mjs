#!/usr/bin/env node
/** Production Electron renderer journey for chat side chats on detached transcripts.
 * Usage: node scripts/e2e-chat-side-chat.mjs [--output /absolute/evidence-dir]
 *
 * E2E-CHAT-side-chat-detached-panel. A real chat is driven against a loopback model
 * fixture: Ask in side chat opens a draft tab (no session), typing creates nothing,
 * the first Send forks the child without switching the visible session, the reply
 * streams in the panel, the floating return pill defaults to None (no return button),
 * Summary asks the side chat for a summary and All quotes the exchange, both only into
 * the parent draft and never sending, Open as a conversation activates the child, and
 * closing a tab keeps its child session. The topbar's New side chat opens a side chat
 * about the whole conversation. The chat is a non-project session: a project chat would
 * open the project Agent tab by default and change the panel's starting state.
 * All mutable Host data is isolated; input is real CDP pointer input.
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
const output = outputArg < 0 ? await mkdtemp(join(tmpdir(), "pi-side-chat-")) : resolve(process.argv[outputArg + 1]);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "pi-side-chat-state-"));
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
const panelText = () => page.evaluate(`document.querySelector('.work-panel [data-side-chat]')?.innerText ?? ''`);
const sideSession = () => page.evaluate(`document.querySelector('.work-panel [data-side-chat]')?.dataset.sideChatSession ?? null`);
const composerText = () => page.evaluate(`document.querySelector('.composer-input')?.textContent ?? ''`);
const panelState = () => page.evaluate(`document.querySelector('.work-panel.edge-panel')?.dataset.edgeState ?? null`);
const RIGHT_FORM = '.work-panel [data-side-chat-form] textarea';

try {
  const seed = new Host(hostBinary, data, { env: { HOME: home }, quiet: true });
  // No project group is created: the session stays a plain chat, so entering it does not
  // add the project Agent tab to the panel.
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

  // 1. A real chat turn gives the anchor: an assistant turn with its action row.
  await until(() => page.evaluate("!!document.querySelector('.composer-input')"), "composer");
  await page.evaluate(`(() => { const input=document.querySelector('.composer-input'); input.focus(); input.textContent='Explain the plan in one sentence.'; input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'x'})); })()`);
  await until(() => page.evaluate("!!document.querySelector('.composer-toolbar .send-btn:not(:disabled)')"), "send enabled");
  await page.evaluate("document.querySelector('.composer-toolbar .send-btn').click()");
  await until(() => page.evaluate("document.querySelector('.main-pane')?.innerText.includes('MAIN_REPLY_1')"), "parent reply");
  await until(() => page.evaluate("!!document.querySelector('.main-pane [data-side-chat-role=assistant]')"), "Ask in side chat entry on the finished turn");
  assert.equal(await visibleMainSession(), parentId, "the parent is the visible session");
  assert.equal(modelRequests.length, 1);
  const before = await sessionIds();
  assert.ok(before.includes(parentId));
  coverage.push("A finished assistant turn offers Ask in side chat in its action row beside Fork");

  // Every chat in a workspace is a project chat, so entering it opened the project Agent
  // tab and revealed the panel. Start from the state this journey is about: the Agent tab
  // closed (a closed Agent stays closed for this conversation) and the panel auto-hidden.
  if (await page.evaluate("!!document.querySelector('.work-panel [data-project-agent-dock]')")) {
    await realClick(".work-panel .work-panel-tab-close", "close the project Agent tab");
    await until(() => page.evaluate("!document.querySelector('.work-panel [data-project-agent-dock]')"), "Agent tab closed");
  }
  await move(300, 600);
  await page.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until(async () => (await panelState()) === null, "panel auto-hidden again", 8000);

  // 2. Entry: a real click opens a draft tab in the (unpinned) panel; nothing is created.
  assert.equal(await panelState(), null, "panel is auto-hidden before the click");
  await realClick(".main-pane [data-side-chat-role=assistant]", "Ask in side chat button");
  await until(async () => (await panelState()) === "open", "unpinned panel reveals for the explicit click", 4000);
  await until(() => page.evaluate("!!document.querySelector('.work-panel [data-side-chat]')"), "side-chat tab rendered");
  assert.equal(await sideSession(), "", "no session before the first Send");
  assert.equal(await page.evaluate("document.querySelectorAll('.work-panel [role=tab]').length"), 1);
  assert.match(await page.evaluate("document.querySelector('.work-panel [role=tab]')?.title ?? ''"), /MAIN_REPLY_1/, "the tab tooltip carries the anchored message");
  await sleep(500);
  assert.deepEqual(await sessionIds(), before, "opening creates no session");
  coverage.push("Ask in side chat reveals the auto-hide work panel and opens a draft tab anchored at the message without creating a session");

  // 3. Typing creates nothing either.
  assert.ok(await setTextarea(RIGHT_FORM, "SIDE_QUESTION: why that sentence?"));
  await sleep(600);
  assert.deepEqual(await sessionIds(), before, "typing creates no session");
  assert.equal(modelRequests.length, 1, "typing sends nothing");
  await capture("01-draft-side-chat-light.png");

  // 4. First Send forks without switching the visible session; the reply streams in the panel.
  await realClick(".work-panel [data-side-chat-form] .send-btn", "Send");
  const childId = await until(async () => (await sideSession()) || null, "child bound to the tab", 20000);
  assert.notEqual(childId, parentId);
  await until(() => panelText().then((text) => text.includes("SIDE_REPLY_2")), "side reply streams in the panel", 30000);
  assert.equal(await visibleMainSession(), parentId, "the visible conversation never changed");
  const after = await sessionIds();
  assert.equal(after.length, before.length + 1, "exactly one child was forked");
  assert.ok(after.includes(childId));
  assert.equal(modelRequests.length, 2);
  assert.ok(json(modelRequests[1].messages).includes("MAIN_REPLY_1"), "parent prefix missing: " + json(modelRequests[1].messages.filter((m) => m.role !== "system").map((m) => [m.role, json(m.content).slice(0, 120)])));
  assert.ok(!(await page.evaluate("document.querySelector('.main-pane')?.innerText.includes('SIDE_REPLY')")), "the parent transcript has no side reply");
  assert.equal(await page.evaluate("document.querySelectorAll('.work-panel [role=tab]').length"), 1, "the same tab now shows the child");
  await capture("02-first-send-streaming-light.png");
  coverage.push("First Send forks one durable child without activating it, the tab refers to the child, and the reply streams through the detached transcript while the parent stays visible");

  // 5. The floating return control: a pill, no header. The default mode is None: nothing returns.
  const RETURN = ".work-panel [data-return-action]";
  const PILL = ".work-panel [data-return-pill]";
  const pillText = () => page.evaluate(`document.querySelector(${json(PILL)})?.innerText.trim() ?? ''`);
  const pickMode = async (mode, label) => {
    await realClick(PILL, "return pill");
    await realClick(`[data-return-option="mode:${mode}"]`, `return mode ${mode}`);
    await until(async () => label.test(await pillText()), `pill shows ${label}`);
  };
  const returnState = () => page.evaluate(`(() => { const el = document.querySelector(${json(RETURN)}); return el ? { disabled: el.disabled, busy: el.getAttribute('aria-busy') === 'true' } : null })()`);
  assert.match(await pillText(), /Return: None|回传：不回传/, "the pill names the default None mode");
  assert.equal(await page.evaluate("!!document.querySelector('.work-panel .side-chat-header, .work-panel header.side-chat-header')"), false, "no header bar");
  assert.equal(await returnState(), null, "no return button while the mode is None");
  const geometry = await page.evaluate(`(() => { const pill=document.querySelector(${json(PILL)}).getBoundingClientRect(); const panel=document.querySelector('.work-panel .detached-conversation').getBoundingClientRect(); const first=document.querySelector('.work-panel .message-row, .work-panel [data-message-id]')?.getBoundingClientRect(); return { pillLeft: pill.left-panel.left, pillTop: pill.top-panel.top, pillHeight: pill.height, firstTop: first ? first.top-pill.bottom : null }; })()`);
  assert.ok(geometry.pillLeft < 24 && geometry.pillTop < 16, `the pill floats at the top-left: ${json(geometry)}`);
  assert.equal(Math.round(geometry.pillHeight), 28, "the pill is 28px like the composer pills");
  assert.ok(geometry.firstTop === null || geometry.firstTop >= 0, `the first message is not covered by the pill: ${json(geometry)}`);
  const tabTitle = await page.evaluate("document.querySelector('.work-panel [role=tab]')?.title ?? ''");
  assert.match(tabTitle, /About|关于/, `the tab tooltip carries the anchored context: ${tabTitle}`);
  await capture("03-return-none-default-light.png");
  coverage.push("The side chat has no header: a 28px return pill floats at the top-left defaulting to None with no return button, the first message clears it, and the removed context sits in the tab tooltip");

  // 5a. Summary: a visible prompt in the side chat, then the answer quoted into the parent draft.
  await page.evaluate(`(() => { const input=document.querySelector('.composer-input'); input.focus(); input.textContent='my own draft'; input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'x'})); input.blur(); })()`);
  await pickMode("summary", /Summary|摘要/);
  await until(async () => (await returnState())?.disabled === false, "Return enabled in Summary mode");
  await realClick(RETURN, "Return to conversation (summary)");
  await until(async () => (await returnState())?.busy, "progress on the button while the summary runs", 8000);
  assert.equal((await returnState()).disabled, true, "a second click is blocked while running");
  await capture("04-return-summary-running-light.png");
  await until(() => panelText().then((text) => text.includes("SIDE_SUMMARY_3")), "summary answer visible in the side chat", 30000);
  await until(async () => (await composerText()).includes("SIDE_SUMMARY_3"), "summary quote in the parent composer", 30000);
  const summaryDraft = await composerText();
  assert.ok(summaryDraft.includes("my own draft"), "typed text is kept");
  assert.ok(/Quoted from|引用自/.test(summaryDraft), "attribution line present");
  assert.ok(/Summary|摘要/.test(summaryDraft), "summary label present");
  assert.ok(summaryDraft.includes("> "), "quoted as a Markdown blockquote");
  assert.equal(modelRequests.length, 3, "exactly one extra request, to the side chat");
  const summaryPrompt = lastUserText(modelRequests[2]);
  assert.ok(summaryPrompt.length > 10 && !summaryPrompt.includes("SIDE_QUESTION"), `summary prompt: ${summaryPrompt}`);
  assert.ok(json(modelRequests[2].messages).includes("SIDE_REPLY_2"), "the summary request went to the side chat");
  assert.ok((await page.evaluate("[...document.querySelectorAll('.main-pane [data-message-id]')].map((el) => el.innerText).join('|')")).includes("MAIN_REPLY_1") && !(await page.evaluate("[...document.querySelectorAll('.main-pane [data-message-id]')].map((el) => el.innerText).join('|')")).includes("SIDE_SUMMARY"), "nothing reached the parent transcript");
  assert.equal(await visibleMainSession(), parentId);
  await until(async () => !(await returnState())?.busy, "button idle again");
  await capture("05-return-summary-draft-light.png");
  coverage.push("Summary sends a visible prompt in the side chat, shows progress and blocks a second click, then quotes the new answer with a Summary label and attribution into the parent draft without sending");

  // 5b. Everything: the exchange after the fork anchor, quoted with role labels.
  await pickMode("full", /All|全部/);
  await realClick(RETURN, "Return to conversation (all)");
  await until(async () => (await composerText()).includes("SIDE_QUESTION: why that sentence?"), "full transcript in the parent composer");
  const fullDraft = await composerText();
  assert.ok(fullDraft.includes("SIDE_REPLY_2") && fullDraft.includes("SIDE_SUMMARY_3"), "assistant turns present");
  assert.ok(/\*\*(You|我):\*\*/.test(fullDraft), "role labels present");
  assert.ok(!fullDraft.includes("MAIN_REPLY_1"), "the parent prefix is not quoted");
  assert.ok(fullDraft.includes("my own draft"), "earlier draft text kept");
  assert.equal(modelRequests.length, 3, "Everything sends nothing");
  assert.equal(await visibleMainSession(), parentId);
  await capture("06-return-everything-draft-light.png");
  coverage.push("All quotes every user and assistant exchange after the fork anchor in order with role labels, excludes the parent prefix, appends to the parent draft and sends nothing");
  await pickMode("none", /None|不回传/);
  await until(async () => (await returnState()) === null, "the return button disappears in None");

  // 6. Open as a conversation: the child becomes the visible session; the tab is gone.
  await until(async () => (await panelState()) === "open" || (await page.evaluate("!!document.querySelector('.work-panel [data-side-chat]')")), "panel still available");
  const open = await rectOf(".work-panel [data-side-chat-action=open-as-session]");
  if (!open) { await page.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "j", code: "KeyJ", windowsVirtualKeyCode: 74, modifiers: process.platform === "darwin" ? 4 : 2 }); }
  await realClick(".work-panel [data-side-chat-action=open-as-session]", "Open as a conversation");
  await until(async () => (await visibleMainSession()) === childId, "child is the visible session");
  assert.equal(await page.evaluate("!!document.querySelector('.work-panel [data-side-chat]')"), false, "the side-chat tab closed");
  await capture("07-open-as-conversation-light.png");
  coverage.push("Open as a conversation selects the child through the normal path and closes the tab");

  // 7. Back in the parent: closing a tab keeps its created child.
  await until(() => page.evaluate(`(() => { const row=document.querySelector('[data-sidebar-session-row="${parentId}"]'); if(!row) return false; (row.querySelector('button')||row).click(); return true })()`), "parent row");
  await until(async () => (await visibleMainSession()) === parentId, "parent visible again");
  await until(() => page.evaluate("!!document.querySelector('.main-pane [data-side-chat-role=assistant]')"), "entry again");
  await realClick(".main-pane [data-side-chat-role=assistant]", "Ask in side chat button (second)");
  await until(() => page.evaluate("!!document.querySelector('.work-panel [data-side-chat]')"), "second draft tab");
  assert.equal(await sideSession(), "", "a fresh draft after the first child was promoted");
  assert.equal(await page.evaluate(`document.querySelector(${json(RIGHT_FORM)})?.value`), "", "its draft is empty");
  assert.ok(await setTextarea(RIGHT_FORM, "SIDE_QUESTION: second question"));
  await realClick(".work-panel [data-side-chat-form] .send-btn", "Send (second)");
  const secondChild = await until(async () => (await sideSession()) || null, "second child bound", 20000);
  await until(() => panelText().then((text) => text.includes("SIDE_REPLY_4")), "second side reply", 30000);
  const withSecond = await sessionIds();
  assert.ok(withSecond.includes(secondChild));
  await realClick(".work-panel [role=tab] .work-panel-tab-close, .work-panel .work-panel-tab-close", "tab close");
  await until(() => page.evaluate("!document.querySelector('.work-panel [data-side-chat]')"), "tab closed");
  assert.ok((await sessionIds()).includes(secondChild), "closing the tab keeps the child session");
  assert.ok(await page.evaluate(`!!document.querySelector('[data-sidebar-session-row="${secondChild}"]')`), "the child stays in the sidebar");
  assert.equal(await visibleMainSession(), parentId);
  coverage.push("Closing a tab removes only the tab and its draft; the created child remains an ordinary session in the sidebar");

  // 8. A running parent blocks the first Send with a visible reason.
  let release;
  holdParent = { promise: new Promise((done) => { release = done; }) };
  await page.evaluate(`(() => { const input=document.querySelector('.composer-input'); input.focus(); input.textContent='HOLD_PARENT keep running'; input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'x'})); })()`);
  await until(() => page.evaluate("!!document.querySelector('.composer-toolbar .send-btn:not(:disabled)')"), "send enabled for hold");
  await page.evaluate("document.querySelector('.composer-toolbar .send-btn').click()");
  await until(() => modelRequests.length >= 5, "held request reached the model");
  await realClick(".main-pane [data-side-chat-role=assistant]", "Ask in side chat button (busy parent)");
  await until(() => page.evaluate("!!document.querySelector('.work-panel [data-side-chat]')"), "draft tab while the parent runs");
  assert.ok(await setTextarea(RIGHT_FORM, "SIDE_QUESTION: blocked"));
  const notice = await until(() => page.evaluate("document.querySelector('.work-panel .detached-conversation-notice')?.textContent ?? ''"), "blocked reason visible");
  assert.ok(/still replying|仍在回复/.test(notice), `blocked reason: ${notice}`);
  assert.equal(await page.evaluate("document.querySelector('.work-panel [data-side-chat-form] .send-btn')?.disabled"), true);
  await capture("08-parent-running-blocks-send-light.png");
  release();
  await until(() => page.evaluate("!document.querySelector('.work-panel .detached-conversation-notice')"), "Send re-enabled once the parent finished", 30000);
  assert.equal(await page.evaluate("document.querySelector('.work-panel [data-side-chat-form] .send-btn')?.disabled"), false);
  assert.equal(modelRequests.length, 5, "the blocked draft sent nothing");
  coverage.push("A running parent disables the first Send with a visible reason, and Send recovers automatically");

  // 9. The conversation topbar's New side chat: a side chat about the whole conversation.
  const TOPBAR = '[data-nav="new-side-chat"]';
  assert.equal(await page.evaluate(`document.querySelector(${json(TOPBAR)})?.disabled`), false, "New side chat is enabled in a conversation with messages");
  const beforeWhole = await sessionIds();
  const tabCount = () => page.evaluate("document.querySelectorAll('.work-panel [role=tab]').length");
  const tabsBefore = await tabCount();
  // The unpinned panel overlays the topbar's right end; hide it so the button is reachable.
  await move(300, 600);
  await page.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until(async () => (await panelState()) === null, "panel auto-hidden before using the topbar", 8000);
  // The button sits in the edge-reveal hot zone, so a real pointer would land on the revealed panel; activate it directly.
  await page.evaluate(`document.querySelector(${json(TOPBAR)}).click()`);
  await until(async () => (await panelState()) === "open", "the click reveals the panel", 4000);
  await until(async () => (await tabCount()) === tabsBefore + 1, "a new side chat tab opened");
  await until(() => page.evaluate("document.activeElement?.closest?.('[data-side-chat-form]') !== null && document.activeElement?.tagName === 'TEXTAREA'"), "the side composer is focused");
  assert.deepEqual(await sessionIds(), beforeWhole, "opening it creates no session");
  const wholeTitle = await page.evaluate("document.querySelector('.work-panel [role=tab][aria-selected=true]')?.title ?? ''");
  assert.match(wholeTitle, /About|关于/, `the tooltip names the conversation: ${wholeTitle}`);
  await move(300, 600);
  await page.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until(async () => (await panelState()) === null, "panel auto-hidden again", 8000);
  // The button sits in the edge-reveal hot zone, so a real pointer would land on the revealed panel; activate it directly.
  await page.evaluate(`document.querySelector(${json(TOPBAR)}).click()`);
  await until(async () => (await tabCount()) === tabsBefore + 2, "each press opens another side chat");
  await capture("09-topbar-new-side-chat-light.png");
  coverage.push("The topbar's New side chat opens a draft side chat about the whole conversation, reveals the panel, focuses its composer and creates no session until Send");

  await writeFile(join(output, "result.json"), json({ ok: true, coverage, modelRequestCount: modelRequests.length }, null, 2));
  await rm(join(output, "failure.txt"), { force: true }); await rm(join(output, "failure.png"), { force: true });
} catch (error) {
  await writeFile(join(output, "failure.txt"), String(error.stack ?? error) + "\n" + log.slice(-9000));
  if (page) { try { await capture("failure.png"); } catch {} }
  throw error;
} finally { await stopApp(); model.close(); await rm(scratch, { recursive: true, force: true }); }
console.log(`Chat side chat passed: ${output}`);
