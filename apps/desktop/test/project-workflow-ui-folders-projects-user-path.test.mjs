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
snapshot.expandedIds=["work-1"];
snapshot.workstreams=[{id:"work-1",projectId:"visible-group",title:"Durable work line",goal:"Retain execution context",owner:{kind:"user",ref:"owner"},status:"ready",priority:0,order:0,dependencyIds:[],acceptance:[],nextAction:"Continue",mainSessionId:"main",revision:0,decisionRevision:0,createdAt:"2026-10-20",updatedAt:"2026-10-20"}];
snapshot.conversations=[{sessionId:"side",projectId:"visible-group",workstreamId:"work-1",parentSessionId:"main",sourceRevision:0,relation:"child",purpose:"ask",visibility:"project",readContext:{resourceIds:[],includeDecisions:false,includeArtifacts:false},returnPolicy:"none",archived:false,order:0}];
snapshot.conversations.push(...["completed-side","archived-side","unknown-side"].map((sessionId,index)=>({...snapshot.conversations[0],sessionId,purpose:sessionId==="archived-side"?"ask":"work",order:index+1})));
snapshot.runs=["completed-side","unknown-side"].map(sessionId=>({id:"run-"+sessionId,projectId:"visible-group",workstreamId:"work-1",sessionId,executor:"worker",workstreamRevision:0,decisionRevision:0,authorizationId:"grant",state:"completed",outcome:"Finished",effects:sessionId==="unknown-side"?[{id:"effect",action:"check",resource:"/visible",state:"unknown",detail:"No receipt"}]:[],startedAt:"2026-10-20",updatedAt:"2026-10-20"}));
const groups=[{id:"visible-group",name:"Visible retained project",primaryPath:"/visible",roots:[{path:"/visible"}]},{id:"closed-group",name:"Closed must stay closed",primaryPath:"/closed",roots:[]},{id:"archived-group",name:"Archived must stay archived",primaryPath:"/archived",roots:[]}];
window.piDesktop={platform:"darwin",on(){return()=>{};},async invoke(channel,input){
 if(channel===IPC.invoke.projectGroupList)return{ok:true,data:{groups}};
 if(channel===IPC.invoke.projectWorkflowSnapshot)return{ok:true,data:structuredClone(snapshot)};
 if(channel===IPC.invoke.projectWorkflowMutate){if(!isProjectWorkflowUserCommand(input)||input.kind!=="navigation.expand")throw Error("Unexpected mutation");snapshot.expandedIds=input.expandedIds;snapshot.revision++;return{ok:true,data:{snapshot:structuredClone(snapshot),replayed:false}};}
 if(channel===IPC.invoke.updatesGetState)return{ok:true,data:{status:"idle"}};
 if(channel===IPC.invoke.worktreeBehindAll)return{ok:true,data:{counts:{},statusesChanged:false}};
 throw Error("Unexpected IPC "+channel);
}};
const sessions=["main","side","legacy","completed-side","archived-side","unknown-side"].map((id,index)=>({id,title:id+" conversation",projectPath:"/visible",createdAt:"2026-10-01",updatedAt:"2026-10-0"+(index+1),messageCount:3}));
useAppStore.setState({page:"chat",activeSessionId:null,sessions,openProjectPaths:["/visible","/archived"],openProjects:[{path:"/visible",name:"Visible retained project"},{path:"/archived",name:"Archived must stay archived"}],activeProjectPath:"/visible",workspace:null,projectSort:"manual",projectMeta:{"/visible":{name:"Visible retained project",pinned:true,order:0,collapsed:false},"/archived":{archived:true,order:1}},sessionMeta:{"archived-side":{archived:true}},projectCollapsed:{},sessionView:{archived:false,sort:"recent"}});
const rootNode=createRoot(document.getElementById("root"));
flushSync(()=>rootNode.render(<ProjectWorkflowProvider><Sidebar onToggleSidebar={()=>{}} sidebarToggleShortcut="" sidebarWidth={300} onWidthChange={()=>{}} onWidthCommit={()=>{}} onResizeCollapse={()=>{}}/></ProjectWorkflowProvider>));
const frame=()=>new Promise(requestAnimationFrame);
async function until(check,message){for(let n=0;n<150;n++){if(check())return;await frame();}throw Error(message+document.body.textContent);}
function check(value,message){if(!value)throw Error(message);}
window.projectNavigationProbe=async()=>{
 await until(()=>document.querySelector('[data-workflow-legacy="visible-group"]'),"Workflow projection did not replace legacy flat rows");
 check(document.querySelectorAll('[data-sidebar-project-group]').length===1,"Durable and legacy project rows duplicated, or closed/archived project returned");
 check(!document.body.textContent.includes("Closed must stay closed")&&!document.body.textContent.includes("Archived must stay archived"),"Host catalog overrode visible metadata");
 const group=document.querySelector('[data-sidebar-project-group="/visible"]');
 check(group.querySelector(".sidebar-project-pin"),"Pinned metadata lost");
 check(!group.querySelector('[data-sidebar-session-row="legacy"]'),"Legacy history not folded");
 check(group.querySelectorAll('[data-sidebar-session-row="side"]').length===1,"Explicit child duplicated or missing");
 check(!group.querySelector('[data-sidebar-session-row="main"]'),"Main session repeated as a flat row");
 check(!group.querySelector('[data-sidebar-session-row="completed-side"]'),"Completed Work side was not folded into history");
 check(!group.querySelector('[data-sidebar-session-row="archived-side"]'),"User-archived side was not folded into history");
 check(group.querySelector('[data-sidebar-session-row="unknown-side"]'),"Unknown effect was hidden as completed work");
 const history=[...group.querySelectorAll("button")].find(button=>button.textContent.includes("History (2)"));
 check(history,"Completed and user-archived side history missing");
 flushSync(()=>history.click());
 await until(()=>group.querySelector('[data-sidebar-session-row="completed-side"]')&&group.querySelector('[data-sidebar-session-row="archived-side"]'),"Folded side work became unreachable");
 check(group.querySelector('[data-sidebar-session-row="archived-side"] [data-action="session-menu"]'),"Archived side lost its existing restore action");
 flushSync(()=>group.querySelector('button.project-toggle').click());
	 check(group.querySelector('button.project-toggle').getAttribute("aria-expanded")==="false","Project title did not collapse its children");
	 check(useAppStore.getState().page==="chat","Collapsing a project unexpectedly navigated away");
	 flushSync(()=>group.querySelector('button.project-toggle').click());
	 check(group.querySelector('button.project-toggle').getAttribute("aria-expanded")==="true","Project title did not expand its children");
	 flushSync(()=>[...group.querySelectorAll("button")].find(button=>button.textContent==="Project home").click());
	 check(useAppStore.getState().page==="project"&&useAppStore.getState().projectConsoleId==="visible-group","Project home did not open independent Console");
 flushSync(()=>group.querySelector('[data-workflow-legacy] button').click());
 await until(()=>group.querySelector('[data-sidebar-session-row="legacy"]'),"Legacy conversation no longer reachable");
 check(group.querySelector('[data-sidebar-session-row="legacy"] [data-action="session-menu"]'),"Existing session actions were replaced");
 const before=[...document.querySelectorAll('[data-sidebar-project-group]')].map(row=>row.dataset.sidebarProjectGroup);
 flushSync(()=>useAppStore.setState({sessions:sessions.map(session=>({...session,updatedAt:"2027-01-01"}))}));
 check(JSON.stringify(before)===JSON.stringify([...document.querySelectorAll('[data-sidebar-project-group]')].map(row=>row.dataset.sidebarProjectGroup)),"Background output reordered project entries");
 flushSync(()=>rootNode.unmount());return{passed:true};
};
`;
test("Sidebar has one durable project row, respects retained visibility and preserves folded legacy history", async () => {
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
