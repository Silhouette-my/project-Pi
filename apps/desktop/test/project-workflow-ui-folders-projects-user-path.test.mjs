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
import {createRoot} from "react-dom/client";
import {flushSync} from "react-dom";
import i18n from "i18next";
import {initReactI18next} from "react-i18next";
import {catalogs,flattenCatalog} from "@pi-desktop/i18n";
import {IPC,emptyProjectWorkflowSnapshot,isProjectWorkflowUserCommand} from "@pi-desktop/shared";
import {Sidebar} from "../../apps/desktop/src/components/Sidebar";
import {ProjectWorkflowProvider} from "../../apps/desktop/src/features/project-workflow/useProjectWorkflow";
import {useAppStore} from "../../apps/desktop/src/stores/app-store";
await i18n.use(initReactI18next).init({lng:"en",keySeparator:false,resources:{en:{translation:flattenCatalog(catalogs.en)}},interpolation:{escapeValue:false}});
let snapshot=emptyProjectWorkflowSnapshot();
snapshot.expandedIds=["work-1","cat-a","cat-b","cat-c","pf-a","pf-b","pf-c"];
snapshot.folders=[...[["cat-a",undefined],["cat-b","cat-a"],["cat-c","cat-b"]].map(([id,parentId])=>({id,parentId,name:id,scope:"projects",order:0})),...[["pf-a",undefined],["pf-b","pf-a"],["pf-c","pf-b"]].map(([id,parentId])=>({id,parentId,name:id,scope:"project",projectId:"visible-group",order:0}))];
snapshot.projectNavigation=[{projectId:"visible-group",folderId:"cat-c",order:0}];
snapshot.workstreams=[{id:"work-1",projectId:"visible-group",title:"Durable work line",goal:"Retain execution context",owner:{kind:"user",ref:"owner"},status:"ready",priority:0,order:0,dependencyIds:[],acceptance:[],nextAction:"Continue",mainSessionId:"main",revision:0,decisionRevision:0,createdAt:"2026-10-20",updatedAt:"2026-10-20"}];
snapshot.conversations=[{sessionId:"side",projectId:"visible-group",workstreamId:"work-1",parentSessionId:"main",sourceRevision:0,relation:"child",purpose:"ask",visibility:"project",readContext:{resourceIds:[],includeDecisions:false,includeArtifacts:false},returnPolicy:"none",archived:false,order:0}];
snapshot.conversations.push(...["completed-side","archived-side","unknown-side"].map((sessionId,index)=>({...snapshot.conversations[0],sessionId,purpose:sessionId==="archived-side"?"ask":"work",order:index+1})));
snapshot.runs=["completed-side","unknown-side"].map(sessionId=>({id:"run-"+sessionId,projectId:"visible-group",workstreamId:"work-1",sessionId,executor:"worker",workstreamRevision:0,decisionRevision:0,authorizationId:"grant",state:"completed",outcome:"Finished",effects:sessionId==="unknown-side"?[{id:"effect",action:"check",resource:"/visible",state:"unknown",detail:"No receipt"}]:[],startedAt:"2026-10-20",updatedAt:"2026-10-20"}));
const groups=[{id:"visible-group",name:"Visible retained project",primaryPath:"/visible",roots:[{path:"/visible"}]},{id:"closed-group",name:"Closed must stay closed",primaryPath:"/closed",roots:[]},{id:"archived-group",name:"Archived must stay archived",primaryPath:"/archived",roots:[]}];
window.piDesktop={platform:"darwin",on(){return()=>{};},async invoke(channel,input){
 if(channel===IPC.invoke.projectGroupList)return{ok:true,data:{groups}};
 if(channel===IPC.invoke.projectWorkflowSnapshot)return{ok:true,data:structuredClone(snapshot)};
 if(channel===IPC.invoke.projectWorkflowMutate){
  if(!isProjectWorkflowUserCommand(input))throw Error("Invalid mutation");
  if(input.kind==="navigation.expand")snapshot.expandedIds=input.expandedIds;
  else if(input.kind==="tree.move") {
    function place(target,order){
      if(target.kind==="folder"){const row=snapshot.folders.find(f=>f.id===target.id);row.parentId=input.folderId;row.order=order;if(input.scope!=="project")row.categoryId=input.categoryId;}
      else {const key=target.kind==="project"?"projectNavigation":"navigation",idKey=target.kind==="project"?"projectId":"sessionId";let row=snapshot[key].find(n=>n[idKey]===target.id);if(!row){row={[idKey]:target.id,favorite:false};snapshot[key].push(row);}row.folderId=input.folderId;row.order=order;if(input.scope!=="project"){if(input.folderId)delete row.categoryId;else row.categoryId=input.categoryId;}}
    }
    place(input.target,input.order);input.siblingOrder?.forEach(place);
  } else throw Error("Unexpected mutation "+input.kind);
  snapshot.revision++;return{ok:true,data:{snapshot:structuredClone(snapshot),replayed:false}};
 }
 if(channel===IPC.invoke.updatesGetState)return{ok:true,data:{status:"idle"}};
 if(channel===IPC.invoke.worktreeBehindAll)return{ok:true,data:{counts:{},statusesChanged:false}};
 throw Error("Unexpected IPC "+channel);
}};
const sessions=["main","side","legacy","completed-side","archived-side","unknown-side"].map((id,index)=>({id,title:id+" conversation",projectPath:["main","side"].includes(id)?null:"/visible",createdAt:"2026-10-01",updatedAt:"2026-10-0"+(index+1),messageCount:3}));
useAppStore.setState({page:"chat",activeSessionId:null,sessions,openProjectPaths:["/visible","/archived"],openProjects:[{path:"/visible",name:"Visible retained project"},{path:"/archived",name:"Archived must stay archived"}],activeProjectPath:"/visible",workspace:null,projectSort:"manual",projectMeta:{"/visible":{name:"Visible retained project",pinned:true,order:0,collapsed:false},"/archived":{archived:true,order:1}},sessionMeta:{"archived-side":{archived:true}},projectCollapsed:{},sessionView:{archived:false,sort:"recent"}});
const rootNode=createRoot(document.getElementById("root"));
flushSync(()=>rootNode.render(<ProjectWorkflowProvider><Sidebar onToggleSidebar={()=>{}} sidebarToggleShortcut="" sidebarWidth={300} onWidthChange={()=>{}} onWidthCommit={()=>{}} onResizeCollapse={()=>{}}/></ProjectWorkflowProvider>));
const frame=()=>new Promise(requestAnimationFrame);
async function drag(source,target,where=.5) {
 const dataTransfer=new DataTransfer();
 flushSync(()=>source.dispatchEvent(new DragEvent("dragstart",{bubbles:true,cancelable:true,dataTransfer})));
 await frame(); const rect=target.getBoundingClientRect();
 flushSync(()=>target.dispatchEvent(new DragEvent("dragover",{bubbles:true,cancelable:true,dataTransfer,clientY:rect.top+rect.height*where})));
 await frame();
 flushSync(()=>target.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer,clientY:rect.top+rect.height*where})));
 await frame();
}
async function until(check,message){for(let n=0;n<150;n++){if(check())return;await frame();}throw Error(message+document.body.textContent);}
function check(value,message){if(!value)throw Error(message);}
window.projectNavigationProbe=async()=>{
 await until(()=>document.querySelector('[data-workflow-tree="project"]'),"Project conversation tree missing");
 check(document.querySelectorAll('[data-sidebar-project-group]').length===1,"Durable and legacy project rows duplicated, or closed/archived project returned");
 check(!document.body.textContent.includes("Closed must stay closed")&&!document.body.textContent.includes("Archived must stay archived"),"Host catalog overrode visible metadata");
 const group=document.querySelector('[data-sidebar-project-group="/visible"]');
 check(group.querySelector('button.sidebar-project-cube'),"Project cube (opens project home) is missing");
 check(group.querySelector('[data-sidebar-session-row="legacy"]'),"Unfiled history is not directly reachable");
 check(!group.querySelector('[data-workflow-legacy]'),"Fixed history wrapper still exists");
 check(group.querySelectorAll('[data-sidebar-session-row="side"]').length===1,"Explicit child duplicated or missing");
 check(group.querySelector('[data-sidebar-session-row="main"]'),"Workstream main conversation is unreachable");
 check(group.querySelector('[data-sidebar-session-row="completed-side"]'),"Completed execution transcript is unreachable");
 check(!group.querySelector('[data-sidebar-session-row="archived-side"]'),"Archive filter was bypassed");
 check(group.querySelector('[data-sidebar-session-row="unknown-side"]'),"Unknown-effect transcript is unreachable");
 const agentAction=group.querySelector('[data-action="project-agent"]');
 check(agentAction,"Project row lacks the Project Agent hover action: "+group.querySelector(".workflow-tree-actions")?.innerHTML);check(agentAction.getAttribute("aria-label"),"Agent action has no accessible name");
 const rowActions=[...group.querySelectorAll('.sidebar-project-row .workflow-tree-actions button')];
 check(rowActions.at(-2)===agentAction,"The Agent action must sit right before the more menu");
 check(![...group.querySelectorAll("button")].some(button=>button.textContent==="Project home"),"The Project home row is gone: the cube opens it");
 flushSync(()=>group.querySelector('button.project-toggle').click());
	 check(group.querySelector('button.project-toggle').getAttribute("aria-expanded")==="false","Project title did not collapse its children");
	 check(useAppStore.getState().page==="chat","Collapsing a project unexpectedly navigated away");
	 flushSync(()=>group.querySelector('button.project-toggle').click());
	 check(group.querySelector('button.project-toggle').getAttribute("aria-expanded")==="true","Project title did not expand its children");
	 flushSync(()=>group.querySelector('button.sidebar-project-cube').click());
	 check(group.querySelector('button.sidebar-project-cube').classList.contains("is-active"),"Cube is not the active tile on project home");
	 check(!group.querySelector(".sidebar-project-row").classList.contains("active"),"Project row must not be highlighted as a whole");
	 check(useAppStore.getState().page==="project"&&useAppStore.getState().projectConsoleId==="visible-group","Project home did not open independent Console");
 await until(()=>group.querySelector('[data-sidebar-session-row="legacy"]'),"Legacy conversation no longer reachable");
 check(group.querySelector('[data-sidebar-session-row="legacy"] [data-action="session-menu"]'),"Existing session actions were replaced");
 const before=[...document.querySelectorAll('[data-sidebar-project-group]')].map(row=>row.dataset.sidebarProjectGroup);
 flushSync(()=>useAppStore.setState({sessions:sessions.map(session=>({...session,updatedAt:"2027-01-01"}))}));
 check(JSON.stringify(before)===JSON.stringify([...document.querySelectorAll('[data-sidebar-project-group]')].map(row=>row.dataset.sidebarProjectGroup)),"Background output reordered project entries");
 const projectTree=group.querySelector('[data-workflow-tree="project"]');
 const row=(kind,id)=>document.querySelector('[data-workflow-tree-node="'+kind+':'+id+'"] > .workflow-tree-row');
 await drag(row("session","legacy"),row("folder","pf-c"));
 await until(()=>snapshot.navigation.some(n=>n.sessionId==="legacy"&&n.folderId==="pf-c"),"Session did not enter a deep empty folder");
 check(projectTree.querySelector('[data-workflow-folder="pf-c"] [data-sidebar-session-row="legacy"]'),"Deeply moved session disappeared");
 await drag(row("session","legacy"),row("folder","pf-a"),.1);
 await until(()=>snapshot.navigation.find(n=>n.sessionId==="legacy")?.folderId===undefined,"Session could not leave folder");
 const order=[...projectTree.querySelector('.workflow-tree-root-target').children].map(n=>n.dataset.workflowTreeNode).filter(Boolean);
 check(order.indexOf("session:legacy")+1===order.indexOf("folder:pf-a"),"Mixed folder/session before order not rendered");
 await drag(row("session","main"),row("folder","pf-c"));
 await until(()=>snapshot.navigation.find(n=>n.sessionId==="main")?.folderId==="pf-c","Explicit workspace-free main session could not be filed");
 check(useAppStore.getState().sessions.find(s=>s.id==="main").projectPath===null,"Navigation changed main session workspace");
 const revision=snapshot.revision;await drag(row("folder","pf-a"),row("folder","pf-c"));
 check(snapshot.revision===revision,"Cycle was dispatched to Host");
 const projects=document.querySelector('[data-sidebar-category="projects"]');
 await drag(row("project","visible-group"),projects.querySelector('.sidebar-category-header'));
 await until(()=>snapshot.projectNavigation[0].folderId===undefined&&snapshot.projectNavigation[0].categoryId==="projects","Project could not return to the Projects category root");
 await drag(row("project","visible-group"),row("folder","cat-a"),.1);
 check(projects.querySelector('.sidebar-category-body > .workflow-tree-node').dataset.workflowTreeNode==="project:visible-group","Mixed project/category order not rendered");
 check(document.querySelectorAll('[data-sidebar-project-group]').length===1,"Project duplicated after recategorization");
 // The hover action opens the Agent tab in the project's panel context and reveals it.
 flushSync(()=>document.querySelector('[data-sidebar-project-group="/visible"] [data-action="project-agent"]').click());
 await until(()=>Object.values(useAppStore.getState().workPanelContexts).some(c=>c.open&&c.tabs.some(t=>t.kind==="project-agent"&&t.resource==="visible-group")),"Agent action did not open the Project Agent tab");
 check(useAppStore.getState().page==="project"&&useAppStore.getState().projectConsoleId==="visible-group","Agent action did not take the project home page");
 flushSync(()=>rootNode.unmount());return{passed:true};
};
`;
test("Sidebar has one durable project tree, preserves archive/pin semantics and exposes all unfiled history", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-workflow-project-navigation-"));
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
      loader: { ".css": "empty", ".png": "dataurl" },
    });
    await writeFile(
      join(temp, "index.html"),
      '<!doctype html><div id="root"></div><script type="module" src="renderer.js"></script>',
    );
    await writeFile(
      join(temp, "main.cjs"),
      `const{app,BrowserWindow}=require("electron");const path=require("node:path");app.setPath("userData",path.join(__dirname,"profile"));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});try{await win.loadFile(path.join(__dirname,"index.html"));console.log("PROJECT_NAV_PROBE "+JSON.stringify(await win.webContents.executeJavaScript("window.projectNavigationProbe()")));app.exit(0)}catch(e){console.error(e.stack);app.exit(1)}});`,
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
    assert.equal(code, 0, output.slice(-9000));
    assert.match(output, /PROJECT_NAV_PROBE {"passed":true}/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
