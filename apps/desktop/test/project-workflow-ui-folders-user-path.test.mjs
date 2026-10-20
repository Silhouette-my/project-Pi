import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";
const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { emptyProjectWorkflowSnapshot } from "@pi-desktop/shared";
import { ProjectWorkflowProvider } from "../../apps/desktop/src/features/project-workflow/useProjectWorkflow";
import { WorkflowNavigation } from "../../apps/desktop/src/features/project-workflow/WorkflowNavigation";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false, interpolation: { escapeValue: false } });
window.piDesktop = { platform: "darwin", on() { return () => {}; }, invoke() { throw Error("Unexpected IPC"); } };
let snapshot = emptyProjectWorkflowSnapshot();
snapshot.folders = [{id:"folder",name:"Research",order:0}];
snapshot.expandedIds = ["folder"];
snapshot.navigation = [{sessionId:"chat",folderId:"folder",order:0,favorite:false}];
const calls = [];
api.projectWorkflow.snapshot = async () => structuredClone(snapshot);
api.projectWorkflow.onChanged = () => () => {};
api.projectWorkflow.mutate = async (command) => {
  calls.push(command);
  if (command.expectedRevision !== snapshot.revision) throw Error("Revision conflict");
  if (command.kind === "folder.create") snapshot.folders.push(command.folder);
  if (command.kind === "folder.update") snapshot.folders = snapshot.folders.map(f => f.id === command.folder.id ? command.folder : f);
  if (command.kind === "folder.remove") {
    snapshot.folders = snapshot.folders.filter(f => f.id !== command.folderId);
    snapshot.navigation = snapshot.navigation.map(n => n.folderId === command.folderId ? {...n,folderId:undefined}:n);
  }
  if (command.kind === "navigation.expand") snapshot.expandedIds = command.expandedIds;
  if (command.kind === "navigation.move") {
    for (const sessionId of command.sessionIds) {
      const old = snapshot.navigation.find(n => n.sessionId === sessionId);
      snapshot.navigation = [...snapshot.navigation.filter(n => n.sessionId !== sessionId), {...old,sessionId,folderId:command.folderId,order:old?.order??0,favorite:old?.favorite??false}];
    }
  }
  if (command.kind === "navigation.update") snapshot.navigation = [...snapshot.navigation.filter(n => n.sessionId !== command.navigation.sessionId), command.navigation];
  snapshot.revision++;
  return {snapshot:structuredClone(snapshot),replayed:false};
};
let nextCreated = "chat";
useAppStore.setState({newSession: async () => nextCreated});
const sessions = [{id:"chat",title:"Existing chat",createdAt:"2026-10-01",updatedAt:"2026-10-01",projectPath:null},{id:"other",title:"Another chat",createdAt:"2026-10-02",updatedAt:"2026-10-02",projectPath:null}];
const rootNode = createRoot(document.getElementById("root"));
flushSync(() => rootNode.render(<ProjectWorkflowProvider><WorkflowNavigation sessions={sessions} renderSessions={items => items.map(s => <button key={s.id} className="thread-item-main">{s.title}</button>)} /></ProjectWorkflowProvider>));
const frame = () => new Promise(requestAnimationFrame);
async function until(check, message) { for(let n=0;n<120;n++) { if(check()) return; await frame(); } throw Error(message + document.body.textContent); }
function click(label, scope=document) { const element=[...scope.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")===label || b.textContent.trim()===label); if(!element) throw Error("No button "+label); flushSync(()=>element.click()); }
function setInput(input,value) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,value); flushSync(()=>input.dispatchEvent(new Event("input",{bubbles:true}))); }
window.folderProbe = async () => {
 await until(()=>document.querySelector('[data-workflow-folder="folder"]'),"folder missing");
 click("workflowNav.organize"); click("workflowNav.editFolder",document.querySelector('[data-workflow-folder="folder"]'));
 setInput(document.querySelector("form input"),"Renamed research");
 flushSync(()=>document.querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 await until(()=>snapshot.folders[0].name==="Renamed research","rename missing");
 await until(()=>!document.querySelector("form"),"editor not dismissed");
 click("workflowNav.newFolder"); setInput(document.querySelector("form input"),"Must not be saved");
 const cancelCount=calls.length; click("common.cancel",document.querySelector("form")); await frame();
 if(calls.length!==cancelCount||snapshot.folders.length!==1) throw Error("Cancel submitted a folder mutation");
 click("workflowNav.newFolder"); setInput(document.querySelector("form input"),"Second");
 flushSync(()=>document.querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 await until(()=>snapshot.folders.length===2,"create missing");
 await until(()=>!document.querySelector("form"),"editor not dismissed");
 click("workflowNav.newChat",document.querySelector('[data-workflow-folder="folder"]'));
 await until(()=>calls.some(c=>c.kind==="navigation.move"&&c.folderId==="folder"),"folder chat inheritance missing");
 const before=calls.length; nextCreated=undefined;
 click("workflowNav.newChat",document.querySelector('[data-workflow-folder="folder"]'));
 await frame(); await frame();
 if(calls.length!==before) throw Error("Superseded creation moved an unrelated chat");
 nextCreated="chat"; click("workflowNav.newChat");
 await until(()=>snapshot.navigation.find(n=>n.sessionId==="chat").folderId===undefined,"global chat not unfiled");
 await until(()=>document.querySelectorAll('input[type="checkbox"]').length===2,"chat selection missing");
 flushSync(()=>{for(const checkbox of document.querySelectorAll('input[type="checkbox"]')) checkbox.click();});
 await until(()=>document.querySelector("select"),"bulk move missing");
 const destination=document.querySelector("select");
 flushSync(()=>{destination.value="folder";destination.dispatchEvent(new Event("change",{bubbles:true}));});
 click("workflowNav.move");
 await until(()=>snapshot.navigation.filter(n=>n.folderId==="folder").length===2,"bulk move did not preserve both chats");
 click("workflowNav.removeFolder",document.querySelector('[data-workflow-folder="folder"]'));
 click("workflowNav.removeFolder",document.querySelector('[role="alert"]'));
 await until(()=>snapshot.folders.length===1,"remove missing");
 if(!document.body.textContent.includes("Existing chat")) throw Error("Folder deletion lost historical chat");
 if(!document.body.textContent.includes("Another chat")) throw Error("Bulk moved chat disappeared after folder removal");
 flushSync(()=>rootNode.unmount());
 return {passed:true};
};
`;
test("folders rename/create, inherit new chat, ignore superseded creation, and remove non-destructively", {
  skip:
    process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-workflow-folders-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
      loader: { ".css": "empty" },
    });
    await writeFile(
      join(temp, "index.html"),
      '<!doctype html><div id="root"></div><script type="module" src="renderer.js"></script>',
    );
    await writeFile(
      join(temp, "main.cjs"),
      `const {app,BrowserWindow}=require("electron");const path=require("node:path");app.setPath("userData",path.join(__dirname,"profile"));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});try{await win.loadFile(path.join(__dirname,"index.html"));console.log("FOLDERS_PROBE "+JSON.stringify(await win.webContents.executeJavaScript("window.folderProbe()")));app.exit(0)}catch(e){console.error(e.stack);app.exit(1)}});`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      process.env.PI_DESKTOP_ELECTRON_BIN ?? resolveElectronBinary(root).electronBinary,
      [join(temp, "main.cjs")],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => (output += chunk));
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output.slice(-6000));
    assert.match(output, /FOLDERS_PROBE {"passed":true}/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
