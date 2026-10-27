import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";
const root = repositoryRoot();
const require = createRequire(join(root, "apps/desktop/package.json"));
const { build } = require("vite");
const tailwindcss = require("@tailwindcss/vite").default;
test("Project Console real renderer uses explicit scoped intents and reconstructs authoritative state", {
  skip:
    process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-workflow-console-"));
  const artifacts = join(root, ".artifacts/project-workflow-ui");
  await mkdir(artifacts, { recursive: true });
  try {
    await build({
      configFile: false,
      root,
      base: "./",
      logLevel: "error",
      plugins: [tailwindcss()],
      resolve: {
        alias: {
          "@pi-desktop/shared": join(root, "packages/shared/src"),
          "@pi-desktop/i18n": join(root, "packages/i18n/src"),
          react: join(root, "apps/desktop/node_modules/react"),
          "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
          i18next: join(root, "apps/desktop/node_modules/i18next"),
          "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
        },
      },
      esbuild: { jsx: "automatic" },
      define: { "process.env.NODE_ENV": '"production"' },
      build: {
        outDir: temp,
        emptyOutDir: false,
        lib: {
          entry: join(root, "apps/desktop/test/fixtures/project-workflow-console-user-path.tsx"),
          formats: ["es"],
          fileName: () => "renderer.js",
          cssFileName: "renderer",
        },
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    });
    await writeFile(
      join(temp, "index.html"),
      '<!doctype html><html data-theme="light"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;self&#39;; style-src &#39;self&#39; &#39;unsafe-inline&#39;; img-src &#39;self&#39; data:"><link rel="stylesheet" href="renderer.css"><style>html,body,#root{height:100%;margin:0}body{background:var(--ds-bg-primary);font-family:system-ui,sans-serif}#root{display:flex;min-width:0}output[data-workflow-test-revision]{display:none}</style><div id="root"></div><script type="module" src="renderer.js"></script></html>',
    );
    await writeFile(
      join(temp, "main.cjs"),
      `const {app,BrowserWindow}=require("electron");const path=require("node:path");const fs=require("node:fs/promises");app.setPath("userData",path.join(__dirname,"profile"));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1180,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.webContents.on("console-message",(_e,_l,m)=>console.log("RENDERER "+m));try{await win.loadFile(path.join(__dirname,"index.html"));const result=await win.webContents.executeJavaScript("window.consoleProbe()");for(const [theme,width,name,target] of [["light",1180,"console-light.png"],["dark",1180,"console-dark.png"],["light",420,"console-narrow.png"],["light",1180,"console-controls.png","controls"],["light",1180,"console-artifacts.png","artifacts"],["light",1180,"console-session.png","session"],["light",420,"console-session-narrow.png","session"]]){win.setContentSize(width,1000);const layout=await win.webContents.executeJavaScript("window.consoleScreenshot("+JSON.stringify(theme)+","+JSON.stringify(target)+")");if(layout.scrollWidth>layout.width+1)throw Error("Console horizontally overflows "+JSON.stringify(layout));await fs.writeFile(path.join(${JSON.stringify(artifacts)},name),(await win.webContents.capturePage()).toPNG());}console.log("CONSOLE_PROBE "+JSON.stringify(result));app.exit(0)}catch(e){console.error(e.stack);app.exit(1)}});`,
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output.slice(-18000));
    assert.match(output, /CONSOLE_PROBE {"passed":true/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
