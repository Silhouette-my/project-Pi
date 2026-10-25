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
async function drag(sourceSelector, targetSelector, fraction = .5, captureName) {
  await until(() => page.evaluate(`document.querySelector(${json(sourceSelector)})?.draggable`), "drag source ready");
  await page.evaluate(`(() => { const source=document.querySelector(${json(sourceSelector)}); window.__navigationDrag=new DataTransfer(); source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:window.__navigationDrag})); })()`);
  await until(() => page.evaluate("!!document.querySelector('.workflow-tree-node.is-dragging')"), "drag state");
  await page.evaluate(`(() => { const target=document.querySelector(${json(targetSelector)}), rect=target.getBoundingClientRect(); target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:window.__navigationDrag,clientY:rect.top+rect.height*${fraction}})); })()`);
  await until(() => page.evaluate("!!document.querySelector('.is-drop-before,.is-drop-after,.is-drop-inside')"), "drop feedback");
  if (captureName) await capture(captureName);
  await page.evaluate(`(() => { const target=document.querySelector(${json(targetSelector)}), rect=target.getBoundingClientRect(); target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:window.__navigationDrag,clientY:rect.top+rect.height*${fraction}})); })()`);
}
const setTheme = theme => page.evaluate(`document.documentElement.dataset.theme=${json(theme)}`);
// Light and dark evidence of the real sidebar.
const captureBoth = async name => { await setTheme("light"); await sleepFrame(); await capture(`${name}-light.png`); await setTheme("dark"); await sleepFrame(); await capture(`${name}-dark.png`); await setTheme("light"); };
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

  // Top bar: search / new chat / pin / sidebar toggle, divider below; no duplicate new-chat icon at the main top-left while docked.
  assert.deepEqual(await page.evaluate("[...document.querySelectorAll('.sidebar-header-actions [data-nav]')].map(el=>el.dataset.nav)"), ["search","favorites","new-task","pin-sidebar","toggle-sidebar"]);
  // The search tooltip carries its shortcut like the other shortcut tooltips.
  const searchRect = await rectOf('.sidebar-header [data-nav="search"]');
  await until(async () => { await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: searchRect.left + searchRect.width / 2 + (sequence % 2), y: searchRect.top + searchRect.height / 2 }); sequence += 1; return page.evaluate("/(⌘|Ctrl\\+)K/.test(document.querySelector('.ui-tooltip')?.textContent ?? '')"); }, "search tooltip shows its shortcut");
  await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400, y: 400 });
  assert.ok(await page.evaluate("getComputedStyle(document.querySelector('.sidebar-header')).borderBottomWidth==='1px'"), "divider below the sidebar top bar");
  assert.equal(await page.evaluate("document.querySelectorAll('.ct-lead [data-nav=new-task]').length>0 && document.querySelector('.conversation-topbar.ct-collapsed')!==null"), false, "no titlebar new-chat while the sidebar is docked");
  assert.ok(await clickSelector('.sidebar-header [data-nav="search"]'));
  await until(() => page.evaluate("!!document.querySelector('.search-dialog')"), "global search opened from the sidebar");
  await page.evaluate("document.querySelector('.search-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await until(() => page.evaluate("!document.querySelector('.search-dialog')"), "global search closed");

  // Projects: the cube opens project home (active tile, no full-row highlight); the name toggles; no 项目首页 row; no Agent or colour controls.
  assert.equal(await page.evaluate(`[...document.querySelectorAll('[data-sidebar-project-group] button')].some(x=>/Project home|项目首页/.test(x.textContent||''))`), false, "no Project home row");
  assert.ok(await clickSelector('[data-sidebar-project-group] .sidebar-project-cube'));
  await until(() => page.evaluate("!!document.querySelector('[data-workflow=console]')"), "project home");
  assert.ok(await page.evaluate(`document.querySelector('[data-sidebar-project-group] .sidebar-project-cube').classList.contains('is-active')`), "cube is the active tile on home");
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('[data-sidebar-project-group] .sidebar-project-row')).backgroundColor`), "rgba(0, 0, 0, 0)", "no full-row highlight on home");
  assert.ok(await page.evaluate(`document.querySelector('[data-sidebar-project-group] .project-toggle')?.textContent.includes('Project navigation')`),"logical project name must replace root basename");
  await capture("project-home-light.png");
  // The Project Agent is a hover action on the project row (before the more menu); it reveals the Agent tab in the work panel.
  assert.deepEqual(await page.evaluate("[...document.querySelectorAll('[data-sidebar-project-group] .sidebar-project-row .workflow-tree-actions [data-action], [data-sidebar-project-group] .sidebar-project-row .workflow-tree-actions button')].map(el=>el.dataset.action||'more')"), ["project-new-chat","project-new-folder","project-agent","more"]);
  const projectRowRect = await rectOf('[data-sidebar-project-group] .sidebar-project-row');
  await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: projectRowRect.left + 90, y: projectRowRect.top + projectRowRect.height / 2 });
  await until(() => page.evaluate("getComputedStyle(document.querySelector('[data-sidebar-project-group] .sidebar-project-row .workflow-tree-actions')).display==='flex'"), "project row actions revealed by hover");
  const agentRect = await rectOf('[data-sidebar-project-group] [data-action="project-agent"]');
  await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: agentRect.left + agentRect.width / 2, y: agentRect.top + agentRect.height / 2 });
  await until(() => page.evaluate("/Project Agent|项目 Agent/.test(document.querySelector('.ui-tooltip')?.textContent ?? '')"), "Agent action tooltip");
  await capture("project-row-hover-light.png");
  assert.ok(await clickSelector('[data-sidebar-project-group] [data-action="project-agent"]'));
  await until(() => page.evaluate("!!document.querySelector('.work-panel [role=tab][aria-selected=true]')"), "work panel revealed with an active tab");
  assert.match(await page.evaluate("document.querySelector('.work-panel [role=tab][aria-selected=true]').textContent"), /Project Agent|项目 Agent/, "Agent tab label");
  await until(() => page.evaluate("!!document.querySelector('[data-project-agent-dock] textarea')"), "Agent composer");
  assert.match(await page.evaluate("document.querySelector('[data-project-agent-dock] textarea').placeholder"), /Discuss with the Project Agent|与项目 Agent 讨论/, "Agent composer placeholder");
  assert.equal(await page.evaluate("!!document.querySelector('[data-project-agent-dock] .detached-conversation-scope')"), false, "no project-name chip in the Agent composer");
  await capture("project-agent-tab-light.png");
  await page.evaluate("document.documentElement.dataset.theme='dark'"); await sleepFrame(); await capture("project-agent-tab-dark.png"); await setTheme("light");
  const toggleOpen = () => page.evaluate(`document.querySelector('[data-sidebar-project-group] .project-toggle').getAttribute('aria-expanded')`);
  assert.equal(await toggleOpen(), "true");
  assert.ok(await clickSelector('[data-sidebar-project-group] .project-toggle'));
  await until(async () => (await toggleOpen()) === "false", "name click collapses the project");
  assert.equal(await page.evaluate("document.querySelector('[data-workflow=console]')!==null"), true, "toggling must not leave project home");
  assert.ok(await clickSelector('[data-sidebar-project-group] .project-toggle'));
  await until(async () => (await toggleOpen()) === "true", "name click expands the project");
  // Project menu: grouped by dividers, in the approved order.
  assert.ok(await clickSelector('[data-sidebar-project-group] .project-more'));
  await until(() => page.evaluate("!!document.querySelector('.sidebar-row-menu')"), "project menu");
  assert.deepEqual(await page.evaluate("[...document.querySelectorAll('.sidebar-row-menu > [role=menuitem], .sidebar-row-menu [data-action]')].map(el=>el.dataset.action).slice(0,5)"), ["new-project-chat","new-project-folder","project-instructions","project-memory","edit-project"]);
  assert.deepEqual(await page.evaluate("[...document.querySelectorAll('.sidebar-row-menu [data-action], .sidebar-row-menu [data-submenu-trigger]')].map(el=>el.dataset.action||el.dataset.submenuTrigger)"), ["new-project-chat","new-project-folder","project-instructions","project-memory","edit-project","toggle-project-favorite","toggle-project-pin","open-project-folder","project-copy","project-git","toggle-project-archive","project-danger"]);
  assert.equal(await page.evaluate("document.querySelectorAll('.sidebar-row-menu [role=separator]').length"), 5, "five dividers split the project menu into six groups");
  await captureBoth("project-menu");
  // Star the project from its menu; the row it creates keeps the order the project showed.
  const orderBefore = (await snapshot()).projectNavigation?.find(item => item.projectId === projectId)?.order;
  await clickMenuAction("toggle-project-favorite");
  await until(async () => (await snapshot()).projectNavigation?.find(item => item.projectId === projectId)?.favorite === true, "project favourite persisted");
  if (orderBefore !== undefined) assert.equal((await snapshot()).projectNavigation.find(item => item.projectId === projectId).order, orderBefore, "starring keeps the project's order");
  assert.ok(await clickSelector('[data-sidebar-project-group] .project-more'));
  await until(() => page.evaluate("!!document.querySelector('.sidebar-row-menu [data-action=toggle-project-favorite]')"), "project menu again");
  assert.match(await page.evaluate("document.querySelector('.sidebar-row-menu [data-action=toggle-project-favorite]').textContent"), /Remove from Favorites|取消收藏/);
  assert.equal(await page.evaluate("!!document.querySelector('.sidebar-row-menu [data-submenu-trigger=\"project-color\"]')"), false, "no project colour in the menu");
  await page.evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");

  // Categories: right-click + -> New category; custom headers mix projects, folders and chats; layout is inset 8px from the header.
  assert.ok(await contextMenuAt('.sidebar-header [data-nav="new-task"]'), "context menu on +");
  await until(() => clickMenuAction("new-category"), "New category menu item");
  await submitDialog("阅读");
  const category = await until(async () => (await snapshot()).categories?.find(item => item.name === "阅读"), "saved category");
  const section = `[data-sidebar-category="${category.id}"]`;
  await until(() => page.evaluate(`!!document.querySelector(${json(section)})`), "custom category rendered");
  assert.equal(await page.evaluate(`!!document.querySelector(${json(section + " .is-recent-row")})`), false, "custom categories have no Recent group");
  assert.ok(await page.evaluate(`document.querySelector(${json(section)}).textContent.includes('Nothing here yet') || document.querySelector(${json(section)}).textContent.includes('暂无内容')`), "empty custom category says so");
  const folderA = await (async () => { assert.ok(await clickSelector(`${section} [data-action="category-new-folder"]`), "category + folder"); await submitDialog("产品开发"); return until(async () => (await snapshot()).folders.find(f => f.name === "产品开发"), "category folder"); })();
  assert.equal(folderA.categoryId, category.id, "folder lives in the custom category");
  const folderB = await (async () => { await folderMenuAction(folderA.id, "new-subfolder"); await submitDialog("桌面应用"); return until(async () => (await snapshot()).folders.find(f => f.name === "桌面应用"), "subfolder"); })();
  const folderC = await (async () => { await folderMenuAction(folderB.id, "new-subfolder"); await submitDialog("AI 工作空间"); return until(async () => (await snapshot()).folders.find(f => f.name === "AI 工作空间"), "third folder"); })();
  assert.equal(folderB.parentId, folderA.id); assert.equal(folderC.parentId, folderB.id); assert.equal(folderC.categoryId, category.id, "nested folders inherit the category");
  await mutate("navigation.expand",{expandedIds:[...(await snapshot()).expandedIds,folderA.id,folderB.id,folderC.id]});
  await until(() => page.evaluate(`!!document.querySelector(${json(row("folder",folderC.id))})`),"third-level folder visible");
  // Unlimited nesting, ONE indent level: folders of every depth below the first share one x; the folder icon has no chevron.
  const xB = (await rectOf(row("folder",folderB.id))).left, xC = (await rectOf(row("folder",folderC.id))).left;
  assert.equal(Math.round(xB), Math.round(xC), "nested folders share one indent");
  assert.ok(Math.round(xB) - Math.round((await rectOf(row("folder",folderA.id))).left) >= 12, "contents indent one step from the shaded block's folder row");
  assert.equal(await page.evaluate(`document.querySelectorAll(${json(`[data-workflow-folder="${folderA.id}"] .workflow-tree-folder .lucide-chevron-down, [data-workflow-folder="${folderA.id}"] > .workflow-tree-row .workflow-tree-folder [class*=chevron]`)}).length`), 0, "folder rows have no chevron");
  assert.ok(await page.evaluate(`document.querySelector(${json(`[data-workflow-folder="${folderA.id}"]`)}).classList.contains('is-block')`), "expanded folder is a shaded block");
  // Header title and item tiles are 8px apart from the sidebar edge together: tile x equals header text x.
  const titleX = (await rectOf(`${section} .sidebar-category-title`)).left, tileX = (await rectOf(`${section} .workflow-tree-node > .workflow-tree-row`)).left;
  assert.ok(Math.abs(titleX - tileX) <= 1, `category title x (${titleX}) equals item tile x (${tileX})`);
  // Chevron right after the title; hover actions right-aligned.
  const headerRects = await page.evaluate(`(() => { const h=document.querySelector(${json(section + " .sidebar-category-header")}); const t=h.querySelector('.sidebar-category-title').getBoundingClientRect(), c=h.querySelector('.sidebar-category-chevron').getBoundingClientRect(), a=h.querySelector('.sidebar-category-actions').getBoundingClientRect(), hr=h.getBoundingClientRect(); return {gap:c.left-t.right, actionsRight:hr.right-a.right} })()`);
  assert.ok(headerRects.gap >= 0 && headerRects.gap <= 8, `chevron follows the title (${headerRects.gap}px)`);
  assert.ok(headerRects.actionsRight <= 6, "category actions are right-aligned");

  // Mix a project and a conversation into the custom category, deep inside the nested folders.
  await drag(row("project",projectId),row("folder",folderC.id));
  await until(async () => (await snapshot()).projectNavigation?.find(item=>item.projectId===projectId)?.folderId===folderC.id,"project in third-level folder");
  assert.equal((await snapshot()).projectNavigation.find(item=>item.projectId===projectId).categoryId, undefined, "folder placement carries the category");
  await until(() => page.evaluate(`!!document.querySelector(${json(`[data-workflow-folder="${folderC.id}"] [data-sidebar-project-group]`)})`),"categorized project is visible inside its folder");
  assert.ok(await clickSelector(`${section} [data-action="category-new-chat"]`), "category + new chat");
  const chat = await until(async () => (await snapshot()).navigation.find(item => item.categoryId === category.id), "new chat placed at the custom category root");
  await until(() => page.evaluate(`!!document.querySelector(${json(`${section} .sidebar-category-body > [data-workflow-tree-node="session:${chat.sessionId}"]`)})`), "conversation at the category root");
  const rootChatX = (await rectOf(`${section} .sidebar-category-body > [data-workflow-tree-node="session:${chat.sessionId}"] .thread-item-title`)).left;
  const folderTextX = (await rectOf(`${section} [data-workflow-folder="${folderA.id}"] > .workflow-tree-row .workflow-tree-folder span`)).left;
  assert.ok(Math.abs(rootChatX - folderTextX) <= 1, `root chat title x (${rootChatX}) aligns with folder title x (${folderTextX})`);
  await captureBoth("sidebar-categories");

  // Status dot geometry: vertically centred; right inset equals the top/bottom gap; hover "..." takes the same slot.
  const geometry = await page.evaluate(`(() => { const item=document.querySelector(${json(`${section} .sidebar-category-body > [data-workflow-tree-node="session:${chat.sessionId}"] .thread-item`)}); const meta=item.querySelector('.thread-item-meta'); const dot=document.createElement('span'); dot.className='thread-item-status running'; meta.prepend(dot); const r=item.getBoundingClientRect(), d=dot.getBoundingClientRect(); const out={top:d.top-r.top,bottom:r.bottom-d.bottom,right:r.right-d.right,color:getComputedStyle(dot).backgroundColor,left:item.querySelector('.thread-item-main').getBoundingClientRect().left-r.left}; dot.remove(); return out })()`);
  assert.ok(Math.abs(geometry.top-geometry.bottom)<=1, `status dot is vertically centred (${json(geometry)})`);
  assert.ok(Math.abs(geometry.right-geometry.top)<=1, `status dot right inset equals its top/bottom gap (${json(geometry)})`);
  assert.equal(await page.evaluate(`document.querySelector(${json(`${section} .sidebar-category-body > [data-workflow-tree-node="session:${chat.sessionId}"] .thread-item`)}).querySelectorAll('svg:not(.thread-item-more svg)').length`), 0, "session rows have no left icon");
  // Session menu order.
  assert.ok(await clickSelector(`${section} [data-workflow-tree-node="session:${chat.sessionId}"] [data-action="session-menu"]`));
  await until(() => page.evaluate("!!document.querySelector('.sidebar-row-menu')"), "session menu");
  const menuIds = await page.evaluate("[...document.querySelectorAll('.sidebar-row-menu [data-action], .sidebar-row-menu [data-submenu-trigger]')].map(el=>el.dataset.action||el.dataset.submenuTrigger)");
  const wanted = ["rename-session","toggle-session-pin","toggle-session-favorite","move-session-to-folder","toggle-session-archive","session-copy","session-danger"];
  assert.deepEqual(menuIds.filter(id => wanted.includes(id)), wanted, `session menu order (${json(menuIds)})`);
  // Favourites: the menu toggles the persisted flag; the star button swaps the tree for the Favorites view.
  await clickMenuAction("toggle-session-favorite");
  await until(async () => (await snapshot()).navigation.find(item => item.sessionId === chat.sessionId)?.favorite === true, "favourite persisted");
  await page.evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
  // A conversation inside the project (project scope) takes the same toggle in the same menu position.
  assert.ok(await clickSelector(`[data-sidebar-project-group] [data-workflow-tree-node="session:${setup.sessionId}"] [data-action="session-menu"]`));
  await until(() => page.evaluate("!!document.querySelector('.sidebar-row-menu')"), "project chat menu");
  assert.deepEqual((await page.evaluate("[...document.querySelectorAll('.sidebar-row-menu [data-action], .sidebar-row-menu [data-submenu-trigger]')].map(el=>el.dataset.action||el.dataset.submenuTrigger)")).filter(id => wanted.includes(id)).slice(0,4), ["rename-session","toggle-session-pin","toggle-session-favorite","move-session-to-folder"]);
  await clickMenuAction("toggle-session-favorite");
  await until(async () => (await snapshot()).navigation.find(item => item.sessionId === setup.sessionId)?.favorite === true, "project chat favourite persisted");
  await page.evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
  await capture("sidebar-tree-light.png");
  assert.ok(await clickSelector('.sidebar-header [data-nav="favorites"]'));
  await until(() => page.evaluate("!!document.querySelector('[data-sidebar-view=favorites]')"), "Favorites view");
  assert.equal(await page.evaluate("document.querySelector('.sidebar-header [data-nav=favorites]').getAttribute('aria-pressed')"), "true");
  assert.equal(await page.evaluate("document.querySelectorAll('[data-sidebar-category]').length"), 0, "the Favorites view replaces the category tree");
  assert.match(await page.evaluate("document.querySelector('[data-sidebar-view=favorites] .sidebar-favorites-header').textContent"), /Favorites|收藏/);
  assert.equal(await page.evaluate(`!!document.querySelector('[data-sidebar-view=favorites] [data-sidebar-session-row="${chat.sessionId}"], [data-sidebar-view=favorites] [data-workflow-tree-node="session:${chat.sessionId}"]')`), true, "favourite listed with its row");
  assert.ok(await page.evaluate(`!!document.querySelector('[data-sidebar-view=favorites] [data-workflow-tree-node="session:${chat.sessionId}"] [data-action="session-menu"]')`), "favourite rows keep their menus");
  // Projects first (cube row, not expandable), then conversations from anywhere with their project as muted text.
  assert.equal(await page.evaluate(`!!document.querySelector('[data-sidebar-view=favorites] [data-favorite-project="${projectId}"] .sidebar-project-cube')`), true, "favourite project listed with its cube");
  assert.equal(await page.evaluate(`!!document.querySelector('[data-sidebar-view=favorites] [data-favorite-project="${projectId}"] [aria-expanded]')`), false, "favourite project rows are not expandable");
  assert.equal(await page.evaluate(`document.querySelector('[data-sidebar-view=favorites] .workflow-tree-node').dataset.workflowTreeNode`), `project:${projectId}`, "projects are listed before conversations");
  assert.equal(await page.evaluate(`document.querySelector('[data-sidebar-view=favorites] [data-workflow-tree-node="session:${setup.sessionId}"] .sidebar-favorite-origin')?.textContent`), "Project navigation", "project chats show their project");
  assert.equal(await page.evaluate(`!!document.querySelector('[data-sidebar-view=favorites] [data-workflow-tree-node="session:${chat.sessionId}"] .sidebar-favorite-origin')`), false, "standalone chats have no origin line");
  await captureBoth("sidebar-favorites");
  assert.ok(await clickSelector(`[data-sidebar-view=favorites] [data-favorite-project="${projectId}"] .project-toggle`));
  await until(() => page.evaluate(`document.querySelector('[data-workflow=console]')!==null`), "the favourite project's name opens project home");
  // Esc inside the sidebar returns to the tree; the button toggles it again; the persisted choice survives a reload later.
  await page.evaluate("document.querySelector('.sidebar-header [data-nav=favorites]').focus()");
  await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until(() => page.evaluate("!document.querySelector('[data-sidebar-view=favorites]') && !!document.querySelector('[data-sidebar-category=chats]')"), "Esc returns to the tree");
  assert.equal(await page.evaluate("document.querySelector('.sidebar-header [data-nav=favorites]').getAttribute('aria-pressed')"), "false");
  assert.ok(await clickSelector('.sidebar-header [data-nav="favorites"]'));
  await until(() => page.evaluate("!!document.querySelector('[data-sidebar-view=favorites]')"), "Favorites view again");
  assert.ok(await clickSelector(`[data-sidebar-view=favorites] [data-workflow-tree-node="session:${chat.sessionId}"] [data-action="session-menu"]`));
  await until(() => clickMenuAction("toggle-session-favorite"), "unfavourite from the Favorites view");
  await until(async () => (await snapshot()).navigation.find(item => item.sessionId === chat.sessionId)?.favorite === false, "favourite cleared");
  assert.ok(await clickSelector('.sidebar-header [data-nav="favorites"]'));
  await until(() => page.evaluate("!document.querySelector('[data-sidebar-view=favorites]') && !!document.querySelector('[data-sidebar-category=chats]')"), "button returns to the tree");

  // Projects header: New project then New folder; a folder made there lives in the Projects category.
  assert.deepEqual(await page.evaluate("[...document.querySelectorAll('[data-sidebar-category=projects] .sidebar-category-header [data-action]')].map(el=>el.dataset.action)"), ["new-project","category-new-folder"]);
  assert.ok(await clickSelector('[data-sidebar-category="projects"] [data-action="category-new-folder"]'));
  await submitDialog("项目文件夹");
  const projectsFolder = await until(async () => (await snapshot()).folders.find(f => f.name === "项目文件夹"), "folder in the Projects category");
  assert.equal(projectsFolder.categoryId, "projects");
  await folderMenuAction(projectsFolder.id, "remove-folder");
  await until(async () => !(await snapshot()).folders.some(f => f.id === projectsFolder.id), "Projects folder removed");

  // Project folders: a project's own tree. Nested folders render flat; remove never deletes chats.
  assert.ok(await clickSelector('[data-sidebar-project-group] [data-action="project-new-folder"]'), "project + folder");
  await submitDialog("设计与决策");
  const chats = await until(async () => (await snapshot()).folders.find(folder => folder.name === "设计与决策"), "project folder");
  assert.equal(chats.scope, "project");
  await folderMenuAction(chats.id, "new-subfolder"); await submitDialog("交互设计");
  const chats2 = await until(async () => (await snapshot()).folders.find(folder => folder.name === "交互设计"), "project subfolder");
  await folderMenuAction(chats2.id, "new-subfolder"); await submitDialog("导航方案");
  const chats3 = await until(async () => (await snapshot()).folders.find(folder => folder.name === "导航方案"), "project third folder");
  await mutate("navigation.expand",{expandedIds:[...(await snapshot()).expandedIds,chats.id,chats2.id,chats3.id]});
  await until(() => page.evaluate(`!!document.querySelector(${json(row("folder",chats3.id))})`),"deep conversation folder visible");
  assert.equal(Math.round((await rectOf(row("folder",chats2.id))).left), Math.round((await rectOf(row("folder",chats3.id))).left), "project subfolders share one indent");
  // Rename, Move to and Remove through the "..." menu; new subfolder keeps the parent.
  const scratch = await (async () => { await folderMenuAction(chats.id, "new-subfolder"); await submitDialog("临时"); return until(async () => (await snapshot()).folders.find(folder => folder.name === "临时"), "scratch folder"); })();
  await folderMenuAction(scratch.id, "rename-folder");
  await until(() => page.evaluate(`!!document.querySelector(${json(dialogSelector + " input")})`), "rename dialog");
  assert.ok(await fillControl(dialogSelector + " input", "临时目录"));
  await capture("folder-rename-dialog-light.png");
  await submitForm(dialogSelector + " form");
  await until(async () => (await snapshot()).folders.find(folder => folder.id === scratch.id)?.name === "临时目录", "renamed folder");
  await until(() => page.evaluate(`!document.querySelector(${json(dialogSelector)})`), "rename dialog closed");
  // Move to... is the keyboard path for relocating a folder.
  await folderMenuAction(scratch.id, "move-folder");
  await until(() => page.evaluate(`!!document.querySelector(${json(dialogSelector + " select")})`), "folder move dialog");
  await page.evaluate(`(() => { const input=document.querySelector(${json(dialogSelector + " select")}); input.value=${json(chats2.id)}; input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await submitForm(dialogSelector + " form");
  await until(async () => (await snapshot()).folders.find(folder => folder.id === scratch.id)?.parentId === chats2.id, "folder moved through the menu");
  await until(() => page.evaluate(`!document.querySelector(${json(dialogSelector)})`), "move dialog closed");
  await page.evaluate(`document.querySelector(${json(row("folder",chats.id))}).scrollIntoView({block:'center'})`);
  // Hover with a real pointer so the row's actions are visible, then open its menu.
  const hoverRect = await rectOf(row("folder",chats.id));
  await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: hoverRect.left + 60, y: hoverRect.top + hoverRect.height / 2 });
  await until(() => page.evaluate(`getComputedStyle(document.querySelector(${json(`[data-workflow-folder="${chats.id}"] > .workflow-tree-row .workflow-tree-actions`)})).display==='flex'`), "folder actions revealed by hover");
  await capture("folder-row-hover-light.png");
  assert.ok(await clickSelector(`[data-workflow-folder="${chats.id}"] > .workflow-tree-row [data-action="folder-menu"]`));
  await until(() => page.evaluate("!!document.querySelector('.sidebar-row-menu [data-action=\"rename-folder\"]')"), "folder menu");
  assert.deepEqual(await page.evaluate("[...document.querySelectorAll('.sidebar-row-menu [data-action]')].map(el=>el.dataset.action)"), ["rename-folder","new-subfolder","move-folder","remove-folder"], "folder menu: Rename, New folder, Move to, Remove");
  await captureBoth("folder-menu");
  await page.evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
  await until(() => page.evaluate("!document.querySelector('.sidebar-row-menu')"), "folder menu dismissed");
  await folderMenuAction(scratch.id, "remove-folder");
  await until(async () => !(await snapshot()).folders.some(folder => folder.id === scratch.id), "folder removal needs no confirmation");
  await drag(row("session",setup.sessionId),row("folder",chats3.id),.5,"drop-inside-folder.png");
  await until(async () => (await snapshot()).navigation.find(item=>item.sessionId===setup.sessionId)?.folderId===chats3.id,"project conversation placement");
  await drag(row("session",setup.sessionId),row("folder",chats.id),.1,"drop-before-folder.png");
  await until(async () => !(await snapshot()).navigation.find(item=>item.sessionId===setup.sessionId)?.folderId,"project conversation back at root");
  await captureBoth("project-tree");

  // Hidden sidebar: the titlebar shows the toggle and New chat (no search); the docked chrome has no extra new-chat icon.
  // The favourite project's name opened project home earlier; the collapsed titlebar journey runs on a chat page.
  assert.ok(await clickSelector('.sidebar-header [data-nav="new-task"]'));
  await until(() => page.evaluate("!document.querySelector('[data-workflow=console]')"), "back on a chat page");
  assert.ok(await clickSelector('.sidebar-header [data-nav="toggle-sidebar"]'));
  await until(() => page.evaluate("!document.querySelector('.sidebar') && document.querySelector('.conversation-topbar.ct-collapsed')!==null"), "sidebar hidden");
  await sleep(400);
  await until(() => page.evaluate("document.querySelectorAll('.conversation-topbar.ct-collapsed .ct-lead .ct-icon-btn').length===2"), "collapsed titlebar shows toggle + new chat");
  await capture("titlebar-collapsed-light.png");
  assert.ok(await clickSelector('.conversation-topbar .ct-lead [data-nav="toggle-sidebar"], .conversation-topbar .ct-lead .ct-icon-btn'));
  await until(() => page.evaluate("!!document.querySelector('.sidebar:not(.is-exiting)')"), "sidebar restored");

  // Deleting a custom category keeps everything: contents fall back to the built-in categories.
  assert.ok(await clickSelector(`${section} [data-action="category-menu"]`));
  await until(() => page.evaluate("!!document.querySelector('.sidebar-row-menu [data-action=\"delete-category\"]')"), "category menu");
  assert.deepEqual(await page.evaluate("[...document.querySelectorAll('.sidebar-row-menu [data-action]')].map(el=>el.dataset.action)"), ["rename-category","delete-category"]);
  await clickMenuAction("delete-category");
  await until(async () => !(await snapshot()).categories?.length, "category removed without confirmation");
  const afterDelete = await snapshot();
  assert.equal(afterDelete.folders.find(folder => folder.id === folderA.id).categoryId, "chats", "folder fell back to Chats");
  assert.equal(afterDelete.navigation.find(item => item.sessionId === chat.sessionId).categoryId, "chats", "chat fell back to Chats");
  assert.equal(afterDelete.projectNavigation.find(item=>item.projectId===projectId).folderId, folderC.id, "project kept its folder");

  await stopApp();await startApp();
  const persisted=await snapshot();
  assert.equal(persisted.projectNavigation.find(item=>item.projectId===projectId).folderId,folderC.id);
  // Favourites survive a restart: the Host kept both flags, and the view lists both after reload.
  assert.equal(persisted.projectNavigation.find(item=>item.projectId===projectId).favorite,true,"project favourite survives restart");
  assert.equal(persisted.navigation.find(item=>item.sessionId===setup.sessionId).favorite,true,"project chat favourite survives restart");
  await page.evaluate("document.documentElement.dataset.theme='light'");
  await until(() => page.evaluate("!!document.querySelector('.sidebar-header [data-nav=favorites]')"), "favourites button after restart");
  assert.ok(await clickSelector('.sidebar-header [data-nav="favorites"]'));
  await until(() => page.evaluate(`!!document.querySelector('[data-sidebar-view=favorites] [data-favorite-project="${projectId}"]') && !!document.querySelector('[data-sidebar-view=favorites] [data-workflow-tree-node="session:${setup.sessionId}"]')`), "favourites listed after restart");
  // Clearing both leaves the one-line empty state.
  assert.ok(await clickSelector(`[data-sidebar-view=favorites] [data-favorite-project="${projectId}"] [data-action="unfavorite-project"]`));
  await until(async () => (await snapshot()).projectNavigation.find(item=>item.projectId===projectId).favorite===false, "project unfavourited from the view");
  assert.ok(await clickSelector(`[data-sidebar-view=favorites] [data-workflow-tree-node="session:${setup.sessionId}"] [data-action="session-menu"]`));
  await until(() => clickMenuAction("toggle-session-favorite"), "unfavourite project chat");
  await until(() => page.evaluate("/Nothing favorited|暂无收藏/.test(document.querySelector('[data-sidebar-view=favorites]')?.textContent ?? '')"), "empty Favorites state");
  await capture("sidebar-favorites-empty-light.png");
  assert.ok(await clickSelector('.sidebar-header [data-nav="favorites"]'));
  await writeFile(join(output,"result.json"),json({ok:true,sourceCommitAtRun,sourceChangesAtRun,builtCommit,hostBuiltCommit,projectId,coverage:["top bar order and search","cube opens project home, no row highlight","custom category create/mix/delete","one-indent nested folders","status dot geometry","session and project menus","hidden-sidebar titlebar","before/inside drag feedback","navigation-only session move","restart persistence"],interaction:"production renderer DOM DragEvent and click handlers; no physical pointer or model calls"}));
  await Promise.all(["failure.txt","failure.png"].map(name => rm(join(output,name),{force:true})));
} catch(error) {
  await writeFile(join(output,"failure.txt"),String(error.stack??error)+"\n"+log.slice(-9000));
  if(page) { try { await capture("failure.png"); } catch {} }
  throw error;
} finally { await stopApp(); }
console.log(`Project navigation UI passed: ${output}`);
