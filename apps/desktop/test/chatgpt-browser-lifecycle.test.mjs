import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();

// Real Electron, local synthetic documents, and an isolated persistent profile.
// The iframe models the SDK's postMessage + animation-frame dependency.
test("offscreen iframe tokens work fresh and after a persisted-login process restart", { timeout: 60000 }, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.chatgpt-browser-lifecycle-"));
  try {
    await writeFile(join(temp, "frame.html"), `<script>
      addEventListener('message', event => {
        if (event.data?.kind === 'synthetic-token') requestAnimationFrame(() => event.source.postMessage({ kind: 'synthetic-result', id: event.data.id }, '*'));
      });
      parent.postMessage({ kind: 'synthetic-ready' }, '*');
    </script>`);
    await writeFile(join(temp, "index.html"), `<script>
      window.frameReady = new Promise(resolve => addEventListener('message', event => { if (event.data?.kind === 'synthetic-ready') resolve(true); }));
      window.syntheticToken = id => new Promise(resolve => {
        const receive = event => { if (event.data?.kind === 'synthetic-result' && event.data.id === id) { removeEventListener('message', receive); resolve(true); } };
        addEventListener('message', receive);
        document.querySelector('iframe').contentWindow.postMessage({ kind: 'synthetic-token', id }, '*');
      });
    </script><iframe style="display:none" src="frame.html"></iframe>`);
    await writeFile(join(temp, "main.cjs"), `
      const { app, BrowserWindow, WebContentsView } = require('electron');
      const path = require('node:path');
      app.setPath('userData', path.join(__dirname, 'profile'));
      // Keep this test process alive after closing its only login fixture;
      // production's existing close/quit/tray handler remains unchanged.
      app.on('window-all-closed', () => {});
      const restart = process.argv.includes('--restart');
      const partition = 'persist:synthetic-chatgpt';
      app.whenReady().then(async () => {
        const results = { restart };
        let nonce = 0;
        const create = offscreen => {
          const view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen } });
          view.setBounds({ x: 0, y: 0, width: 500, height: 300 });
          return view;
        };
        const load = async view => {
          await view.webContents.loadFile(path.join(__dirname, 'index.html'));
          await view.webContents.executeJavaScript('window.frameReady');
        };
        const probe = async view => {
          let timer;
          try { return await Promise.race([
            view.webContents.executeJavaScript('window.syntheticToken(' + JSON.stringify(String(++nonce)) + ')').then(() => 'resolved'),
            new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 3000); }),
          ]); } finally { clearTimeout(timer); }
        };
        try {
          if (!restart) {
            const normal = create(false);
            await load(normal);
            results.neverAttachedNormal = await probe(normal);
            normal.webContents.close();
            const loginWindow = new BrowserWindow({ show: true, width: 500, height: 300, title: 'Synthetic login fixture' });
            await loginWindow.loadURL('data:text/html,<html><body>Synthetic login fixture</body></html>');
            const login = create(false);
            loginWindow.contentView.addChildView(login);
            await load(login);
            results.loginOffscreen = login.webContents.isOffscreen();
            await login.webContents.session.cookies.set({ url: 'https://synthetic.invalid', name: 'synthetic-login', value: 'fixture-only', expirationDate: Date.now() / 1000 + 3600 });
            await login.webContents.session.cookies.flushStore();
            loginWindow.contentView.removeChildView(login);
            login.webContents.close(); loginWindow.destroy();
          }
          const transport = create(true);
          results.offscreen = transport.webContents.isOffscreen();
          await load(transport);
          results.freshToken = await probe(transport);
          await load(transport);
          results.navigationToken = await probe(transport);
          results.persistedLogin = (await transport.webContents.session.cookies.get({ url: 'https://synthetic.invalid', name: 'synthetic-login' })).some(cookie => cookie.value === 'fixture-only');
          results.nativeWindows = BrowserWindow.getAllWindows().length;
          transport.webContents.close();
          console.log('CHATGPT_SYNTHETIC_LIFECYCLE ' + JSON.stringify(results));
          app.exit(0);
        } catch (error) { console.error(error); app.exit(1); }
      });
    `);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const launch = async (restart) => {
      const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs"), ...(restart ? ["--restart"] : [])], { env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      for (const stream of [child.stdout, child.stderr]) { stream.setEncoding("utf8"); stream.on("data", (chunk) => { output += chunk; }); }
      const timeout = setTimeout(() => child.kill("SIGKILL"), 25000);
      let code;
      try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
      finally { clearTimeout(timeout); }
      assert.equal(code, 0, output.slice(-4000));
      const record = output.split("\n").find((line) => line.startsWith("CHATGPT_SYNTHETIC_LIFECYCLE "));
      assert.ok(record, "fixture did not return lifecycle observations: " + output.slice(-4000));
      return JSON.parse(record.slice("CHATGPT_SYNTHETIC_LIFECYCLE ".length));
    };
    const first = await launch(false);
    assert.equal(first.neverAttachedNormal, "timeout", "negative control reproduces the normal-view scheduling failure");
    assert.equal(first.loginOffscreen, false);
    for (const result of [first, await launch(true)]) {
      assert.equal(result.offscreen, true);
      assert.equal(result.freshToken, "resolved");
      assert.equal(result.navigationToken, "resolved");
      assert.equal(result.persistedLogin, true);
      assert.equal(result.nativeWindows, 0, "transport must not keep a hidden native window alive");
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
