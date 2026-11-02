import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

// Exercise the actual project memory dialog in an isolated Electron/Chromium
// page. Its only boundary substitute is a synthetic Host IPC bridge.
const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const { appDir, electronBinary } = resolveElectronBinary(root);
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { IPC } from "@pi-desktop/shared";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { ProjectMemoryDialog } from "../src/components/ProjectMemoryDialog";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });
const source = { sessionId: "source-session", messageId: "source-message", turnId: "source-turn" };
const now = Date.now();
const item = (id, status, content, updatedAt) => ({
  id, kind: "knowledge", title: id, content, status, source,
  createdAt: updatedAt - 1000, updatedAt,
});
const state = {
  normal: { version: 1, projectId: "normal", revision: 1, entries: [
    item("current-note", "active", "The current project direction", now),
    item("replaced-note", "superseded", "The earlier direction", now - 2000),
    item("forgotten-note", "forgotten", "The forgotten direction", now - 4000),
  ] },
  "legacy-real-id": { version: 1, projectId: "legacy-real-id", revision: 1, entries: [
    item("legacy-note", "active", "Legacy project context", now),
  ] },
  replacement: { version: 1, projectId: "replacement", revision: 4, entries: [] },
};
const held = new Set();
const pendingReads = new Map();
const calls = [];
let failKnowledgeRead = false;
let conflictNextClear = false;
window.__calls = calls;
window.__sources = [];
window.__channels = IPC.invoke;
window.__testErrorReads = (value) => { failKnowledgeRead = value; };
window.__conflictNextClear = () => { conflictNextClear = true; };
window.__resetNotesForScreenshot = () => {
  state.normal = { version: 1, projectId: "normal", revision: state.normal.revision + 1, entries: [
    item("current-note", "active", "The current project direction", Date.now()),
    item("replaced-note", "superseded", "The earlier direction", Date.now() - 2000),
    item("forgotten-note", "forgotten", "The forgotten direction", Date.now() - 4000),
  ] };
};
window.__holdKnowledgeFor = (groupId) => held.add(groupId);
window.__resolveKnowledge = (groupId) => pendingReads.get(groupId)?.(state[groupId] ?? state.normal);
window.__setProjectPathOnly = () => { project = { name: "Legacy continuity", path: "/tmp/pi-memory-ui", legacy: true }; render(); };
window.__setLegacyGroupWithId = () => { project = { name: "Legacy continuity", path: "/tmp/pi-memory-ui", groupId: "legacy-real-id", legacy: true }; render(); };
window.piDesktop = { invoke(channel, payload) {
  calls.push({ channel, payload });
  if (channel === IPC.invoke.projectGroupMemoryGet) return Promise.resolve({ ok: true, data: {
    memory: { entries: [{ id: "human-note", title: "My note", content: "Handwritten project constraint" }] },
  } });
  if (channel === IPC.invoke.projectMemoryGet) return Promise.resolve({ ok: true, data: {
    memory: { entries: [{ id: "human-note", title: "My note", content: "Handwritten project constraint" }] },
  } });
  if (channel === IPC.invoke.projectGroupList) return Promise.resolve({ ok: true, data: {
    groups: [{ id: "legacy-real-id", name: "Legacy continuity", primaryPath: "/tmp/pi-memory-ui",
      roots: [{ path: "/tmp/pi-memory-ui", name: "Legacy continuity", position: 0 }],
      createdAt: 1, updatedAt: 1, pinned: false, lastOpenedAt: 1, legacy: true }],
  } });
  if (channel === IPC.invoke.projectKnowledgeGet) {
    if (failKnowledgeRead) return Promise.resolve({ ok: false, error: { code: "HOST_UNAVAILABLE", message: "Host is offline" } });
    if (held.has(payload.groupId)) return new Promise((resolve) => {
      pendingReads.set(payload.groupId, (data) => resolve({ ok: true, data }));
    });
    return Promise.resolve({ ok: true, data: state[payload.groupId] ?? state.normal });
  }
  if (channel === IPC.invoke.projectKnowledgeForget) {
    const current = state[payload.groupId] ?? state.normal;
    if (payload.expectedRevision !== current.revision) return Promise.resolve({
      ok: false, error: { code: "CONFLICT", message: "Project notes changed. Reload and try again." },
    });
    const next = { ...current, revision: current.revision + 1, entries: current.entries.map((entry) =>
      entry.id === payload.entryId ? { ...entry, status: "forgotten", updatedAt: Date.now() } : entry) };
    state[payload.groupId] = next;
    return Promise.resolve({ ok: true, data: next });
  }
  if (channel === IPC.invoke.projectKnowledgeClearHistory) {
    const current = state[payload.groupId] ?? state.normal;
    if (conflictNextClear || payload.expectedRevision !== current.revision) {
      conflictNextClear = false;
      if (payload.expectedRevision === current.revision) current.revision += 1;
      return Promise.resolve({
      ok: false, error: { code: "CONFLICT", message: "Project notes changed. Reload and try again." },
      });
    }
    const next = { ...current, revision: current.revision + 1, entries: current.entries.filter((entry) => entry.status === "active") };
    state[payload.groupId] = next;
    return Promise.resolve({ ok: true, data: next });
  }
  throw new Error("Unexpected synthetic IPC " + channel);
} };
const mount = document.getElementById("root");
const root = createRoot(mount);
let project = { name: "Continuity", path: "/tmp/pi-memory-ui", groupId: "normal" };
const render = () => flushSync(() => root.render(React.createElement(ProjectMemoryDialog, {
  project,
  onClose() {},
  onSaved() {},
  onError(error) { window.__dialogError = String(error); },
  onOpenSource(sessionId, messageId) { window.__sources.push({ sessionId, messageId }); },
})));
window.__setProjectGroup = (groupId) => { project = { name: "Continuity", path: "/tmp/pi-memory-ui", groupId, legacy: false }; render(); };
render();
window.__renderReady = true;
`;

function nextFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function connectRenderer(port) {
  const deadline = Date.now() + 10_000;
  let target;
  while (!target && Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
    if (response?.ok) {
      const targets = await response.json();
      target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
    }
    if (!target) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!target) throw new Error("Isolated Electron renderer did not start");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, "open");
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const reply = JSON.parse(String(data));
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    if (reply.error) waiter.reject(new Error(`${waiter.method}: ${reply.error.message}${waiter.expression ? ` (${waiter.expression.slice(0, 100)})` : ""}`));
    else waiter.resolve(reply.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject, method, expression: params.expression });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  return {
    async run(expression) {
      const result = await call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result?.value;
    },
    async until(expression, label) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (await this.run(`Boolean(${expression})`)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out waiting for ${label}`);
    },
    async click(selector) {
      const box = await this.run(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return null; node.scrollIntoView({ block: 'nearest' }); const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (!box) throw new Error(`No visible UI target for ${selector}`);
      await call("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
    },
    async screenshot() {
      return (await call("Page.captureScreenshot", { format: "png" })).data;
    },
    close() { socket.close(); },
  };
}

test("project memory keeps user notes separate and supports sourced agent notes, history, forget and retry", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-project-knowledge-ui-"));
  const bundle = join(temp, "fixture.js");
  const sharedStub = join(temp, "shared.js");
  await writeFile(sharedStub, `export const IPC={invoke:{projectGroupList:'project.group.list',projectGroupMemoryGet:'project.group.memory.get',projectGroupMemorySave:'project.group.memory.save',projectMemoryGet:'project.memory.get',projectMemorySave:'project.memory.save',projectKnowledgeGet:'project.knowledge.get',projectKnowledgeForget:'project.knowledge.forget',projectKnowledgeClearHistory:'project.knowledge.clearHistory'}};
export const defaultCommandShellForPlatform=()=>"bash", isCommandShellId=()=>true, normalizeLargePasteThreshold=(value)=>value,
normalizeMode=(value)=>value, normalizeNetworkProxy=(value)=>value, normalizeNetworkPolicy=(value)=>value,
normalizeRadialMenuPreferences=(value)=>value, radialMenuWriteError=()=>null,
resolveFontScale=(value)=>value.fontScale, normalizeChatContentMaxWidth=(value)=>value,
validateNetworkPolicy=(value)=>({ok:true,value}), validateNetworkProxy=(value)=>({ok:true,value}), validateSpeechSettings=(value)=>value,
JEV_API_KEY_SECRET_REF="fixture";\n`);
  await build({
    stdin: { contents: fixture, resolveDir: join(root, "apps/desktop/test"), loader: "tsx" },
    bundle: true,
    outfile: bundle,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    alias: {
      "@pi-desktop/shared": sharedStub,
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
    },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const mainFile = join(temp, "main.cjs");
  const htmlFile = join(temp, "index.html");
  await writeFile(mainFile, `const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => { const window = new BrowserWindow({ width: 960, height: 760, show: false,
  webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.setMenuBarVisibility(false); window.loadFile(${JSON.stringify(htmlFile)}); });
app.on("window-all-closed", () => app.quit());\n`);
  const stylePaths = ["tokens.css", "base.css", "ui-kit.css", "overlays.css", "settings.css", "providers.css"];
  const styleLinks = stylePaths.map((name) => `<link rel="stylesheet" href="${pathToFileURL(join(appDir, "src/styles", name)).href}">`).join("");
  await writeFile(htmlFile, `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">${styleLinks}
<style>html,body,#root{height:100%;margin:0}body{font-family:Inter,system-ui,sans-serif}.project-instructions-dialog{max-height:calc(100vh - 48px);overflow:auto}</style></head>
<body><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`);
  const port = await nextFreePort();
  const child = spawn(electronBinary, [mainFile, `--remote-debugging-port=${port}`, `--user-data-dir=${join(temp, "profile")}`, "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check"], {
    cwd: root,
    stdio: "ignore",
    env: { ...globalThis.process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  const renderer = await connectRenderer(port);
  const screenshotPath = join(tmpdir(), `project-knowledge-dialog-${process.pid}.png`);
  t.after(async () => {
    renderer.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      const timeout = new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        timer.unref();
      });
      await Promise.race([once(child, "exit"), timeout]);
    }
    await rm(temp, { recursive: true, force: true });
  });

  await renderer.until("window.__renderReady && document.querySelector('.project-knowledge-card')", "Agent notes");
  assert.equal(await renderer.run("document.querySelector('.project-memory-entry-content').value"), "Handwritten project constraint");
  assert.equal(await renderer.run("document.body.innerText.includes('The current project direction') && document.body.innerText.includes('Agent notes')"), true);
  assert.equal(await renderer.run("document.body.innerText.includes('The earlier direction')"), false);
  await renderer.run("window.__setProjectPathOnly()");
  await renderer.until("document.body.innerText.includes('Legacy project context')", "legacy path project notes");
  const legacyLookupCount = await renderer.run("window.__calls.filter(({channel}) => channel === window.__channels.projectKnowledgeGet).length");
  assert.equal(await renderer.run("window.__calls.findLast(({channel}) => channel === window.__channels.projectKnowledgeGet).payload.groupId"), "legacy-real-id");
  await renderer.run("window.__setLegacyGroupWithId()");
  await renderer.until("document.body.innerText.includes('Legacy project context')", "legacy group id notes");
  assert.equal(await renderer.run("window.__calls.filter(({channel}) => channel === window.__channels.projectGroupList).length"), 1);
  assert.equal(await renderer.run("window.__calls.filter(({channel}) => channel === window.__channels.projectKnowledgeGet).length"), legacyLookupCount + 1);
  await renderer.run("window.__setProjectGroup('normal')");
  await renderer.until("document.body.innerText.includes('The current project direction')", "return to selected project");

  await renderer.click(".project-knowledge-heading-actions button");
  await renderer.until("document.body.innerText.includes('The earlier direction') && document.body.innerText.includes('The forgotten direction')", "note history");
  await renderer.click(".project-knowledge-actions button");
  assert.deepEqual(await renderer.run("window.__sources[0]"), { sessionId: "source-session", messageId: "source-message" });
  await renderer.click(".project-knowledge-heading-actions button:first-child");
  await renderer.until("document.body.innerText.includes('Clear replaced and forgotten Agent notes?') && document.body.innerText.includes('original conversations will stay')", "history clear confirmation");
  await renderer.click(".project-knowledge-clear-confirm button:first-child");
  assert.equal(await renderer.run("document.body.innerText.includes('The earlier direction')"), true);
  await renderer.click(".project-knowledge-heading-actions button:first-child");
  await renderer.run("window.__conflictNextClear()");
  await renderer.click(".project-knowledge-clear-confirm button:last-child");
  const conflictFeedback = await renderer.run("document.querySelector('[role=alert]')?.innerText ?? document.body.innerText");
  assert.match(conflictFeedback, /Could not update notes.*Project notes changed/s);
  await renderer.click(".project-knowledge-error button");
  await renderer.until("document.body.innerText.includes('The earlier direction')", "reload after history conflict");
  await renderer.click(".project-knowledge-heading-actions button:first-child");
  await renderer.click(".project-knowledge-clear-confirm button:last-child");
  await renderer.until("document.body.innerText.includes('The current project direction') && !document.body.innerText.includes('The earlier direction') && !document.body.innerText.includes('The forgotten direction')", "clear history result");
  assert.equal(await renderer.run("document.querySelector('.project-memory-entry-content').value"), "Handwritten project constraint");
  assert.equal(await renderer.run("window.__calls.filter(({channel}) => channel === window.__channels.projectKnowledgeClearHistory).length"), 2);
  await renderer.click(".project-knowledge-card button:last-child");
  await renderer.until("document.querySelector('.project-knowledge-card .is-forgotten') && document.body.innerText.includes('The current project direction')", "forgotten history record");
  await renderer.click(".project-knowledge-heading-actions button:last-child");
  await renderer.until("document.body.innerText.includes('No Agent notes yet')", "empty current notes after forget");

  await renderer.run("window.__testErrorReads(true); window.__setProjectGroup('replacement')");
  await renderer.until("document.querySelector('[role=alert]')?.innerText.includes('Host is offline')", "Host read error");
  await renderer.run("window.__testErrorReads(false)");
  await renderer.click(".project-knowledge-error button");
  await renderer.until("document.querySelector('.project-knowledge-state')?.innerText.includes('No Agent notes yet')", "retry result");

  await renderer.run("window.__holdKnowledgeFor('slow')");
  await renderer.run("window.__setProjectGroup('slow')");
  await renderer.run("window.__setProjectGroup('replacement')");
  await renderer.until("document.querySelector('.project-knowledge-state')?.innerText.includes('No Agent notes yet')", "new project notes");
  await renderer.run("window.__resolveKnowledge('slow')");
  assert.equal(await renderer.run("document.body.innerText.includes('The current project direction')"), false);

  await renderer.run("window.__resetNotesForScreenshot(); window.__setProjectGroup('normal')");
  await renderer.until("document.querySelector('.project-knowledge-card')", "screenshot content");
  await renderer.click(".project-knowledge-heading-actions button");
  const screenshot = await renderer.screenshot();
  await writeFile(screenshotPath, Buffer.from(screenshot, "base64"));
  t.diagnostic(`Isolated Electron render: ${await renderer.run("Math.round(document.querySelector('.project-memory-dialog').getBoundingClientRect().width) + 'px wide'")}; screenshot ${screenshotPath}`);
});
