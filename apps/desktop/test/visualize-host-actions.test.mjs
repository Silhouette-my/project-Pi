import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

function loadModule(relativePath, imports, globals = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (name) => imports[name] ?? {},
    ...globals,
  });
  return exports;
}

test("iframe load messages cannot send prompts or open links without host confirmation", () => {
  let listener;
  const frameWindow = { postMessage: () => {} };
  const sent = [];
  const opened = [];
  const pending = [];
  const state = { activeSessionId: "work-session", sendPrompt: (...args) => sent.push(args) };
  const { VisualizeCard } = loadModule("../src/features/visualize/VisualizeCard.tsx", {
    react: {
      useEffect: (fn) => fn(), useMemo: (fn) => fn(),
      useRef: () => ({ current: { contentWindow: frameWindow } }),
      useState: (value) => [value, (next) => pending.push(next)],
    },
    "react/jsx-runtime": { jsx: () => null, jsxs: () => null },
    "react-i18next": { useTranslation: () => ({ t: (key) => key }) },
    "../../stores/app-store": { useAppStore: Object.assign((fn) => fn(state), { getState: () => state }) },
    "../../plugins/renderer-slots/use-slots": { useSlotSessionId: () => null },
    "../../lib/use-theme-mode": { useThemeMode: () => "light" },
    "../../lib/open-http-url": { openHttpUrl: (url) => opened.push(url) },
    "./use-visualize-fragment": { useVisualizeFragment: () => ({ kind: "loading" }) },
  }, {
    window: { addEventListener: (_, fn) => { listener = fn; }, removeEventListener: () => {} },
  });
  VisualizeCard({ spec: { path: "/workspace/chart.html" }, sourcePosition: {}, sourceId: "message-1" });
  for (const data of [
    { type: "follow-up", prompt: "RUN_WITHOUT_CLICK" },
    { type: "open-external", href: "https://example.com" },
  ]) listener({ source: frameWindow, data: { source: "pi-visualize", ...data } });
  assert.equal(sent.length, 0);
  assert.equal(opened.length, 0);
  assert.ok(pending.some((value) => value?.kind === "follow-up"));
  assert.ok(pending.some((value) => value?.kind === "open-external"));
});

test("a new message reads an updated path while the old card retains its snapshot", async () => {
  let reads = 0;
  let content = "version 1";
  const { useVisualizeFragment } = loadModule("../src/features/visualize/use-visualize-fragment.ts", {
    react: { useEffect: (fn) => fn(), useState: (value) => [value, () => {}] },
    "../../lib/remote-session-safety": { sessionAllows: () => true },
    "../../plugins/renderer-slots/use-slots": { useSlotSessionId: () => null },
    "../../stores/app-store": { useAppStore: (fn) => fn({ activeSessionId: "session", sessions: [] }) },
    "../../lib/api": { api: { fsRead: async () => { reads++; return { kind: "text", content }; } } },
  });
  useVisualizeFragment("/workspace/chart.html", "message-1");
  await Promise.resolve();
  content = "version 2";
  useVisualizeFragment("/workspace/chart.html", "message-2");
  await Promise.resolve();
  assert.equal(reads, 2);
  assert.equal(useVisualizeFragment("/workspace/chart.html", "message-1").content, "version 1");
  assert.equal(useVisualizeFragment("/workspace/chart.html", "message-2").content, "version 2");
});

test("ordinary external links request host confirmation and do not navigate the frame", () => {
  let onClick;
  let prevented = 0;
  const messages = [];
  vm.runInNewContext(readFileSync(new URL("../src/features/visualize/assets/visualize-bridge.js", import.meta.url), "utf8"), {
    document: {
      documentElement: { dataset: {}, scrollHeight: 100 },
      getElementById: () => null,
      addEventListener: (_, fn) => { onClick = fn; },
    },
    navigator: { userActivation: { isActive: true } },
    parent: { postMessage: (message) => messages.push(message) },
    addEventListener: () => {},
  });
  const click = (href) => onClick({
    target: { closest: () => ({ getAttribute: () => href }) },
    isTrusted: true,
    preventDefault: () => prevented++,
  });
  click("https://example.com/chart");
  assert.equal(prevented, 1);
  assert.ok(messages.some((message) => message.type === "open-external" && message.href === "https://example.com/chart"));
  click("#details");
  assert.equal(prevented, 1);
});

test("frame initialization accepts the true parent once and ignores load resends", () => {
  const { visualizeFrameBootstrap } = loadModule("../electron/shared/visualize-frame.ts", {});
  const script = visualizeFrameBootstrap().match(/<script>([\s\S]*)<\/script>/)[1];
  const owner = {};
  let listener;
  const writes = [];
  const child = {
    parent: owner,
    addEventListener: (_, fn) => { listener = fn; },
    removeEventListener: () => { listener = null; },
  };
  vm.runInNewContext(script, { window: child, document: {
    open: () => {}, write: (content) => writes.push(content), close: () => {},
  } });
  const data = { source: "pi-visualize-host", type: "initialize", document: "<p>chart</p>" };
  listener({ source: {}, data });
  assert.equal(writes.length, 0);
  listener({ source: owner, data });
  assert.equal(writes.length, 1);
  assert.equal(listener, null, "a repeated load cannot rewrite the document");
});

test("the frame protocol serves only its fixed GET document under an independent locked CSP", async () => {
  const shared = loadModule("../electron/shared/visualize-frame.ts", {});
  const { visualizeFrameResponse, VISUALIZE_FRAME_SCHEME_PRIVILEGES } = loadModule(
    "../electron/main/visualize-frame-protocol.ts",
    { "../shared/visualize-frame": shared },
    { Response },
  );
  for (const [url, method] of [
    [shared.VISUALIZE_FRAME_URL, "POST"],
    ["pi-visualize://frame/private.html", "GET"],
    ["pi-visualize://other/index.html", "GET"],
    ["pi-visualize://frame/index.html?path=/private/file", "GET"],
  ]) assert.equal(visualizeFrameResponse(new Request(url, { method })).status, 404);
  const response = visualizeFrameResponse(new Request(shared.VISUALIZE_FRAME_URL));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("content-security-policy"), shared.visualizeFrameCsp());
  assert.match(response.headers.get("content-security-policy"), /connect-src 'none'/);
  assert.match(await response.text(), /event\.source !== owner/);
  assert.equal(VISUALIZE_FRAME_SCHEME_PRIVILEGES.privileges.bypassCSP, undefined);
});
