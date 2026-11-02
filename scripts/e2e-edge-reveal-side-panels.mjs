#!/usr/bin/env node
/** Production Electron renderer journey for auto-hide side panels.
 * Usage: node scripts/e2e-edge-reveal-side-panels.mjs [--output /absolute/evidence-dir]
 *
 * Real pointer and keyboard input through CDP: edge dwell reveals each panel,
 * leaving hides it, menus hold it, Cmd/Ctrl+B and Cmd/Ctrl+J toggle it, and
 * pinning docks it with its own persisted flag (E2E-SHELL-edge-reveal-side-panels).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repositoryRoot, assertDesktopBuild, resolveElectronBinary } from "./e2e/boot.mjs";
import { Host } from "./e2e/host.mjs";

const root = resolve(repositoryRoot());
assertDesktopBuild(root);
const outputArg = process.argv.indexOf("--output");
const output = outputArg < 0 ? await mkdtemp(join(tmpdir(), "pi-edge-reveal-")) : resolve(process.argv[outputArg + 1]);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "pi-edge-reveal-state-"));
const home = join(scratch, "home"), data = join(scratch, "data");
for (const path of [home, data]) await mkdir(path, { recursive: true });
const hostBinary = process.env.PI_DESKTOP_HOST_BIN || join(root, "target/debug/pi-desktop-host-core");
const appBinary = process.env.PI_DESKTOP_APP_BIN;
const electronBinary = appBinary || process.env.PI_DESKTOP_ELECTRON_BIN || resolveElectronBinary(root).electronBinary;
const json = JSON.stringify, sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const mac = process.platform === "darwin";
let sequence = 0, main, page, child, log = "";

async function freePort() {
  const server = createNetServer(); await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port; await new Promise((done) => server.close(done)); return port;
}
async function until(check, name, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(50); }
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
    PI_DESKTOP_PLAN_UI_PROBE: "1", PI_DESKTOP_TEST_API_KEY: "local-fixture", PI_DESKTOP_TEST_BASE_URL: "http://127.0.0.1:9/v1", PI_DESKTOP_TEST_MODEL: "ui-fixture", ELECTRON_RENDERER_URL: "", PI_DESKTOP_START_MAXIMIZED: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electronBinary, [`--remote-debugging-port=${ports[0]}`, `--inspect=${ports[1]}`, `--user-data-dir=${join(scratch, "profile")}`, ...(appBinary ? [] : ["."])], { cwd: join(root, "apps/desktop"), env, stdio: ["ignore", "pipe", "pipe"], detached: true });
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
const click = async (x, y) => {
  await move(x, y);
  await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};
const key = async (name, code, vk, modifiers = 0) => {
  await page.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: name, code, windowsVirtualKeyCode: vk, modifiers });
  await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: name, code, windowsVirtualKeyCode: vk, modifiers });
};
const mod = mac ? 4 : 2;
const state = (selector) => page.evaluate(`document.querySelector(${json(selector)})?.dataset.edgeState ?? null`);
const rect = (selector) => page.evaluate(`(() => { const el=document.querySelector(${json(selector)}); if(!el) return null; const r=el.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,width:r.width,height:r.height}; })()`);
const viewport = () => page.evaluate("({width: innerWidth, height: innerHeight})");
const centerOf = async (selector) => { const r = await rect(selector); assert.ok(r, `${selector} present`); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
const LEFT = '.sidebar.edge-panel', RIGHT = '.work-panel.edge-panel';
const settleClosed = (selector, name) => until(async () => (await state(selector)) !== "open", name, 4000);
const parkPointer = async () => { const { width } = await viewport(); await move(Math.round(width / 2), 400); };

try {
  const seed = new Host(hostBinary, data, { env: { HOME: home }, quiet: true });
  try { await seed.start(); await seed.call("project.group.create", { name: "Edge reveal", folders: [join(root, "apps")] }); } finally { await seed.stop(); }
  await startApp();
  const { width: vw } = await viewport();
  assert.ok(vw >= 900, `viewport wide enough: ${vw}`);

  // 0. "Auto" (no saved choice) follows the window width: at this width the
  // sidebar docks and the narrower-threshold right panel stays hidden.
  await until(() => page.evaluate("!!document.querySelector('.sidebar') && !document.querySelector('.sidebar.edge-panel')"), "auto sidebar docks on a wide window", 5000);
  assert.equal(await page.evaluate("!!document.querySelector('.work-panel')"), false, "auto right panel hidden below its width");
  // The rest exercises the auto-hide mode, chosen explicitly.
  await invoke("settingsSet", { ...await invoke("settingsGet"), sidebarPinned: false, workPanelPinned: false });
  await page.call("Page.reload");
  await until(() => page.evaluate("!!document.querySelector('.app-shell:not(.is-booting)')"), "renderer reload after choosing auto-hide");

  // 1. Auto-hide: both panels hidden, content uses the full width.
  await until(async () => (await state(LEFT)) === "closed", "sidebar starts closed", 5000);
  assert.equal(await page.evaluate("document.querySelectorAll('.sidebar').length"), 1, "one sidebar instance");
  assert.equal(await page.evaluate("document.querySelector('.sidebar.edge-panel')?.hasAttribute('inert')"), true, "closed sidebar is inert");
  const full = await rect(".main-pane");
  assert.equal(Math.round(full.left), 0, "main pane starts at the window edge");
  assert.equal(Math.round(full.width), vw, "main pane spans the full width");
  assert.ok(await page.evaluate("!!document.querySelector('.edge-reveal-zone[data-edge-zone=left]')"), "left hot zone armed");

  // 2. No session: the right panel has no context, no hot zone and no reveal.
  assert.equal(await page.evaluate("!!document.querySelector('.edge-reveal-zone[data-edge-zone=right]')"), false, "no right hot zone without a session");
  await move(vw - 2, 400); await sleep(300);
  assert.equal(await page.evaluate("!!document.querySelector('.work-panel')"), false, "no reveal without a session");
  await parkPointer();

  const setup = await main.evaluate(`globalThis.__PI_DESKTOP_PLAN_UI_PROBE({operation:'liveSetup',workspace:${json(join(root, "apps"))}})`);
  assert.equal(setup.ok, true, json(setup));
  await page.call("Page.reload");
  await until(() => page.evaluate("!!document.querySelector('.app-shell:not(.is-booting)')"), "renderer reload after Host setup");
  // Select the seeded session through its sidebar row (the sidebar is mounted, hidden).
  await until(() => page.evaluate(`(() => { const row=document.querySelector('[data-sidebar-session-row="${setup.sessionId}"]'); if(!row) return false; (row.querySelector('button')||row).click(); return true })()`), "seeded session row");
  await until(() => page.evaluate("!!document.querySelector('.edge-reveal-zone[data-edge-zone=right]')"), "right hot zone with a session");
  await until(() => page.evaluate("!document.querySelector('.app-work-panel-toggle')?.disabled"), "work panel toggle enabled");
  await page.evaluate("document.documentElement.dataset.theme='light'");
  await parkPointer();
  await capture("01-default-both-hidden-light.png");

  // 3. Left edge: dwell reveals, the overlay changes no layout, leaving hides after ~300ms.
  await move(2, 400);
  await sleep(30);
  assert.equal(await state(LEFT), "closed", "30ms is below the dwell");
  await until(async () => (await state(LEFT)) === "open", "left reveal after the dwell", 5000);
  // Wait for the slide-in to settle rather than sleeping: a background test
  // window throttles animations, so a fixed delay can sample mid-slide.
  await until(async () => Math.abs((await rect(LEFT)).left) < 0.5, "left slide-in settled", 5000);
  const overlay = await rect(LEFT);
  assert.ok(Math.abs(overlay.left) < 0.5, `overlay sits at the left edge: ${overlay.left}`);
  assert.ok(overlay.width >= 240 && overlay.width <= 520, `sidebar keeps its width: ${overlay.width}`);
  assert.ok(await page.evaluate("!!document.querySelector('.sidebar.edge-panel').getAttribute('aria-label')"), "labelled region");
  const whileOpen = await rect(".main-pane");
  assert.equal(Math.round(whileOpen.width), vw, "overlay never changes MainPane width");
  await capture("02-left-revealed-light.png");
  await page.evaluate("document.documentElement.dataset.theme='dark'");
  await capture("02-left-revealed-dark.png");
  await page.evaluate("document.documentElement.dataset.theme='light'");
  await move(600, 400);
  await sleep(120);
  assert.equal(await state(LEFT), "open", "still open 120ms after leaving");
  await until(async () => (await state(LEFT)) === "closed", "left hide after the delay", 3000);

  // 4. A dwell that ends early reveals nothing.
  await move(2, 400); await sleep(30); await move(600, 400); await sleep(400);
  assert.equal(await state(LEFT), "closed", "accidental edge brush does not reveal");

  // 5. A menu opened from inside holds the overlay open; closing it releases the hold.
  await move(2, 400);
  await until(async () => (await state(LEFT)) === "open", "left reveal for the menu hold", 5000);
  await move(100, 300);
  assert.ok(await page.evaluate("(() => { const more=document.querySelector('.sidebar.edge-panel .project-more'); if(!more) return false; more.click(); return true; })()"), "project overflow menu opens");
  await until(() => page.evaluate("!!document.querySelector('.sidebar-row-menu')"), "menu rendered");
  await move(900, 400);
  await sleep(900);
  assert.equal(await state(LEFT), "open", "an open menu holds the overlay");
  await capture("03-menu-holds-overlay-light.png");
  await page.evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
  await until(() => page.evaluate("!document.querySelector('.sidebar-row-menu')"), "menu dismissed");
  await until(async () => (await state(LEFT)) === "closed", "hide after the menu closes", 3000);

  // 6. Cmd/Ctrl+B is sticky, Escape closes, the shortcut again toggles.
  await key("b", "KeyB", 66, mod);
  await until(async () => (await state(LEFT)) === "open", "shortcut reveal", 5000);
  await move(900, 400); await sleep(700);
  assert.equal(await state(LEFT), "open", "a shortcut reveal stays until dismissed");
  await key("Escape", "Escape", 27);
  await until(async () => (await state(LEFT)) === "closed", "Escape closes the overlay", 5000);
  await key("b", "KeyB", 66, mod);
  await until(async () => (await state(LEFT)) === "open", "shortcut reveal again", 5000);
  await key("b", "KeyB", 66, mod);
  await until(async () => (await state(LEFT)) === "closed", "shortcut hides", 5000);

  // 7. Right edge: the work panel overlay, with the same rules.
  await move(vw - 2, 400);
  await until(async () => (await state(RIGHT)) === "open", "right reveal after the dwell", 5000);
  await until(async () => Math.abs((await rect(RIGHT)).right - (await viewport()).width) <= 1, "right slide-in settled", 5000);
  const panel = await rect(RIGHT);
  const nowW = (await viewport()).width;
  assert.ok(Math.abs(panel.right - nowW) <= 1, `work panel sits at the right edge: ${JSON.stringify(panel)} vw=${nowW}`);
  assert.equal(Math.round((await rect(".main-pane")).width), vw, "work panel overlay never changes MainPane width");
  await capture("04-right-revealed-light.png");
  await move(300, 400);
  await until(() => page.evaluate("!document.querySelector('.work-panel')"), "right panel unmounted after the delay", 3000);
  await key("j", "KeyJ", 74, mod);
  await until(async () => (await state(RIGHT)) === "open", "Cmd/Ctrl+J reveal", 5000);
  await key("Escape", "Escape", 27);
  await until(() => page.evaluate("!document.querySelector('.work-panel')"), "Escape closes the work panel", 3000);

  // 8. Pin the sidebar from its header: docked layout, persisted flag.
  await move(2, 400);
  await until(async () => (await state(LEFT)) === "open", "left reveal before pinning", 5000);
  // Coordinates are only valid once the slide-in has settled.
  await until(async () => Math.abs((await rect(LEFT)).left) < 0.5, "left slide-in settled before pinning", 5000);
  const pin = await centerOf('.sidebar.edge-panel [data-nav="pin-sidebar"]');
  await click(pin.x, pin.y);
  await until(() => page.evaluate("!document.querySelector('.sidebar.edge-panel') && !!document.querySelector('.sidebar') && !document.querySelector('.app-shell').classList.contains('sidebar-collapsed')"), "docked sidebar after pinning", 4000);
  await parkPointer();
  await sleep(400);
  const docked = await rect(".sidebar"), mainDocked = await rect(".main-pane");
  assert.ok(Math.abs(mainDocked.left - docked.right) <= 1, "main pane starts where the docked sidebar ends");
  assert.equal(await page.evaluate("document.querySelector('.edge-reveal-zone[data-edge-zone=left]')"), null, "no hot zone while pinned");
  assert.equal((await invoke("settingsGet")).sidebarPinned, true, "sidebarPinned persisted");
  assert.notEqual((await invoke("settingsGet")).workPanelPinned, true, "the work panel keeps its own flag");
  await capture("05-sidebar-pinned-light.png");
  // Pin state survives a reload.
  await page.call("Page.reload");
  await until(() => page.evaluate("!!document.querySelector('.app-shell:not(.is-booting)') && !!document.querySelector('.sidebar') && !document.querySelector('.sidebar.edge-panel')"), "docked sidebar after reload");

  // 9. The right panel is still unpinned while the sidebar is docked; pin it too.
  await until(() => page.evaluate(`(() => { const row=document.querySelector('[data-sidebar-session-row="${setup.sessionId}"]'); if(!row) return false; (row.querySelector('button')||row).click(); return true })()`), "seeded session row after reload");
  await until(() => page.evaluate("!!document.querySelector('.edge-reveal-zone[data-edge-zone=right]')"), "right hot zone after reload");
  const { width: vw2 } = await viewport();
  await move(vw2 - 2, 400);
  await until(async () => (await state(RIGHT)) === "open", "right reveal with the sidebar docked", 5000);
  await until(() => page.evaluate("!!document.querySelector('.work-panel.edge-panel [data-nav=pin-work-panel]')"), "work panel pin button");
  await until(async () => Math.abs((await rect(RIGHT)).right - (await viewport()).width) <= 1, "right slide-in settled before pinning", 5000);
  const pinRight = await centerOf('.work-panel.edge-panel [data-nav="pin-work-panel"]');
  await click(pinRight.x, pinRight.y);
  await until(() => page.evaluate("!!document.querySelector('.work-panel') && !document.querySelector('.work-panel.edge-panel')"), "docked work panel after pinning", 4000);
  await parkPointer();
  await sleep(400);
  const dockedPanel = await rect(".work-panel"), mainBoth = await rect(".main-pane"), sidebarBoth = await rect(".sidebar");
  assert.ok(Math.abs(mainBoth.left - sidebarBoth.right) <= 1 && Math.abs(mainBoth.left + mainBoth.width - dockedPanel.left) <= 1, "three docked columns tile the window");
  assert.ok(mainBoth.width >= 450, `MainPane keeps its 450px floor: ${mainBoth.width}`);
  const settings = await invoke("settingsGet");
  assert.equal(settings.workPanelPinned, true, "workPanelPinned persisted");
  assert.equal(settings.sidebarPinned, true, "sidebarPinned still persisted");
  await capture("06-both-pinned-light.png");

  // 10. Unpin both again: back to auto-hide with full-width content.
  const unpinRight = await centerOf('.work-panel [data-nav="pin-work-panel"]');
  await click(unpinRight.x, unpinRight.y);
  await until(() => page.evaluate("!document.querySelector('.work-panel')"), "work panel auto-hides after unpinning", 4000);
  const unpinLeft = await centerOf('.sidebar [data-nav="pin-sidebar"]');
  await click(unpinLeft.x, unpinLeft.y);
  await until(() => page.evaluate("!!document.querySelector('.sidebar.edge-panel') && document.querySelector('.app-shell').classList.contains('sidebar-collapsed')"), "sidebar auto-hides after unpinning", 4000);
  await parkPointer();
  await sleep(500);
  const finalMain = await rect(".main-pane");
  assert.equal(Math.round(finalMain.left), 0);
  assert.equal(Math.round(finalMain.width), (await viewport()).width, "full width again");
  const finalSettings = await invoke("settingsGet");
  assert.notEqual(finalSettings.sidebarPinned, true);
  assert.notEqual(finalSettings.workPanelPinned, true);
  await capture("07-unpinned-again-light.png");
  await writeFile(join(output, "result.json"), json({ ok: true, coverage: ["default auto-hide", "edge dwell and delay", "menu hold", "shortcuts and Escape", "no-session right panel", "per-side pin persistence", "docked three-column layout"] }, null, 2));
  await Promise.all(["failure.txt", "failure.png"].map((name) => rm(join(output, name), { force: true })));
} catch (error) {
  await writeFile(join(output, "failure.txt"), String(error.stack ?? error) + "\n" + log.slice(-9000));
  if (page) { try { await capture("failure.png"); } catch {} }
  throw error;
} finally { await stopApp(); await rm(scratch, { recursive: true, force: true }); }
console.log(`Edge reveal side panels passed: ${output}`);
