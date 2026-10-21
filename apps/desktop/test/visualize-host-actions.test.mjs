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
  const frameWindow = {};
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

test("re-rendering unchanged cached content does not recreate the iframe document", () => {
  let effectIndex = 0;
  let documents = 0;
  const previous = [];
  const state = { activeSessionId: "session" };
  const { VisualizeCard } = loadModule("../src/features/visualize/VisualizeCard.tsx", {
    react: {
      useEffect: (fn, dependencies) => {
        const index = effectIndex++;
        if (!previous[index] || dependencies.some((value, i) => value !== previous[index][i])) {
          previous[index] = dependencies;
          fn();
        }
      },
      useMemo: (fn) => fn(), useRef: () => ({ current: null }),
      useState: (value) => [value, () => {}],
    },
    "react/jsx-runtime": { jsx: () => null, jsxs: () => null },
    "react-i18next": { useTranslation: () => ({ t: (key) => key }) },
    "../../stores/app-store": { useAppStore: (fn) => fn(state) },
    "../../plugins/renderer-slots/use-slots": { useSlotSessionId: () => null },
    "../../lib/use-theme-mode": { useThemeMode: () => "light" },
    "./use-visualize-fragment": { useVisualizeFragment: () => ({ kind: "text", content: "<p>same</p>" }) },
    "./visualize-document": { buildVisualizeDocument: () => "document" },
    "./widget-state": { readWidgetState: () => null },
  }, {
    Blob,
    URL: { createObjectURL: () => { documents++; return "blob:test"; }, revokeObjectURL: () => {} },
    window: { addEventListener: () => {}, removeEventListener: () => {} },
  });
  const props = { spec: { path: "/workspace/chart.html" }, sourcePosition: {}, sourceId: "message" };
  VisualizeCard(props);
  effectIndex = 0;
  VisualizeCard(props);
  assert.equal(documents, 1);
});
