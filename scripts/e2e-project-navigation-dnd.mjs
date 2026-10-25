#!/usr/bin/env node
/** Production Electron renderer journey for Project Console and workflow navigation.
 * Usage: node scripts/e2e-project-navigation-ui.mjs [--output /absolute/evidence-dir]
 * Seeds durable state through the real Rust Host; all acceptance interactions use the real DOM.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
const appBinary = process.env.PI_DESKTOP_APP_BIN;
const electronBinary = appBinary || process.env.PI_DESKTOP_ELECTRON_BIN || resolveElectronBinary(root).electronBinary;
const json = JSON.stringify, sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let sequence = 0, projectId, main, page, child, log = "", finalSnapshot;
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
    PI_DESKTOP_PLAN_UI_PROBE: "1", PI_DESKTOP_TEST_API_KEY: "local-fixture", PI_DESKTOP_TEST_BASE_URL: "http://127.0.0.1:9/v1", PI_DESKTOP_TEST_MODEL: "ui-fixture", ELECTRON_RENDERER_URL: "", PI_DESKTOP_START_MAXIMIZED: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electronBinary, [`--remote-debugging-port=${ports[0]}`, `--inspect=${ports[1]}`, `--user-data-dir=${join(scratch, "profile")}`, ...(appBinary ? [] : ["."])], { cwd: join(root, "apps/desktop"), env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout.on("data", chunk => { log += chunk; }); child.stderr.on("data", chunk => { log += chunk; });
  main = await connect(ports[1], "node"); page = await connect(ports[0], "page");
  await until(() => page.evaluate("!!window.piDesktop && !!document.querySelector('.app-shell:not(.is-booting)')"), "React-ready renderer and preload");
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

let group;
const dialogSelector = '[data-workflow="folder-dialog"]';
const clickMenuAction = async action => page.evaluate(`(() => { const el=document.querySelector('.sidebar-row-menu [data-action="'+${json(action)}+'"]'); if(!el || el.disabled) return false; el.click(); return true })()`);
const clickSelector = async selector => page.evaluate(`(() => { const el=document.querySelector(${json(selector)}); if(!el || el.disabled) return false; el.click(); return true })()`);
const contextMenuAt = async selector => page.evaluate(`(() => { const el=document.querySelector(${json(selector)}); if(!el) return false; const r=el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2})); return true })()`);
const rectOf = async selector => page.evaluate(`(() => { const el=document.querySelector(${json(selector)}); if(!el) return null; const r=el.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height} })()`);
const row = (kind, id) => `[data-workflow-tree-node="${kind}:${id}"] > .workflow-tree-row`;
const sleepFrame = () => sleep(120);
async function submitDialog(name, parentId = "") {
  await until(() => page.evaluate(`!!document.querySelector(${json(dialogSelector + " input")})`), "folder dialog");
  assert.ok(await fillControl(dialogSelector + " input", name));
  if (parentId) await page.evaluate(`(() => { const input=document.querySelector(${json(dialogSelector + " select")}); input.value=${json(parentId)}; input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await submitForm(dialogSelector + " form");
  await until(() => page.evaluate(`!document.querySelector(${json(dialogSelector)})`), "folder dialog closed");
}
// Row actions are revealed by hover or focus; the E2E clicks the real buttons.
async function folderMenuAction(folderId, action) {
  try { await until(() => clickSelector(`[data-workflow-folder="${folderId}"] > .workflow-tree-row [data-action="folder-menu"]`), "folder row menu", 8000); }
  catch (error) { throw new Error(`${error.message}\n${await page.evaluate(`document.querySelector('[data-workflow-folder="${folderId}"]')?.outerHTML ?? 'no node: '+[...document.querySelectorAll('[data-workflow-folder]')].map(x=>x.dataset.workflowFolder).join(',')`)}`); }
  await until(() => clickMenuAction(action), `folder menu ${action}`);
}

/** Real pointer drag: Chromium hit-tests the press, starts a native drag, and the drag events
 * are dispatched at real coordinates, so the draggable ancestor, dataTransfer and drop target
 * resolution are the ones a user gets. `grab` is where the user presses (defaults to the source). */
async function realDrag(grab, target, { fx = .5, fy = .5, indicator, captureName, inspect } = {}) {
  const point = async (selector, x = .5, y = .5) => {
    await page.evaluate(`document.querySelector(${json(selector)})?.scrollIntoView({block:'nearest'})`);
    const r = await rectOf(selector); assert.ok(r && r.width > 0 && r.height > 0, `visible ${selector}`);
    return { x: r.left + r.width * x, y: r.top + r.height * y };
  };
  // The tree locks dragging while a Host mutation is in flight.
  await until(() => page.evaluate(`document.querySelector(${json(grab)})?.closest(".workflow-tree-row, .sidebar-category-header")?.draggable===true`), `draggable ${grab}`, 8000);
  const from = await point(grab);
  // Records every native drag image the app sets, and the section geometry before the drag.
  await page.evaluate(`(() => { if (!window.__dragImages) { window.__dragImages = []; const set = DataTransfer.prototype.setDragImage; DataTransfer.prototype.setDragImage = function (el, x, y) { const cs = getComputedStyle(el), r = el.getBoundingClientRect(); window.__dragImages.push({ className: el.className, text: el.textContent, width: r.width, height: r.height, shadow: cs.boxShadow, radius: cs.borderRadius, background: cs.backgroundColor, inDocument: document.body.contains(el) }); return set.call(this, el, x, y); }; } window.__dragImages.length = 0; })()`);
  const tops = () => page.evaluate(`(() => { const t=[...document.querySelectorAll('[data-sidebar-category]')].map(el=>el.getBoundingClientRect().top); return t.map(v=>Math.round(v-t[0])) })()`);
  const topsBefore = await tops();
  const intercepted = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no native drag started from ${grab}`)), 12000);
    const onMessage = ({ data }) => { const msg = JSON.parse(String(data)); if (msg.method === "Input.dragIntercepted") { clearTimeout(timer); page.ws.removeEventListener("message", onMessage); resolve(msg.params.data); } };
    page.ws.addEventListener("message", onMessage);
  });
  await page.call("Input.setInterceptDrags", { enabled: true });
  try {
    await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
    await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
    for (const step of [4, 8, 14]) await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + step, y: from.y + step / 2, button: "left", buttons: 1 });
    const dragData = await intercepted;
    const to = await point(target, fx, fy);
    for (const type of ["dragEnter", "dragOver", "dragOver"]) await page.call("Input.dispatchDragEvent", { type, x: to.x, y: to.y, data: dragData });
    if (indicator) await until(() => page.evaluate(`!!document.querySelector(${json(indicator)})`), `drop indicator ${indicator}`, 4000);
    await sleep(250);
    const report = await page.evaluate(`(() => { const q = sel => document.querySelector(sel); const dim = q('.workflow-tree-node.is-dragging > .workflow-tree-row, .sidebar-category.is-dragging > .sidebar-category-header'); const el = ${json(indicator ?? "")} ? q(${json(indicator ?? "")}) : null; const cs = el && getComputedStyle(el); const before = el && getComputedStyle(el, '::before'), after = el && getComputedStyle(el, '::after'); return { dimOpacity: dim ? Number(getComputedStyle(dim).opacity) : null, dragImage: window.__dragImages.at(-1) ?? null, imagesLeft: document.querySelectorAll('.sidebar-drag-pill').length, background: cs?.backgroundColor, outlineStyle: cs?.outlineStyle, lineBefore: before && { height: before.height, radius: before.borderRadius, content: before.content }, lineAfter: after && { height: after.height, radius: after.borderRadius, content: after.content } } })()`);
    assert.deepEqual(await tops(), topsBefore, "no layout shift while dragging");
    inspect?.(report);
    if (captureName) await capture(captureName);
    await page.call("Input.dispatchDragEvent", { type: "drop", x: to.x, y: to.y, data: dragData });
    await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  } finally { await page.call("Input.setInterceptDrags", { enabled: false }); }
  await sleepFrame();
}
const setTheme = theme => page.evaluate(`document.documentElement.dataset.theme=${json(theme)}`);
// The user grabs a project by its name and a conversation by its title.
const projectHandle = id => `${row("project", id)} .sidebar-project-name`;
const sessionHandle = id => `${row("session", id)} .thread-item-main`;
const projectRow = async () => (await snapshot()).projectNavigation?.find(item => item.projectId === projectId);
const sessionRow = async id => (await snapshot()).navigation.find(item => item.sessionId === id);
try {
  const seed = new Host(hostBinary, data, { env: { HOME: home }, quiet: true });
  try { await seed.start(); projectId = (await seed.call("project.group.create", { name: "Project navigation", folders: [join(root,"apps")] })).group.id; } finally { await seed.stop(); }
  await startApp();
  const setup = await main.evaluate(`globalThis.__PI_DESKTOP_PLAN_UI_PROBE({operation:'liveSetup',workspace:${json(join(root,"apps"))}})`);
  assert.equal(setup.ok,true,json(setup));
  // The sidebar auto-hides by default; this journey drives the docked tree, so pin it (the hover reveal has its own journey: e2e-edge-reveal-side-panels).
  await invoke("settingsSet",{...(await invoke("settingsGet")),sidebarPinned:true});
  await page.call("Page.reload");
  await until(() => page.evaluate("!!document.querySelector('.app-shell:not(.is-booting)')"),"renderer reload after Host setup");
  await setTheme("light");
  await until(() => page.evaluate("!!document.querySelector('[data-sidebar-project-group]')"), "project row");
  group = await page.evaluate("document.querySelector('[data-sidebar-project-group]').dataset.sidebarProjectGroup");
  // A fresh custom category, created from the real + context menu.
  assert.ok(await contextMenuAt('.sidebar-header [data-nav="new-task"]'), "context menu on +");
  await until(() => clickMenuAction("new-category"), "New category menu item");
  await submitDialog("阅读");
  const category = await until(async () => (await snapshot()).categories?.find(item => item.name === "阅读"), "saved category");
  const section = `[data-sidebar-category="${category.id}"]`;
  const header = `${section} .sidebar-category-header`, body = `${section} .sidebar-category-body`;
  await until(() => page.evaluate(`!!document.querySelector(${json(section)})`), "custom category rendered");
  const where = async () => { const r = await projectRow(); return r?.folderId ? `folder:${r.folderId}` : `category:${r?.categoryId ?? "projects"}`; };
  const projectIn = async expected => until(async () => (await where()) === expected, `project placed in ${expected}`, 6000);

  // 1. Project -> empty custom category (body target).
  await realDrag(projectHandle(projectId), body, { indicator: `${body}.is-drop-inside, ${header}.is-drop-inside`, captureName: "drag-project-to-empty-category.png" });
  await projectIn(`category:${category.id}`);
  await until(() => page.evaluate(`!!document.querySelector(${json(`${body} [data-workflow-tree-node="project:${projectId}"]`)})`), "project rendered inside the custom category");
  // 2. Back to the 项目 header, then to the custom header.
  await realDrag(projectHandle(projectId), '[data-sidebar-category="projects"] .sidebar-category-header', { indicator: ".sidebar-category-header.is-drop-inside" });
  await projectIn("category:projects");
  await realDrag(projectHandle(projectId), header, { indicator: `${header}.is-drop-inside` });
  await projectIn(`category:${category.id}`);
  // 3. Project -> folder inside the custom category.
  assert.ok(await clickSelector(`${section} [data-action="category-new-folder"]`), "category + folder");
  await submitDialog("产品开发");
  const folderA = await until(async () => (await snapshot()).folders.find(f => f.name === "产品开发"), "category folder");
  await realDrag(projectHandle(projectId), row("folder", folderA.id), { indicator: `${row("folder", folderA.id)}.is-drop-inside`, captureName: "drag-project-to-folder.png" });
  await projectIn(`folder:${folderA.id}`);
  await realDrag(projectHandle(projectId), header, { indicator: `${header}.is-drop-inside` });
  await projectIn(`category:${category.id}`);
  // 4. Conversations: a new chat in the custom category -> 对话 header -> custom header -> folder -> before the folder.
  assert.ok(await clickSelector(`${section} [data-action="category-new-chat"]`), "category + new chat");
  const chat = await until(async () => (await snapshot()).navigation.find(item => item.categoryId === category.id), "new chat placed at the custom category root");
  await until(() => page.evaluate(`!!document.querySelector(${json(row("session", chat.sessionId))})`), "chat row");
  await realDrag(sessionHandle(chat.sessionId), '[data-sidebar-category="chats"] .sidebar-category-header', { indicator: ".sidebar-category-header.is-drop-inside" });
  await until(async () => ((await sessionRow(chat.sessionId))?.categoryId ?? "chats") === "chats", "chat moved to 对话");
  await realDrag(sessionHandle(chat.sessionId), header, { indicator: `${header}.is-drop-inside` });
  await until(async () => (await sessionRow(chat.sessionId))?.categoryId === category.id, "chat moved to the custom category");
  await realDrag(sessionHandle(chat.sessionId), row("folder", folderA.id), { indicator: `${row("folder", folderA.id)}.is-drop-inside` });
  await until(async () => (await sessionRow(chat.sessionId))?.folderId === folderA.id, "chat moved into the custom folder");
  await realDrag(sessionHandle(chat.sessionId), row("folder", folderA.id), { fy: .1, indicator: ".is-drop-before" });
  await until(async () => !(await sessionRow(chat.sessionId))?.folderId, "chat dropped before the folder at the category root");

  // ---- Drag preview and drop feedback (light and dark) ----
  const sectionOf = id => `[data-sidebar-category="${id}"]`, headerOf = id => `${sectionOf(id)} .sidebar-category-header`;
  const order = () => page.evaluate("[...document.querySelectorAll('[data-sidebar-category]')].map(el=>el.dataset.sidebarCategory)");
  const checkInto = (title) => report => {
    assert.ok(report.dragImage, "a custom drag image is set");
    assert.match(report.dragImage.className, /sidebar-drag-pill/);
    assert.equal(report.dragImage.text, title, "pill shows the dragged title");
    assert.ok(report.dragImage.width <= 220 && report.dragImage.inDocument, `compact pill (${report.dragImage.width}px)`);
    assert.notEqual(report.dragImage.shadow, "none", "pill has a shadow"); assert.notEqual(report.dragImage.radius, "0px", "pill is rounded");
    assert.equal(report.imagesLeft, 0, "offscreen pill is removed after dragstart");
    assert.ok(report.dimOpacity !== null && report.dimOpacity <= .55, `source dims (${report.dimOpacity})`);
    assert.notEqual(report.background, "rgba(0, 0, 0, 0)", "into-target has a soft tint"); assert.equal(report.outlineStyle, "none", "no dashed outline");
  };
  await setTheme("light");
  await realDrag(projectHandle(projectId), headerOf("projects"), { indicator: `${headerOf("projects")}.is-drop-inside`, captureName: "drag-into-light.png", inspect: checkInto("Project navigation") });
  await projectIn("category:projects");
  await setTheme("dark");
  await realDrag(projectHandle(projectId), header, { indicator: `${header}.is-drop-inside`, captureName: "drag-into-dark.png", inspect: checkInto("Project navigation") });
  await projectIn(`category:${category.id}`);
  const lineChecked = which => report => {
    const line = report[which];
    assert.ok(line && line.content !== "none" && line.height === "2px" && line.radius !== "0px", `2px rounded insertion line (${json(line)})`);
    assert.equal(report.dimOpacity <= .55, true, "dragged category dims");
  };

  // ---- Categories reorder by drag, built-ins included; order persists ----
  assert.deepEqual(await order(), ["chats", "projects", category.id]);
  await setTheme("light");
  await realDrag(`${header} .sidebar-category-title`, sectionOf("chats"), { fy: .1, indicator: ".sidebar-category.is-drop-before", captureName: "drag-reorder-light.png", inspect: lineChecked("lineBefore") });
  await until(async () => (await snapshot()).categoryOrder?.join() === [category.id, "chats", "projects"].join(), "custom category moved before 对话");
  assert.deepEqual(await order(), [category.id, "chats", "projects"]);
  await setTheme("dark");
  await realDrag(`${headerOf("chats")} .sidebar-category-title`, sectionOf("projects"), { fy: .9, indicator: ".sidebar-category.is-drop-after", captureName: "drag-reorder-dark.png", inspect: lineChecked("lineAfter") });
  await until(async () => (await snapshot()).categoryOrder?.join() === [category.id, "projects", "chats"].join(), "built-in 对话 moved after 项目");
  assert.deepEqual(await order(), [category.id, "projects", "chats"]);
  await setTheme("light");
  // Keyboard path: the custom category's menu, and the built-in header's context menu.
  assert.ok(await clickSelector(`${section} [data-action="category-menu"]`), "custom category menu");
  await until(() => page.evaluate("!!document.querySelector('.sidebar-row-menu [data-action=\"move-category-down\"]')"), "category menu");
  assert.deepEqual(await page.evaluate("[...document.querySelectorAll('.sidebar-row-menu [data-action]')].map(el=>el.dataset.action)"), ["rename-category", "move-category-up", "move-category-down", "delete-category"]);
  assert.equal(await page.evaluate("document.querySelector('.sidebar-row-menu [data-action=\"move-category-up\"]').disabled"), true, "first category cannot move up");
  await clickMenuAction("move-category-down");
  await until(async () => (await snapshot()).categoryOrder?.join() === ["projects", category.id, "chats"].join(), "menu moved the category down");
  assert.ok(await contextMenuAt(headerOf("chats")), "context menu on a built-in header");
  await until(() => page.evaluate("!!document.querySelector('.sidebar-row-menu [data-action=\"move-category-up\"]')"), "built-in menu");
  assert.deepEqual(await page.evaluate("[...document.querySelectorAll('.sidebar-row-menu [data-action]')].map(el=>el.dataset.action)"), ["move-category-up", "move-category-down"]);
  assert.equal(await page.evaluate("document.querySelector('.sidebar-row-menu [data-action=\"move-category-down\"]').disabled"), true, "last category cannot move down");
  await clickMenuAction("move-category-up");
  await until(async () => (await snapshot()).categoryOrder?.join() === ["projects", "chats", category.id].join(), "built-in menu moved 对话 up");
  await stopApp(); await startApp();
  assert.deepEqual((await snapshot()).categoryOrder, ["projects", "chats", category.id], "order persists in the Host");
  await until(async () => (await order()).join() === ["projects", "chats", category.id].join(), "order restored after restart");

  // ---- Header icons: only the pointer over THAT header, visible focus inside it, or its open menu ----
  const opacityOf = id => page.evaluate(`Number(getComputedStyle(document.querySelector(${json(sectionOf(id) + " .sidebar-category-actions")})).opacity)`);
  const moveTo = async (selector, fx = .5, fy = .5) => { const r = await rectOf(selector); await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.left + r.width * fx, y: r.top + r.height * fy }); await sleep(250); };
  await page.evaluate("document.documentElement.dataset.theme='light'");
  await moveTo("body", .9, .98);
  for (const id of ["chats", "projects", category.id]) assert.equal(await opacityOf(id), 0, `${id} actions hidden when the pointer is elsewhere`);
  await moveTo(`${headerOf(category.id)} .sidebar-category-title`);
  assert.equal(await opacityOf(category.id), 1, "hovered header shows its actions"); assert.equal(await opacityOf("chats"), 0); assert.equal(await opacityOf("projects"), 0);
  await moveTo(`${sectionOf(category.id)} .sidebar-category-body`, .5, .5);
  assert.equal(await opacityOf(category.id), 0, "hovering the category body does not show header actions");
  await moveTo(`${headerOf("chats")} .sidebar-category-title`);
  assert.equal(await opacityOf("chats"), 1); assert.equal(await opacityOf(category.id), 0);
  // Collapsed: same rule, and a chevron click leaves no lingering focus state.
  const chevron = `${headerOf(category.id)} .sidebar-category-chevron`;
  await moveTo(chevron); await page.call("Input.dispatchMouseEvent", { type: "mousePressed", ...(await (async r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }))(await rectOf(chevron))), button: "left", buttons: 1, clickCount: 1 });
  await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...(await (async r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }))(await rectOf(chevron))), button: "left", buttons: 0, clickCount: 1 });
  await until(() => page.evaluate(`document.querySelector(${json(chevron)}).getAttribute('aria-expanded')==='false'`), "category collapsed");
  assert.equal(await opacityOf(category.id), 1, "collapsed header shows actions while hovered");
  await moveTo(`${headerOf("projects")} .sidebar-category-title`);
  assert.equal(await opacityOf(category.id), 0, "collapsed header hides actions once the pointer leaves (no lingering focus)");
  assert.equal(await opacityOf("projects"), 1);
  await moveTo("body", .9, .98);
  // After a drag/drop that ends over a header, nothing lingers until the pointer moves again.
  await realDrag(`${headerOf(category.id)} .sidebar-category-title`, sectionOf("chats"), { fy: .1, indicator: ".sidebar-category.is-drop-before" });
  await until(async () => (await snapshot()).categoryOrder?.join() === ["projects", category.id, "chats"].join(), "collapsed category moved by drag");
  await sleep(250);
  for (const id of ["chats", "projects", category.id]) assert.equal(await opacityOf(id), 0, `${id} actions hidden right after a drop`);
  await moveTo(`${headerOf("projects")} .sidebar-category-title`);
  assert.equal(await opacityOf("projects"), 1, "hover works again after the drop");
  // Reopen the collapsed category and check the scroller hides its scrollbar.
  assert.ok(await clickSelector(chevron));
  const scroller = await page.evaluate(`(() => { const el=document.querySelector('.sidebar-category-scroll'); return { width: getComputedStyle(el).scrollbarWidth, webkit: getComputedStyle(el,'::-webkit-scrollbar').display, gutter: el.offsetWidth - el.clientWidth } })()`);
  assert.deepEqual(scroller, { width: "none", webkit: "none", gutter: 0 }, "sidebar list shows no scrollbar");
  await capture("sidebar-after-drops.png");
  await writeFile(join(output, "result.json"), json({ ok: true, sourceCommitAtRun, sourceChangesAtRun, interaction: "real pointer drag via CDP Input.dispatchDragEvent" }));
  await Promise.all(["failure.txt", "failure.png"].map(name => rm(join(output, name), { force: true })));
} catch (error) {
  await writeFile(join(output, "failure.txt"), String(error.stack ?? error) + "\n" + log.slice(-9000));
  if (page) { try { await capture("failure.png"); } catch {} }
  throw error;
} finally { await stopApp(); }
console.log(`Project navigation drag-and-drop passed: ${output}`);
