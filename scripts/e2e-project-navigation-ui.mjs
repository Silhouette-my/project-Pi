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
const treeSelector = scope => `[data-workflow-tree="${scope}"]`;
const dialogSelector = '[data-workflow="folder-dialog"]';
const clickMenuAction = async action => page.evaluate(`(() => { const el=document.querySelector('.sidebar-row-menu [data-action="'+${json(action)}+'"]'); if(!el || el.disabled) return false; el.click(); return true })()`);
// New folder lives in the owning project's overflow menu (project scope) or the
// Projects section menu (project categories); Chats keeps its header button.
async function openFolderDialog(scope) {
  if (scope === "project") {
    assert.ok(await page.evaluate(`(() => { const group=document.querySelector('[data-sidebar-project-group="'+${json(group)}+'"]'); const more=group?.querySelector('.project-more'); if(!more) return false; more.click(); return true })()`), "project overflow menu");
    await until(() => clickMenuAction("new-project-folder"), "project New folder menu item");
  } else {
    assert.ok(await page.evaluate(`(() => { const bar=document.querySelector('[data-sidebar-section="projects"]'); if(!bar) return false; const rect=bar.getBoundingClientRect(); bar.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+20,clientY:rect.top+8})); return true })()`), "projects section menu");
    await until(() => clickMenuAction("new-project-category-folder"), "projects New folder menu item");
  }
  await until(() => page.evaluate(`!!document.querySelector(${json(dialogSelector + " input")})`), "folder dialog");
}
async function createFolder(scope, name, parentId = "") {
  await openFolderDialog(scope);
  assert.ok(await fillControl(dialogSelector + " input", name));
  if (parentId) await page.evaluate(`(() => { const input=document.querySelector(${json(dialogSelector + " select")}); input.value=${json(parentId)}; input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await submitForm(dialogSelector + " form");
  const folder = await until(async () => (await snapshot()).folders.find(folder => folder.name === name), `saved folder ${name}`);
  await until(() => page.evaluate(`!document.querySelector(${json(dialogSelector)})`), "folder dialog closed");
  return folder;
}
// Rename and Move live in the folder row's "..." menu, which hover or focus reveals.
async function folderMenuAction(folderId, action) {
  assert.ok(await page.evaluate(`(() => { const more=document.querySelector('[data-workflow-folder="'+${json(folderId)}+'"] > .workflow-tree-row [data-action="folder-menu"]'); if(!more) return false; more.click(); return true })()`), "folder row menu");
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
const row = (kind, id) => `[data-workflow-tree-node="${kind}:${id}"] > .workflow-tree-row`;
try {
  const seed = new Host(hostBinary, data, { env: { HOME: home }, quiet: true });
  try { await seed.start(); projectId = (await seed.call("project.group.create", { name: "Project navigation", folders: [join(root,"apps")] })).group.id; } finally { await seed.stop(); }
  await startApp();
  const setup = await main.evaluate(`globalThis.__PI_DESKTOP_PLAN_UI_PROBE({operation:'liveSetup',workspace:${json(join(root,"apps"))}})`);
  assert.equal(setup.ok,true,json(setup));
  await page.call("Page.reload");
  await until(() => page.evaluate("!!document.querySelector('.app-shell:not(.is-booting)')"),"renderer reload after Host setup");
  await page.evaluate("document.documentElement.dataset.theme='light'");
  await until(() => page.evaluate(`!!document.querySelector(${json(`[data-project-agent="${projectId}"]`)})`), "project Agent title entry");
  group = await page.evaluate(`document.querySelector(${json(`[data-project-agent="${projectId}"]`)})?.closest('[data-sidebar-project-group]')?.dataset.sidebarProjectGroup`);
  await page.evaluate(`(() => { const group=document.querySelector('[data-sidebar-project-group="'+${json(group)}+'"]'); const toggle=group.querySelector('.project-toggle'); if(toggle.getAttribute('aria-expanded')==='false')toggle.click(); })()`);
  await until(() => page.evaluate(`!!document.querySelector(${json(`[data-workflow-tree="project"][data-project-id="${projectId}"]`)})`), "project conversation tree");
  assert.ok(await page.evaluate(`!!document.querySelector(${json(`.conversation-topbar [data-project-agent="${projectId}"]`)})`),"new task in a project must have the Agent topbar entry");
  assert.ok(await clickText("项目首页") || await clickText("Project home"));
  await until(() => page.evaluate("!!document.querySelector('[data-workflow=console]')"), "project home");
  assert.ok(await page.evaluate(`document.querySelector('[data-sidebar-project-group] .project-toggle')?.textContent.includes('Project navigation')`),"logical project name must replace root basename");
  await capture("project-home-light.png");
  // Project colour: set through the project row menu, then verify the sidebar glyph and console accent in both themes.
  const projectColorRgb = { light: "rgb(196, 54, 93)", dark: "rgb(255, 111, 147)" };
  const colorProbe = () => page.evaluate(`(() => { const g=document.querySelector('[data-sidebar-project-group="'+${json(group)}+'"]'); const glyph=g?.querySelector('.project-toggle > svg:not(.sidebar-disclosure-icon)'); const mark=document.querySelector('.workflow-console .workflow-project-mark'); return { group: g?.dataset.projectColor, console: document.querySelector('.workflow-console')?.dataset.projectColor, glyph: glyph && getComputedStyle(glyph).color, mark: mark && getComputedStyle(mark).color } })()`);
  assert.ok(await page.evaluate(`(() => { const more=document.querySelector('[data-sidebar-project-group="'+${json(group)}+'"] .project-more'); if(!more) return false; more.click(); return true })()`), "project overflow menu");
  await until(() => page.evaluate(`(() => { const el=document.querySelector('.sidebar-row-menu [data-submenu-trigger="project-color"]'); if(!el) return false; el.click(); return true })()`), "Project color submenu trigger");
  await until(() => page.evaluate("!!document.querySelector('.sidebar-submenu [data-action=\"project-color-rose\"]')"), "Project color presets");
  assert.equal(await page.evaluate("document.querySelectorAll('.sidebar-submenu [role=menuitemradio]').length"), 8, "follow theme plus seven presets");
  assert.equal(await page.evaluate("document.querySelector('.sidebar-submenu [data-action=\"project-color-theme\"]').getAttribute('aria-checked')"), "true");
  await capture("project-color-menu-light.png");
  await until(() => page.evaluate(`(() => { const el=document.querySelector('.sidebar-submenu [data-action="project-color-rose"]'); if(!el) return false; el.click(); return true })()`), "choose rose project colour");
  await until(async () => (await colorProbe()).console === "rose", "console carries the project colour");
  let probe = await colorProbe();
  assert.equal(probe.group, "rose"); assert.equal(probe.glyph, projectColorRgb.light, "sidebar glyph tint (light)"); assert.equal(probe.mark, projectColorRgb.light, "console accent (light)");
  await capture("project-color-light.png");
  await page.evaluate("document.documentElement.dataset.theme='dark'");
  await until(async () => (await colorProbe()).mark === projectColorRgb.dark, "console accent follows the dark variant");
  probe = await colorProbe();
  assert.equal(probe.glyph, projectColorRgb.dark, "sidebar glyph tint (dark)");
  await capture("project-color-dark.png");
  await page.evaluate("document.documentElement.dataset.theme='light'");
  const category = await createFolder("projects", "产品开发");
  const nested = await createFolder("projects", "桌面应用", category.id);
  const third = await createFolder("projects", "AI 工作空间", nested.id);
  await mutate("navigation.expand",{expandedIds:[...(await snapshot()).expandedIds,category.id,nested.id,third.id]});
  await until(() => page.evaluate(`!!document.querySelector(${json(row("folder",third.id))})`),"third-level category visible");
  await drag(row("project",projectId),row("folder",third.id));
  await until(async () => (await snapshot()).projectNavigation?.find(item=>item.projectId===projectId)?.folderId===third.id,"project in third-level category");
  // Expand ancestors to expose the categorized project after the move.
  await mutate("navigation.expand",{expandedIds:[...(await snapshot()).expandedIds,category.id,nested.id,third.id]});
  await until(() => page.evaluate(`!!document.querySelector(${json(`[data-workflow-folder="${third.id}"] [data-sidebar-project-group]`)})`),"categorized project is visible");
  const chats = await createFolder("project", "设计与决策");
  const chats2 = await createFolder("project", "交互设计", chats.id);
  const chats3 = await createFolder("project", "导航方案", chats2.id);
  await mutate("navigation.expand",{expandedIds:[...(await snapshot()).expandedIds,chats.id,chats2.id,chats3.id]});
  await until(() => page.evaluate(`!!document.querySelector(${json(row("folder",chats3.id))})`),"deep conversation folder visible");
  // Rename, move and delete go through the row "..." menu and the folder dialog.
  const scratch = await createFolder("project", "临时");
  await folderMenuAction(scratch.id, "rename-folder");
  await until(() => page.evaluate(`!!document.querySelector(${json(dialogSelector + " input")})`), "rename dialog");
  assert.ok(await fillControl(dialogSelector + " input", "临时目录"));
  await capture("folder-rename-dialog-light.png");
  await submitForm(dialogSelector + " form");
  await until(async () => (await snapshot()).folders.find(folder => folder.id === scratch.id)?.name === "临时目录", "renamed folder");
  await until(() => page.evaluate(`!document.querySelector(${json(dialogSelector)})`), "rename dialog closed");
  await folderMenuAction(scratch.id, "move-folder");
  await until(() => page.evaluate(`!!document.querySelector(${json(dialogSelector + " select")})`), "move dialog");
  await page.evaluate(`(() => { const input=document.querySelector(${json(dialogSelector + " select")}); input.value=${json(chats2.id)}; input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await submitForm(dialogSelector + " form");
  await until(async () => (await snapshot()).folders.find(folder => folder.id === scratch.id)?.parentId === chats2.id, "folder moved through the menu dialog");
  await until(() => page.evaluate(`!document.querySelector(${json(dialogSelector)})`), "move dialog closed");
  await page.evaluate(`document.querySelector(${json(`[data-workflow-folder="${chats.id}"] > .workflow-tree-row`)}).scrollIntoView({block:'center'})`);
  await page.evaluate(`document.querySelector(${json(`[data-workflow-folder="${chats.id}"] > .workflow-tree-row [data-action="folder-menu"]`)}).click()`);
  await until(() => page.evaluate("!!document.querySelector('.sidebar-row-menu [data-action=\"rename-folder\"]')"), "folder menu");
  await capture("folder-menu-light.png");
  await page.evaluate("document.documentElement.dataset.theme='dark'");
  await capture("folder-menu-dark.png");
  await page.evaluate("document.documentElement.dataset.theme='light'");
  await page.evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
  await until(() => page.evaluate("!document.querySelector('.sidebar-row-menu')"), "folder menu dismissed");
  await folderMenuAction(scratch.id, "remove-folder");
  assert.ok((await snapshot()).folders.some(folder => folder.id === scratch.id), "first click must only arm removal");
  await page.evaluate(`document.querySelector('.sidebar-row-menu [data-action="remove-folder"]').click()`);
  await until(async () => !(await snapshot()).folders.some(folder => folder.id === scratch.id), "folder removal confirmed by second click");
  await drag(row("session",setup.sessionId),row("folder",chats3.id),.5,"drop-inside-folder.png");
  await until(async () => (await snapshot()).navigation.find(item=>item.sessionId===setup.sessionId)?.folderId===chats3.id,"project conversation placement");
  await drag(row("session",setup.sessionId),row("folder",chats.id),.1,"drop-before-folder.png");
  await until(async () => !(await snapshot()).navigation.find(item=>item.sessionId===setup.sessionId)?.folderId,"project conversation back at root");
  await capture("project-tree-light.png");
  // Title, Home and the console's Agent dock all open the canonical Agent, never a row.
  await until(() => page.evaluate(`(() => { if(document.querySelector(${json(`[data-project-agent-dock] [data-project-agent="${projectId}"]`)})) return true; const toggle=document.querySelector('[data-project-agent-dock-toggle]'); if(toggle && !toggle.disabled && toggle.getAttribute('aria-pressed')!=='true') toggle.click(); return false })()`), "project Agent dock entry");
  await page.evaluate(`document.querySelector(${json(`[data-project-agent-dock] [data-project-agent="${projectId}"]`)}).click()`);
  await until(() => page.evaluate("!!document.querySelector('.workflow-conversation-bar')"),"Agent chat");
  const agent = (await snapshot()).projectAgents.find(item=>item.projectId===projectId);
  assert.ok(agent?.sessionId);
  assert.equal(await page.evaluate(`document.querySelectorAll(${json(`[data-sidebar-session-row="${agent.sessionId}"]`)}).length`),0,"Agent must not have a session row");
  assert.ok(await page.evaluate(`!!document.querySelector(${json(`.conversation-topbar [data-project-agent="${projectId}"]`)})`),"chat topbar Agent entry");
  await page.evaluate(`document.querySelector(${json(`.conversation-topbar [data-project-agent="${projectId}"]`)}).click()`);
  await until(async()=> (await snapshot()).projectAgents.filter(item=>item.projectId===projectId).length===1,"canonical Agent reused");
  await capture("project-agent-chat-light.png");
  await page.evaluate("document.documentElement.dataset.theme='dark'");
  await until(()=>page.evaluate("document.documentElement.dataset.theme==='dark' || document.documentElement.classList.contains('dark')"),"dark theme");
  await capture("project-tree-dark.png");
  await stopApp();await startApp();
  const persisted=await snapshot();
  assert.equal(persisted.projectNavigation.find(item=>item.projectId===projectId).folderId,third.id);
  assert.equal(persisted.projectAgents.find(item=>item.projectId===projectId).sessionId,agent.sessionId);
  await writeFile(join(output,"result.json"),json({ok:true,sourceCommitAtRun,sourceChangesAtRun,builtCommit,hostBuiltCommit,projectId,agentSessionId:agent.sessionId,coverage:["project/Chat shared navigation tree","third-level project category","deep project conversation folder","before/inside drag feedback","navigation-only session move","Agent icon routes and canonical identity","restart persistence"],interaction:"production renderer DOM DragEvent and click handlers; no physical pointer or model calls"}));
  await Promise.all(["failure.txt","failure.png"].map(name => rm(join(output,name),{force:true})));
} catch(error) {
  await writeFile(join(output,"failure.txt"),String(error.stack??error)+"\n"+log.slice(-9000));
  if(page) { try { await capture("failure.png"); } catch {} }
  throw error;
} finally { await stopApp(); }
console.log(`Project navigation UI passed: ${output}`);
