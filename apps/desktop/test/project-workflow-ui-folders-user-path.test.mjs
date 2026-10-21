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
import { useWorkflowSessionMenu } from "../../apps/desktop/src/features/project-workflow/session-menu";
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
  if (command.kind === "tree.move") {
    function place(target,order) {
      if(target.kind==="folder"){const row=snapshot.folders.find(f=>f.id===target.id);row.parentId=command.folderId;row.order=order;}
      else {let row=snapshot.navigation.find(n=>n.sessionId===target.id);if(!row){row={sessionId:target.id,favorite:false};snapshot.navigation.push(row);}row.folderId=command.folderId;row.order=order;}
    }
    place(command.target,command.order);command.siblingOrder?.forEach(place);
  }
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
// Sidebar owns the session row menu; the harness exposes the same workflow rows as buttons.
function SessionRow({ session }) {
  const menu = useWorkflowSessionMenu([]);
  return <>
    <button className="thread-item-main">{session.title}</button>
    {menu.sessionItems(session, () => {}).map(item => <button key={item.id} data-action={item.id} onClick={item.onSelect}>{item.label}</button>)}
  </>;
}
function BulkMove() {
  const menu = useWorkflowSessionMenu([]);
  return <>{menu.batchItems(sessions, () => {}).map(item => <button key={item.id} data-bulk={item.id} onClick={item.onSelect}>{item.label}</button>)}</>;
}
flushSync(() => rootNode.render(<ProjectWorkflowProvider><WorkflowNavigation sessions={sessions} renderSessions={items => items.map(s => <SessionRow key={s.id} session={s} />)} /><BulkMove /></ProjectWorkflowProvider>));
const frame = () => new Promise(requestAnimationFrame);
async function drag(source,target,where=.5) {
 const sourceKey=source.parentElement.dataset.workflowTreeNode;
 await until(()=>{source=document.querySelector('[data-workflow-tree-node="'+sourceKey+'"] > .workflow-tree-row');return source?.draggable;},"Source remains busy");
 const dataTransfer=new DataTransfer();flushSync(()=>source.dispatchEvent(new DragEvent("dragstart",{bubbles:true,cancelable:true,dataTransfer})));await frame();const rect=target.getBoundingClientRect();
 flushSync(()=>target.dispatchEvent(new DragEvent("dragover",{bubbles:true,cancelable:true,dataTransfer,clientY:rect.top+rect.height*where})));await frame();
 flushSync(()=>target.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer,clientY:rect.top+rect.height*where})));await frame();
}
async function until(check, message) { for(let n=0;n<120;n++) { if(check()) return; await frame(); } throw Error(message + document.body.textContent); }
function click(label, scope=document) { const element=[...scope.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")===label || b.textContent.trim()===label); if(!element) throw Error("No button "+label); flushSync(()=>element.click()); }
function setInput(input,value) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,value); flushSync(()=>input.dispatchEvent(new Event("input",{bubbles:true}))); }
 window.folderProbe = async () => {
 await until(()=>document.querySelector('[data-workflow-folder="folder"]'),"folder missing");
 if(document.querySelector('[aria-label="workflowNav.organize"],.workflow-navigation-editor,input[type="checkbox"]')) throw Error("Organize mode controls must not exist");
 const dialog=()=>document.querySelector('[data-workflow="folder-dialog"]');
 const menuItem=(action)=>document.querySelector('.sidebar-row-menu [data-action="'+action+'"]');
 const folderMenu=(id,action)=>{ flushSync(()=>document.querySelector('[data-workflow-folder="'+id+'"] [data-action="folder-menu"]').click()); const item=menuItem(action); if(!item) throw Error("No folder menu item "+action); flushSync(()=>item.click()); };
 folderMenu("folder","rename-folder");
 await until(dialog,"rename dialog missing");
 setInput(dialog().querySelector("input"),"Renamed research");
 flushSync(()=>dialog().querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 await until(()=>snapshot.folders[0].name==="Renamed research","rename missing");
 await until(()=>!dialog(),"dialog not dismissed");
 click("workflowNav.newFolder"); await until(dialog,"create dialog missing"); setInput(dialog().querySelector("input"),"Must not be saved");
 const cancelCount=calls.length; click("common.cancel",dialog().querySelector("form")); await frame();
 if(calls.length!==cancelCount||snapshot.folders.length!==1||dialog()) throw Error("Cancel submitted a folder mutation");
 click("workflowNav.newFolder"); await until(dialog,"create dialog missing"); setInput(dialog().querySelector("input"),"Second");
 flushSync(()=>dialog().querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 await until(()=>snapshot.folders.length===2,"create missing");
 await until(()=>!dialog(),"dialog not dismissed");
 click("workflowNav.newChat",document.querySelector('[data-workflow-folder="folder"]'));
 await until(()=>calls.some(c=>c.kind==="navigation.move"&&c.folderId==="folder"),"folder chat inheritance missing");
 const before=calls.length; nextCreated=undefined;
 click("workflowNav.newChat",document.querySelector('[data-workflow-folder="folder"]'));
 await frame(); await frame();
 if(calls.length!==before) throw Error("Superseded creation moved an unrelated chat");
 nextCreated="chat"; click("workflowNav.newChat");
 await until(()=>snapshot.navigation.find(n=>n.sessionId==="chat").folderId===undefined,"global chat not unfiled");
 // Bulk move through the multi-select menu and the Move dialog (keyboard-reachable select).
 await until(()=>document.querySelector('[data-bulk="batch-move-to-folder"]'),"bulk move item missing");
 flushSync(()=>document.querySelector('[data-bulk="batch-move-to-folder"]').click());
 await until(dialog,"move dialog missing");
 const destination=dialog().querySelector("select");
 if(!destination) throw Error("Move dialog has no Location select");
 flushSync(()=>{destination.value="folder";destination.dispatchEvent(new Event("change",{bubbles:true}));});
 flushSync(()=>dialog().querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 await until(()=>snapshot.navigation.filter(n=>n.folderId==="folder").length===2,"bulk move did not preserve both chats");
 await until(()=>!dialog(),"move dialog not dismissed");
 const row=(kind,id)=>document.querySelector('[data-workflow-tree-node="'+kind+':'+id+'"] > .workflow-tree-row');
 const second=snapshot.folders.find(f=>f.name==="Second");
 await drag(row("session","chat"),row("folder",second.id),.1);
 await until(()=>snapshot.navigation.find(n=>n.sessionId==="chat").folderId===undefined,"Chat could not return to root");
 await until(()=>row("session","chat")?.draggable,"Root chat ready");
 flushSync(()=>row("session","chat").querySelector(".thread-item-main").click());
 await until(()=>snapshot.navigation.find(n=>n.sessionId==="chat")?.lastAccessedAt,"Chat did not enter Recent");
 await until(()=>row("session","chat")?.draggable,"Recent shortcut ready");
 const favorite=row("session","chat").querySelector('[data-action="toggle-session-favorite"]');flushSync(()=>favorite.click());
 await until(()=>snapshot.navigation.find(n=>n.sessionId==="chat")?.favorite,"Chat did not enter Favorites");
 await drag(row("session","chat"),row("folder","folder"));
 await until(()=>snapshot.navigation.find(n=>n.sessionId==="chat").folderId==="folder","Chat could not re-enter folder");
 // Move a single chat with the session row menu item, then a folder into another folder.
 flushSync(()=>document.querySelector('[data-workflow-tree-node="session:other"] [data-action="move-session-to-folder"]').click());
 await until(dialog,"session move dialog missing");
 flushSync(()=>{const select=dialog().querySelector("select");select.value=second.id;select.dispatchEvent(new Event("change",{bubbles:true}));});
 flushSync(()=>dialog().querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 await until(()=>snapshot.navigation.find(n=>n.sessionId==="other").folderId===second.id,"single session move missing");
 await until(()=>!dialog(),"session move dialog not dismissed");
 folderMenu(second.id,"move-folder");
 await until(dialog,"folder move dialog missing");
 flushSync(()=>{const select=dialog().querySelector("select");select.value="folder";select.dispatchEvent(new Event("change",{bubbles:true}));});
 flushSync(()=>dialog().querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 await until(()=>snapshot.folders.find(f=>f.id===second.id).parentId==="folder","folder move missing");
 await until(()=>!dialog(),"folder move dialog not dismissed");
 flushSync(()=>document.querySelector('[data-workflow-folder="'+second.id+'"] [data-action="folder-menu"]').click());
 flushSync(()=>menuItem("remove-folder").click());
 if(!document.querySelector('.sidebar-row-menu [data-sidebar-menu-note="remove-hint"]')) throw Error("Removal must ask for a second confirming click");
 if(snapshot.folders.length!==2) throw Error("First click removed the folder");
 flushSync(()=>menuItem("remove-folder").click());
 await until(()=>snapshot.folders.length===1,"remove missing");
 if(!document.body.textContent.includes("Existing chat")) throw Error("Folder deletion lost historical chat");
 if(!document.body.textContent.includes("Another chat")) throw Error("Moved chat disappeared after folder removal");
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
