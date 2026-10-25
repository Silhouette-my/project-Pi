#!/usr/bin/env node
/** Production Electron renderer journey for the work panel's Chrome-like tab strip.
 * Usage: node scripts/e2e-work-panel-tabs.mjs [--output /absolute/evidence-dir]
 *
 * E2E-WORKPANEL-chrome-tab-strip. Real CDP pointer and keyboard input drives the strip:
 * "+" follows the last tab, tabs shrink evenly, inactive tabs fall back to their icon (never
 * under 36px) before the strip scrolls with edge fades, the active tab stays in view and keeps
 * its title and close button, middle click closes, a close holds the other tabs' widths until
 * the pointer leaves, closing the active tab activates its right neighbour (else left), tabs
 * drag to reorder, and Ctrl+Tab / Ctrl+Shift+Tab / Cmd+W work while focus is in the panel.
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
const output = outputArg < 0 ? await mkdtemp(join(tmpdir(), "pi-panel-tabs-")) : resolve(process.argv[outputArg + 1]);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "pi-panel-tabs-state-"));
const home = join(scratch, "home"), data = join(scratch, "data");
for (const path of [home, data]) await mkdir(path, { recursive: true });
const hostBinary = process.env.PI_DESKTOP_HOST_BIN || join(root, "target/debug/pi-desktop-host-core");
const electronBinary = process.env.PI_DESKTOP_ELECTRON_BIN || resolveElectronBinary(root).electronBinary;
const json = JSON.stringify, sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let sequence = 0, main, page, child, log = "";
const coverage = [], modelRequests = [];
let holdParent = null;


const model = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(json({ object: "list", data: [{ id: "ui-fixture", object: "model", owned_by: "local-fixture" }] }));
    return;
  }
  res.writeHead(404); res.end();
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

const tabs = () => page.evaluate(`[...document.querySelectorAll('.work-panel [role=tab]')].map((el) => { const wrap = el.closest('.work-panel-tab'); const r = wrap.getBoundingClientRect(); return { id: wrap.dataset.workPanelTabId, active: el.getAttribute('aria-selected') === 'true', width: Math.round(r.width), left: r.left, right: r.right, midY: (r.top + r.bottom) / 2, iconOnly: wrap.classList.contains('is-icon-only'), label: el.querySelector('.work-panel-tab-label')?.offsetParent !== null }; })`);
const stripInfo = () => page.evaluate(`(() => { const s = document.querySelector('.work-panel-tab-strip'); const p = document.querySelector('.work-panel-tab-plus'); const sr = s.getBoundingClientRect(), pr = p.getBoundingClientRect(); return { scrolls: s.scrollWidth > s.clientWidth + 1, left: sr.left, right: sr.right, plusLeft: pr.left, plusRight: pr.right, fadeStart: s.classList.contains('fade-start'), fadeEnd: s.classList.contains('fade-end') }; })()`);
const addTab = async () => { const before = (await tabs()).length; await page.evaluate("document.querySelector('.work-panel-tab-plus').click()"); await until(async () => (await tabs()).length === before + 1, "a new tab"); await sleep(120); };
const activeTab = async () => (await tabs()).find((tab) => tab.active);
const key = (name, code, vk, modifiers = 0) => page.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: name, code, windowsVirtualKeyCode: vk, modifiers });
const keyUp = (name, code, vk, modifiers = 0) => page.call("Input.dispatchKeyEvent", { type: "keyUp", key: name, code, windowsVirtualKeyCode: vk, modifiers });
const CTRL = 2, SHIFT = 8, META = 4;
const middleClick = async (x, y) => {
  await move(x, y);
  await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "middle", buttons: 4, clickCount: 1 });
  await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "middle", buttons: 0, clickCount: 1 });
};
const centre = (tab) => ({ x: (tab.left + tab.right) / 2, y: tab.midY });
// Off-centre press: an icon-only tab's close button sits at its centre while hovered.
const edgeOf = (tab) => ({ x: tab.left + 5, y: tab.midY });

try {
  const seed = new Host(hostBinary, data, { env: { HOME: home }, quiet: true });
  try { await seed.start(); } finally { await seed.stop(); }
  await startApp();
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });
  const setup = await main.evaluate(`globalThis.__PI_DESKTOP_PLAN_UI_PROBE({operation:'liveSetup',workspace:${json(workspace)}})`);
  assert.equal(setup.ok, true, json(setup));
  await invoke("settingsSet", { ...await invoke("settingsGet"), defaultProviderId: setup.providerId, defaultModelId: setup.modelId });
  await page.call("Page.reload");
  await until(() => page.evaluate("!!document.querySelector('.app-shell:not(.is-booting)')"), "renderer reload after Host setup");
  await until(() => page.evaluate(`(() => { const row=document.querySelector('[data-sidebar-session-row="${setup.sessionId}"]'); if(!row) return false; (row.querySelector('button')||row).click(); return true })()`), "seeded session row");
  // A chat in a workspace is a project chat: the Agent tab opens first and reveals the panel.
  await until(() => page.evaluate("!!document.querySelector('.work-panel [role=tab]')"), "the panel shows its first tab");
  assert.match(await page.evaluate("document.querySelector('.work-panel [role=tab]').textContent"), /Project Agent|项目 Agent/, "the Agent tab is labelled Project Agent");
  await page.evaluate("document.documentElement.dataset.theme='light'");
  // Keep the panel docked-looking and open for the whole journey: pin it.
  await page.evaluate("document.querySelector('.work-panel [data-nav=pin-work-panel]')?.click()");
  await until(() => page.evaluate("!document.querySelector('.work-panel.edge-panel')"), "the panel is pinned (docked)");
  // The docked panel slides in; wait until it has its width before measuring anything.
  await until(() => page.evaluate("(document.querySelector('.work-panel-tab-strip-wrap')?.clientWidth ?? 0) > 200"), "the docked panel settled", 8000);
  // Widen the panel with its separator's keyboard contract so a few tabs fit at their full width.
  await page.evaluate("document.querySelector('.work-panel-resize').focus()");
  await key("End", "End", 35); await keyUp("End", "End", 35);
  await sleep(700);
  const stripWidth = await page.evaluate("document.querySelector('.work-panel-tab-strip-wrap').clientWidth");

  // 1. "+" follows the last tab.
  let list = await tabs();
  assert.equal(list.length, 1);
  let strip = await stripInfo();
  assert.ok(list[0].width <= 170 && list[0].active, "a lone tab keeps its width cap and is active");
  assert.ok(strip.plusLeft - list[0].right <= 6 && strip.plusLeft >= list[0].right, `+ sits right after the last tab: ${json({ strip, tab: list[0] })}`);
  coverage.push('"+" sits right after the last tab');

  // 2. Tabs shrink evenly; the active tab keeps its title.
  await addTab(); await addTab();
  list = await tabs();
  assert.equal(list.length, 3);
  assert.ok(Math.max(...list.map((tab) => tab.width)) - Math.min(...list.map((tab) => tab.width)) <= 2, `three tabs share the strip evenly: ${json(list.map((tab) => tab.width))}`);
  assert.equal((await stripInfo()).scrolls, false, json({ strip: await stripInfo(), widths: list.map((tab) => tab.width), wrap: await page.evaluate("document.querySelector('.work-panel-tab-strip-wrap').clientWidth + '/' + document.querySelector('.work-panel-tab-strip').scrollWidth + '/' + document.querySelector('.work-panel-tab-strip').clientWidth") }));
  coverage.push("Tabs share the strip evenly while they fit");

  // 3. Many tabs: inactive tabs go icon-only (>=36px) before the strip scrolls; the active one keeps icon + title + close.
  let stage = "icon-only";
  for (let guard = 0; guard < 24; guard += 1) {
    list = await tabs(); strip = await stripInfo();
    if (list.some((tab) => !tab.active && tab.iconOnly) || strip.scrolls) break;
    await addTab();
  }
  list = await tabs(); strip = await stripInfo();
  const inactive = list.filter((tab) => !tab.active);
  assert.ok(inactive.some((tab) => tab.iconOnly), `inactive tabs turned icon-only: ${json(list)}`);
  assert.ok(inactive.every((tab) => tab.width >= 36), "no tab is narrower than 36px");
  const active = list.find((tab) => tab.active);
  assert.ok(active.width >= 104 && active.label && !active.iconOnly, `the active tab keeps its title: ${json(active)}`);
  await capture("01-icon-only-light.png");
  coverage.push("Inactive tabs turn icon-only (never under 36px) while the active tab keeps its icon, title and close button");

  // 4. Overflow scrolls with an edge fade; the active tab stays in view; "+" stays at the right edge.
  while (!(await stripInfo()).scrolls) await addTab();
  for (let i = 0; i < 3; i += 1) await addTab();
  strip = await stripInfo(); list = await tabs();
  assert.equal(strip.scrolls, true);
  const current = list.find((tab) => tab.active);
  assert.ok(current.left >= strip.left - 1 && current.right <= strip.right + 1, `the active tab stays in view: ${json({ current, strip })}`);
  assert.ok(strip.plusRight <= strip.right + 1 && strip.plusLeft >= strip.left, "the + is sticky inside the strip's right edge");
  assert.equal(strip.fadeStart, true, "the left edge fades once scrolled");
  await capture("02-overflow-light.png");
  coverage.push("Overflow scrolls horizontally with an edge fade, keeps the active tab in view and the + at the right edge");

  // 5. Activating a far tab by pointer scrolls it into view; hover reveals the close button on an icon-only tab.
  await page.evaluate("document.querySelector('.work-panel-tab-strip').scrollLeft = 0");
  await sleep(200);
  list = await tabs();
  const first = list[0];
  await clickAt(...Object.values(edgeOf(first)));
  await until(async () => (await activeTab())?.id === first.id, "first tab activated");
  const second = (await tabs())[1];
  assert.equal(second.iconOnly, true);
  await move(...Object.values(centre(second)));
  await sleep(250);
  const closeOpacity = await page.evaluate(`getComputedStyle(document.querySelector('[data-work-panel-tab-id="${second.id}"] .work-panel-tab-close')).opacity`);
  assert.equal(closeOpacity, "1", "hovering an icon-only tab shows its close button");
  coverage.push("An icon-only tab shows its close button on hover");

  // 6. Middle click closes.
  const countBeforeMiddle = (await tabs()).length;
  await middleClick(...Object.values(centre(second)));
  await until(async () => (await tabs()).length === countBeforeMiddle - 1 && !(await tabs()).some((tab) => tab.id === second.id), "middle click closed the tab");
  coverage.push("Middle click closes a tab");

  // 7. Closing the active tab activates its right neighbour, else the left one.
  list = await tabs();
  const target = list[2];
  await clickAt(...Object.values(edgeOf(target)));
  await until(async () => (await activeTab())?.id === target.id, "third tab active");
  const ordered = (await tabs()).map((tab) => tab.id);
  const rightNeighbour = ordered[ordered.indexOf(target.id) + 1];
  await page.evaluate(`document.querySelector('[data-work-panel-tab-id="${target.id}"] .work-panel-tab-close').click()`);
  await until(async () => (await activeTab())?.id === rightNeighbour, `the right neighbour became active`);
  // The last tab falls back to the left one.
  await page.evaluate(`document.querySelector('.work-panel-tab-strip').scrollLeft = 1e6`);
  await sleep(200);
  const lastTab = (await tabs()).at(-1);
  await clickAt(...Object.values(edgeOf(lastTab)));
  await until(async () => (await activeTab())?.id === lastTab.id, "last tab active");
  const beforeLast = (await tabs()).at(-2).id;
  await page.evaluate(`document.querySelector('[data-work-panel-tab-id="${lastTab.id}"] .work-panel-tab-close').click()`);
  await until(async () => (await activeTab())?.id === beforeLast, "the left neighbour became active when the last tab closed");
  coverage.push("Closing the active tab activates its right neighbour, else the left one");

  // 8. Widths hold after a close button press until the pointer leaves the strip.
  while ((await tabs()).length > 8) await page.evaluate(`document.querySelector('.work-panel-tab:last-of-type .work-panel-tab-close, .work-panel-tab:nth-last-child(2) .work-panel-tab-close').click()`);
  await sleep(200);
  list = await tabs();
  const activeNow = list.find((tab) => tab.active);
  const victim = list.find((tab) => !tab.active && tab.id !== list[0].id);
  const widthsBefore = Object.fromEntries(list.map((tab) => [tab.id, tab.width]));
  await move(...Object.values(centre(victim)));
  await sleep(200);
  const closeBox = await rectOf(`[data-work-panel-tab-id="${victim.id}"] .work-panel-tab-close`);
  await clickAt(closeBox.x, closeBox.y);
  await until(async () => !(await tabs()).some((tab) => tab.id === victim.id), "tab closed by its x");
  await sleep(250);
  const heldWidths = Object.fromEntries((await tabs()).map((tab) => [tab.id, tab.width]));
  for (const [id, width] of Object.entries(heldWidths)) assert.ok(Math.abs(width - widthsBefore[id]) <= 1, `width of ${id} held: ${widthsBefore[id]} -> ${width}`);
  await move(300, 700);
  await sleep(300);
  const released = await tabs();
  assert.ok(released.some((tab) => Math.abs(tab.width - widthsBefore[tab.id]) > 2) || released.length * 36 > stripWidth, "widths relax once the pointer leaves");
  coverage.push("A close button press holds the other tabs' widths until the pointer leaves the strip");

  // 9. Drag to reorder.
  await page.evaluate("document.querySelector('.work-panel-tab-strip').scrollLeft = 0");
  await sleep(200);
  list = await tabs();
  const dragged = list[0], over = list[3];
  await move(...Object.values(edgeOf(dragged)));
  await page.call("Input.dispatchMouseEvent", { type: "mousePressed", ...edgeOf(dragged), button: "left", clickCount: 1 });
  for (let step = 1; step <= 12; step += 1) {
    const x = edgeOf(dragged).x + ((over.right - 4 - edgeOf(dragged).x) * step) / 12;
    await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: dragged.midY, button: "left", buttons: 1 });
    await sleep(16);
  }
  await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: over.right - 4, y: dragged.midY, button: "left", clickCount: 1 });
  await until(async () => (await tabs()).findIndex((tab) => tab.id === dragged.id) === 3, "the tab moved after the target by drag");
  coverage.push("Dragging a tab reorders it");

  // 10. Shortcuts act only while focus is in the panel.
  const idsNow = async () => (await tabs()).map((tab) => tab.id);
  await clickAt(...Object.values(edgeOf((await tabs())[1])));
  await until(async () => (await activeTab())?.id === (await idsNow())[1], "second tab active");
  const startIndex = 1;
  await key("Tab", "Tab", 9, CTRL); await keyUp("Tab", "Tab", 9, CTRL);
  await until(async () => (await activeTab())?.id === (await idsNow())[startIndex + 1], "Ctrl+Tab moves to the next tab");
  await key("Tab", "Tab", 9, CTRL | SHIFT); await keyUp("Tab", "Tab", 9, CTRL | SHIFT);
  await until(async () => (await activeTab())?.id === (await idsNow())[startIndex], "Ctrl+Shift+Tab moves back");
  const countBeforeClose = (await tabs()).length;
  const closing = (await activeTab()).id;
  await key("w", "KeyW", 87, process.platform === "darwin" ? META : CTRL); await keyUp("w", "KeyW", 87, process.platform === "darwin" ? META : CTRL);
  await until(async () => (await tabs()).length === countBeforeClose - 1 && !(await idsNow()).includes(closing), "the platform close chord closes the active tab");
  // Outside the panel the chord does nothing to the strip.
  await page.evaluate("document.querySelector('.composer-input')?.focus()");
  const countOutside = (await tabs()).length;
  await key("Tab", "Tab", 9, CTRL); await keyUp("Tab", "Tab", 9, CTRL);
  await sleep(300);
  assert.equal((await tabs()).length, countOutside);
  coverage.push("Ctrl+Tab, Ctrl+Shift+Tab and Cmd/Ctrl+W work while focus is in the panel, and leave the strip alone elsewhere");

  await page.evaluate("document.documentElement.dataset.theme='dark'");
  await sleep(200);
  await capture("03-overflow-dark.png");

  await writeFile(join(output, "result.json"), json({ ok: true, coverage }, null, 2));
  await rm(join(output, "failure.txt"), { force: true }); await rm(join(output, "failure.png"), { force: true });
} catch (error) {
  await writeFile(join(output, "failure.txt"), String(error.stack ?? error) + "\n" + log.slice(-9000));
  if (page) { try { await capture("failure.png"); } catch {} }
  throw error;
} finally { await stopApp(); model.close(); await rm(scratch, { recursive: true, force: true }); }
console.log(`Work panel tab strip passed: ${output}`);
