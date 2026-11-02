import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const require = createRequire(join(root, "apps/desktop/package.json"));
const { build } = require("vite");
const tailwindcss = require("@tailwindcss/vite").default;

test("Settings archive manager searches, opens and restores existing conversations", { timeout: 60_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-archived-settings-"));
  const evidence = join(root, ".artifacts/archived-settings");
  await mkdir(evidence, { recursive: true });
  try {
    await build({
      configFile: false, root, base: "./", logLevel: "error", plugins: [tailwindcss()],
      esbuild: { jsx: "automatic" },
      define: { "process.env.NODE_ENV": '"production"' },
      resolve: { alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      } },
      build: {
        outDir: temp, emptyOutDir: false,
        lib: {
          entry: join(root, "apps/desktop/test/fixtures/archived-conversations-user-path.tsx"),
          formats: ["es"], fileName: () => "renderer.js", cssFileName: "renderer",
        },
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    });
    await writeFile(join(temp, "index.html"), `<!doctype html><html data-theme="light"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"><link rel="stylesheet" href="renderer.css"><style>body{margin:0;background:var(--ds-bg-primary);color:var(--ds-text-primary)}.settings-content{padding:32px}</style><div id="root"></div><script type="module" src="renderer.js"></script></html>`);
    await writeFile(join(temp, "main.cjs"), `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:900,height:650,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',(event)=>console.error(event.message));
 try {
  await win.loadFile(path.join(__dirname,'index.html'));
  await win.webContents.executeJavaScript('window.prepareArchiveSettings()');
  await win.webContents.executeJavaScript("window.archiveSettingsScreenshot('light')");
  await fs.writeFile(${JSON.stringify(join(evidence, "light.png"))},(await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("window.archiveSettingsScreenshot('dark')");
  await fs.writeFile(${JSON.stringify(join(evidence, "dark.png"))},(await win.webContents.capturePage()).toPNG());
  win.setContentSize(520,650);
  await win.webContents.executeJavaScript("window.archiveSettingsScreenshot('dark')");
  await fs.writeFile(${JSON.stringify(join(evidence, "narrow.png"))},(await win.webContents.capturePage()).toPNG());
  const result=await win.webContents.executeJavaScript('window.archiveSettingsProbe()');
  console.log('ARCHIVED_SETTINGS_RESULT '+JSON.stringify(result));
  app.exit(0);
 }catch(error){console.error(error.stack||error);app.exit(1);return;}
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
    assert.match(output, /ARCHIVED_SETTINGS_RESULT .*"passed":true/);
    const page = await readFile(join(root, "apps/desktop/src/features/settings/SettingsPage.tsx"), "utf8");
    assert.match(page, /<ArchivedConversationsSection\s*\/>/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
