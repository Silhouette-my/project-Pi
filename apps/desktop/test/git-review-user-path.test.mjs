import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const require = createRequire(join(root, "apps/desktop/package.json"));
const { build } = require("vite");
const tailwindcss = require("@tailwindcss/vite").default;
const execFile = promisify(execFileCallback);

test("Review reads actual Git layers, refreshes external edits and keeps tool history separate", { timeout: 60_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-git-review-ui-"));
  const evidence = join(root, ".artifacts/git-review-ui");
  await mkdir(evidence, { recursive: true });
  const paths = Object.fromEntries(["a", "b", "plain"].map((name) => [name, join(temp, name)]));
  try {
    for (const path of Object.values(paths)) await mkdir(path);
    for (const name of ["a", "b"]) {
      const cwd = paths[name];
      await execFile("git", ["init", "--quiet"], { cwd });
      await execFile("git", ["config", "user.name", "Review UI test"], { cwd });
      await execFile("git", ["config", "user.email", "review-ui@example.invalid"], { cwd });
      await writeFile(join(cwd, "tracked.txt"), "base\n");
      await execFile("git", ["add", "."], { cwd });
      await execFile("git", ["commit", "--quiet", "-m", "base"], { cwd });
    }
    await writeFile(join(paths.a, "tracked.txt"), "staged edit\n");
    await execFile("git", ["add", "tracked.txt"], { cwd: paths.a });
    await writeFile(join(paths.a, "tracked.txt"), "working edit\n");
    await writeFile(join(paths.a, "script-output.txt"), "shell-created output\n");
    await writeFile(join(paths.b, "other-project.txt"), "other project\n");
    await build({
      configFile: false, root, base: "./", logLevel: "error", plugins: [tailwindcss()],
      esbuild: { jsx: "automatic" }, define: { "process.env.NODE_ENV": '"production"' },
      resolve: { alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      } },
      build: { outDir: temp, emptyOutDir: false, lib: { entry: join(root, "apps/desktop/test/fixtures/git-review-user-path.tsx"), formats: ["es"], fileName: () => "renderer.js", cssFileName: "renderer" }, rollupOptions: { output: { inlineDynamicImports: true } } },
    });
    await writeFile(join(temp, "index.html"), `<!doctype html><html data-theme="dark"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"><link rel="stylesheet" href="renderer.css"><style>body{margin:0;background:var(--ds-bg-primary);color:var(--ds-text-primary)}</style><div id="root"></div><script type="module" src="renderer.js"></script></html>`);
    await writeFile(join(temp, "preload.cjs"), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('reviewFixture',{diff:(id)=>ipcRenderer.invoke('fixture:diff',id),mutate:()=>ipcRenderer.invoke('fixture:mutate'),project:()=>ipcRenderer.invoke('fixture:project')});`);
    await writeFile(join(temp, "main.cjs"), `
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const {collectWorkspaceDiff}=await import(${JSON.stringify(pathToFileURL(join(root, "packages/host-runtime/dist/workspace-diff.js")).href)});
 const paths=${JSON.stringify(paths)};
 ipcMain.handle('fixture:diff',(_,id)=>{if(id==='broken')throw new Error('Git fixture failure');return collectWorkspaceDiff(paths[id]);});
 ipcMain.handle('fixture:mutate',()=>fs.writeFile(path.join(paths.a,'after-refresh.txt'),'external write\\n'));
 ipcMain.handle('fixture:project',async()=>({projectId:'project-a',repositories:await Promise.all(['a','b'].map(async(id)=>({rootId:id,label:id,changes:await collectWorkspaceDiff(paths[id])})))}));
 const win=new BrowserWindow({show:false,width:520,height:760,webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',(event)=>console.error(event.message));
 try{
  await win.loadFile(path.join(__dirname,'index.html'));
  await win.webContents.executeJavaScript('window.prepareGitReview()');
  await fs.writeFile(${JSON.stringify(join(evidence, "git-review-narrow.png"))},(await win.webContents.capturePage()).toPNG());
  win.setContentSize(900,760);
  await new Promise(resolve=>setTimeout(resolve,100));
  await fs.writeFile(${JSON.stringify(join(evidence, "git-review-wide.png"))},(await win.webContents.capturePage()).toPNG());
  const result=await win.webContents.executeJavaScript('window.gitReviewProbe()');
  await fs.writeFile(${JSON.stringify(join(evidence, "result.json"))},JSON.stringify(result,null,2));
  console.log('GIT_REVIEW_RESULT '+JSON.stringify(result));app.exit(0);
 }catch(error){console.error(error.stack||error);app.exit(1);}
});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.env.PI_DESKTOP_ELECTRON_BIN || resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    await writeFile(join(evidence, "test.log"), output);
    assert.equal(code, 0, output.slice(-6000));
    assert.match(output, /GIT_REVIEW_RESULT .*"passed":true/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
