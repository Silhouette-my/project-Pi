import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { initReactI18next, I18nextProvider } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { PermissionCard } from "../../apps/desktop/src/components/PermissionCard";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false, resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
let rootNode = createRoot(document.getElementById("root"));
const shellCommand = "printf BEGIN-WORKFLOW-SHELL-COMMAND; " + "printf workflow-shell-step; ".repeat(1800) + "printf END-WORKFLOW-SHELL-COMMAND";
const shellPermission = {
  sessionId: "session-1", requestId: "shell-1", toolCallId: "tool-shell-1", toolName: "Bash",
  argsPreview: { command: shellCommand }, risk: "high",
  reason: "Run the requested project check", approvalScope: "workflow-shell",
};
const ordinaryPermission = {
  sessionId: "session-1", requestId: "write-1", toolCallId: "tool-write-1", toolName: "Read",
  argsPreview: { path: "/project/README.md" }, risk: "high",
  reason: "Update a project file",
};
function render(permission) {
  flushSync(() => rootNode.render(React.createElement(I18nextProvider, { i18n },
    React.createElement(PermissionCard, { permission }),
  )));
}
function check(condition, message) { if (!condition) throw new Error(message); }
function button(label) {
  const found = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === label);
  check(found, "Missing button: " + label);
  return found;
}
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }

window.permissionCardProbe = async () => {
  window.permissionCalls = [];
  render(shellPermission);
  const shellCard = document.querySelector("[aria-label='Permission needed']");
  check(shellCard?.querySelector('[role="note"]')?.textContent.includes("Each shell command needs separate approval"), "Shell approval warning is missing");
  check(!shellCard.textContent.includes(shellPermission.reason), "Shell boundary repeats the untranslated Host reason");
  check(![...shellCard.querySelectorAll("button")].some((item) => item.textContent.trim() === "Allow for this chat"), "Shell request offered session-wide approval");
  const preview = shellCard.querySelector(".large-text-preview");
  check(preview && Number(preview.dataset.pageCount) > 1, "Long shell command was not paginated for review");
  let reviewedCommand = "";
  while (true) {
    reviewedCommand += preview.querySelector("pre")?.textContent ?? "";
    if (Number(preview.dataset.pageIndex) + 1 >= Number(preview.dataset.pageCount)) break;
    preview.querySelector(".large-text-preview-controls button:last-child").click();
    await settle();
  }
  check(reviewedCommand === shellCommand, "Paginated shell command arguments were truncated or changed");
  check([...shellCard.querySelectorAll("button")].some((item) => item.textContent.trim() === "Deny"), "Shell request lost Deny");
  button("Allow once").click(); await settle();
  check(JSON.stringify(window.permissionCalls) === JSON.stringify([["session-1", "shell-1", "allow-once"]]), "Shell approval did not resolve exactly this request once");

  window.permissionCalls = [];
  flushSync(() => rootNode.unmount());
  rootNode = createRoot(document.getElementById("root"));
  render(ordinaryPermission);
  const ordinaryCard = document.querySelector("[aria-label='Permission needed']");
  check(!ordinaryCard.querySelector('[role="note"]'), "Ordinary permission showed the shell-only warning");
  check(ordinaryCard.textContent.includes(ordinaryPermission.reason), "Ordinary permission lost its reason");
  check([...ordinaryCard.querySelectorAll("button")].some((item) => item.textContent.trim() === "Allow for this chat"), "Ordinary permission lost session-wide approval");
  check(ordinaryCard.textContent.includes("/project/README.md"), "Ordinary tool arguments were not shown in full");
  button("Allow for this chat").click(); await settle();
  check(JSON.stringify(window.permissionCalls) === JSON.stringify([["session-1", "write-1", "allow-session"]]), "Ordinary permission no longer supports session-wide approval");
  return { passed: true };
};
`;

test(
  "workflow shell permission requires per-command approval while ordinary permissions retain session approval",
  { skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false },
  async () => {
    const temp = await mkdtemp(join(root, "apps/desktop/.permission-card-ui-"));
    try {
      await writeFile(
        join(temp, "store-fixture.ts"),
        `const state = { sessions: [{ id: "session-1", projectPath: "/project" }], workspace: { path: "/project" }, resolvePermission: async (...args) => { window.permissionCalls.push(args); }, showToast() {} }; export function useAppStore(selector) { return selector(state); }`,
      );
      await build({
        stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
        outfile: join(temp, "renderer.js"),
        bundle: true,
        platform: "browser",
        format: "esm",
        jsx: "automatic",
        define: { "process.env.NODE_ENV": '"development"' },
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
        plugins: [
          {
            name: "permission-card-store-fixture",
            setup(build) {
              build.onResolve({ filter: /stores\/app-store$/ }, () => ({ path: join(temp, "store-fixture.ts") }));
            },
          },
        ],
      });
      await writeFile(
        join(temp, "index.html"),
        '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><div id="root"></div><script type="module" src="renderer.js"></script>',
      );
      await writeFile(
        join(temp, "main.cjs"),
        `const { app, BrowserWindow } = require("electron"); const path = require("node:path"); app.setPath("userData", path.join(__dirname, "profile")); app.whenReady().then(async () => { const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } }); try { await win.loadFile(path.join(__dirname, "index.html")); console.log("PERMISSION_CARD_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.permissionCardProbe()"))); app.exit(0); } catch (error) { console.error(error?.stack ?? error); app.exit(1); } });`,
      );
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      for (const [key, directory] of Object.entries({
        HOME: "home", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_DATA_HOME: "data",
      })) {
        env[key] = join(temp, directory);
        await mkdir(env[key], { recursive: true });
      }
      const child = spawn(
        process.env.PI_WORKFLOW_TEST_ELECTRON ?? resolveElectronBinary(root).electronBinary,
        [join(temp, "main.cjs")],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => { output += chunk; });
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
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
      const result = output.split(/\r?\n/).find((line) => line.startsWith("PERMISSION_CARD_PROBE "));
      assert.ok(result, output.slice(-6000));
      assert.deepEqual(JSON.parse(result.slice("PERMISSION_CARD_PROBE ".length)), { passed: true });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
