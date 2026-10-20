import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import test from "node:test";
import { pageModels, parseChatGptChatModels } from "../electron/main/chatgpt-chat-models.ts";
import { createChatGptDiagnosticLogger, chatGptDocumentEndpoint, logChatGptDocumentEvent, logChatGptConversationEvent } from "../electron/main/chatgpt-chat-diagnostics.ts";

const pageContext = { pageModels, parseChatGptChatModels, URL };
const pageSource = stripTypeScriptTypes(readFileSync(new URL("../electron/main/chatgpt-chat-page.ts", import.meta.url), "utf8")).replace(/^import .*;$/gm, "").replace(/export /g, "");
vm.runInNewContext(`${pageSource}\nglobalThis.api = {authStatusScript, conversationScript, streamPayload, trustedChatGptUrl}`, pageContext);
const { authStatusScript, conversationScript, streamPayload, trustedChatGptUrl } = pageContext.api;

function validSession(accessToken) {
  return { ok: true, status: 200, redirected: false, headers: { get: (name) => name === "content-type" ? "application/json" : null }, json: async () => ({ user: { id: "user" }, ...(accessToken ? { accessToken } : {}) }) };
}

test("remote bridge accepts only typed stream payloads and exact ChatGPT origin", () => {
  assert.equal(trustedChatGptUrl("https://chatgpt.com/"), true);
  for (const url of ["http://chatgpt.com", "https://chatgpt.com.evil.test", "file:///tmp/a", "bad"]) assert.equal(trustedChatGptUrl(url), false);
  assert.equal(streamPayload({ requestId: "a", type: "chunk", chunk: 5 }), null);
  assert.equal(streamPayload({ requestId: "a", type: "other" }), null);
  assert.deepEqual({ ...streamPayload({ requestId: "a", type: "end", secret: "ignored" }) }, { requestId: "a", type: "end" });
});

test("page transport preserves split UTF-8, cookies and observed headers without Authorization", async () => {
  const events = [];
  let request;
  let sentinelFlow;
  const bytes = new TextEncoder().encode("data: 你好\n\n");
  const context = {
    window: { SentinelSDK: { init: async () => undefined, token: async (flow) => { sentinelFlow = flow; return "sentinel"; } }, __piChatModelDefaults: new Map([["account-pro-slug", { efforts: [] }]]), __piBridge: { send: (event) => { if (event.type !== "diagnostic") events.push(event); } } },
    document: { cookie: "oai-did=device" }, navigator: { language: "en-US" },
    crypto: { randomUUID: () => "session" }, AbortController, TextDecoder, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      if (url === "/api/auth/session") return validSession();
      if (url.includes("/sentinel/chat-requirements/")) return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => url.endsWith("/prepare") ? { prepare_token: "prep", turnstile: { required: "not_required" } } : { token: "reqtok" } };
      request = { url, options };
      return { ok: true, status: 200, headers: { get: (name) => name === "content-type" ? "text/event-stream" : null }, body: new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 8)); controller.enqueue(bytes.slice(8)); controller.close(); } }) };
    },
  };
  await vm.runInNewContext(conversationScript("req", { action: "next" }, { "OAI-Client-Version": "current" }), context);
  assert.equal(events.filter((event) => event.type === "chunk").map((event) => event.chunk).join(""), "data: 你好\n\n");
  assert.equal(events.at(-1).type, "end");
  assert.equal(request.url, "/backend-api/conversation");
  assert.equal(request.options.credentials, "include");
  assert.equal(request.options.headers["OAI-Client-Version"], "current");
  assert.equal(request.options.headers.Authorization, undefined);
  // The consumer risk engine binds Sentinel tokens to a flow; the completion
  // flow literal is "conversation" (see completion.submit.request.stream_setup
  // in the official client). A token for any other flow yields HTTP 403.
  assert.equal(sentinelFlow, "conversation");
  assert.equal(context.window.__piChatRequests.size, 0);
});

test("page failures terminate the stream and do not forward response bodies", async () => {
  const events = [];
  const diagnostics = [];
  await vm.runInNewContext(conversationScript("req", {}, {}), {
    window: { SentinelSDK: { init: async () => undefined, token: async () => "token" }, __piBridge: { send: (event) => { if (event.type !== "diagnostic") events.push(event); else diagnostics.push(event); } } },
    document: { cookie: "oai-did=device" }, navigator: { language: "en" }, crypto: { randomUUID: () => "id" }, AbortController, setTimeout, clearTimeout,
    fetch: async (url) => url === "/api/auth/session" ? validSession() : ({ ok: false, status: 403, headers: { get: () => "application/json" }, text: () => { throw new Error("must not read credentials/error page"); }, json: async () => ({ detail: "Unusual activity detected from your device" }) }),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.match(events[0].error, /HTTP 403/);
  // The server's own explanation is captured for diagnostics only: it must
  // never reach the UI error, and the body must never be read as text.
  const failed = diagnostics.filter((event) => event.type === "diagnostic" && event.outcome === "failed").at(-1);
  assert.equal(failed.stage, "post");
  assert.equal(failed.reason, "post_http_error");
  assert.equal(failed.detail, "Unusual activity detected from your device");
  assert.doesNotMatch(events[0].error, /Unusual activity/);
});

test("page surfaces HTTP 429 as account rate limiting with retry guidance", async () => {
  const events = [];
  const diagnostics = [];
  await vm.runInNewContext(conversationScript("req", {}, {}), {
    window: { SentinelSDK: { init: async () => undefined, token: async () => "token" }, __piBridge: { send: (event) => { if (event.type !== "diagnostic") events.push(event); else diagnostics.push(event); } } },
    document: { cookie: "oai-did=device" }, navigator: { language: "en" }, crypto: { randomUUID: () => "id" }, AbortController, setTimeout, clearTimeout,
    fetch: async (url) => url === "/api/auth/session" ? validSession() : ({ ok: false, status: 429, headers: { get: (name) => name === "retry-after" ? "30" : null }, json: async () => ({ detail: "Too many requests" }) }),
  });
  assert.equal(events.length, 1);
  assert.match(events[0].error, /rate limiting this account \(HTTP 429, retry after 30 seconds\)/);
  const failed = diagnostics.filter((event) => event.type === "diagnostic" && event.outcome === "failed").at(-1);
  assert.equal(failed.stage, "post");
  assert.equal(failed.reason, "post_rate_limited");
});

test("page cancellation aborts fetch and emits one terminal error", async () => {
  const events = [];
  const context = {
    window: { SentinelSDK: { init: async () => undefined, token: async () => "token" }, __piBridge: { send: (event) => { if (event.type !== "diagnostic") events.push(event); } } },
    document: { cookie: "oai-did=device" }, navigator: { language: "en" }, crypto: { randomUUID: () => "id" }, AbortController, setTimeout, clearTimeout,
    fetch: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))),
  };
  const completion = vm.runInNewContext(conversationScript("cancel", {}, {}), context);
  await new Promise((resolve) => setImmediate(resolve));
  context.window.__piChatRequests.get("cancel").abort();
  await completion;
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.match(events[0].error, /cancelled/);
  assert.equal(context.window.__piChatRequests.size, 0);
});

test("consumer session bearer remains page-local alongside cookie and Sentinel authentication", async () => {
  const events = [];
  let request;
  await vm.runInNewContext(conversationScript("bearer", { model: "account-pro-slug" }, {}), {
    window: { SentinelSDK: { init: async () => undefined, token: async () => "sentinel" }, __piChatModelDefaults: new Map([["account-pro-slug", { efforts: [] }]]), __piBridge: { send: (event) => { if (event.type !== "diagnostic") events.push(event); } } },
    document: { cookie: "oai-did=device" }, navigator: { language: "en" }, crypto: { randomUUID: () => "id" }, AbortController, TextDecoder, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      if (url === "/api/auth/session") return validSession("PAGE_LOCAL_SECRET");
      if (url.includes("/sentinel/chat-requirements/")) return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => url.endsWith("/prepare") ? { prepare_token: "prep", turnstile: { required: "not_required" } } : { token: "reqtok" } };
      request = options;
      return { ok: true, status: 200, headers: { get: (name) => name === "content-type" ? "text/event-stream" : null }, body: new ReadableStream({ start(controller) { controller.close(); } }) };
    },
  });
  assert.equal(request.credentials, "include");
  assert.equal(request.headers.Authorization, "Bearer PAGE_LOCAL_SECRET");
  assert.equal(request.headers["OpenAI-Sentinel-Token"], "sentinel");
  assert.equal(JSON.parse(request.body).model, "account-pro-slug");
  assert.doesNotMatch(JSON.stringify(events), /PAGE_LOCAL_SECRET|sentinel/);
  assert.equal(events.at(-1).type, "end");
});

for (const [name, body, defaults, expected] of [
  ["account default", { model: "account-pro-slug" }, new Map([["account-pro-slug", { defaultEffort: "account-effort-value", efforts: [] }]]), "account-effort-value"],
  ["instant default", { model: "account-pro-slug" }, new Map([["account-pro-slug", { defaultEffort: "medium", efforts: ["instant", "medium", "high"] }]]), "instant"],
  ["explicit effort", { model: "account-pro-slug", thinking_effort: "explicit-value" }, new Map([["account-pro-slug", { defaultEffort: "account-effort-value", efforts: [] }]]), "explicit-value"],
  ["clamped explicit effort", { model: "account-pro-slug", thinking_effort: "extra_high" }, new Map([["account-pro-slug", { defaultEffort: "high", efforts: ["low", "medium", "high"] }]]), "high"],
  ["unknown default", { model: "account-pro-slug" }, new Map(), undefined],
]) {
  test(`conversation forwards selected slug with ${name} without inventing Pro parameters`, async () => {
    let requestBody;
    await vm.runInNewContext(conversationScript("model-default", body, {}), {
      window: { SentinelSDK: { init: async () => undefined, token: async () => "sentinel" }, __piChatModelDefaults: defaults, __piBridge: { send() {} } },
      document: { cookie: "oai-did=device" }, navigator: { language: "en" }, crypto: { randomUUID: () => "id" }, AbortController, TextDecoder, setTimeout, clearTimeout,
      fetch: async (url, options) => {
        if (url === "/api/auth/session") return validSession();
        if (url.startsWith("/backend-api/models")) return { ...validSession(), json: async () => ({ models: [{ slug: "account-pro-slug" }] }) };
        if (url.includes("/sentinel/chat-requirements/")) return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => url.endsWith("/prepare") ? { prepare_token: "prep", turnstile: { required: "not_required" } } : { token: "reqtok" } };
        requestBody = JSON.parse(options.body);
        return { ok: true, status: 200, headers: { get: (name) => name === "content-type" ? "text/event-stream" : null }, body: new ReadableStream({ start(controller) { controller.close(); } }) };
      },
    });
    assert.equal(requestBody.model, "account-pro-slug");
    assert.equal(requestBody.thinking_effort, expected);
    assert.deepEqual(Object.keys(requestBody).sort(), expected === undefined ? ["model"] : ["model", "thinking_effort"]);
    assert.equal(Object.hasOwn(body, "thinking_effort"), ["explicit effort", "clamped explicit effort"].includes(name));
  });
}

test("cancellation while Sentinel waits prevents conversation submission", async () => {
  let resolveSentinel;
  let conversationCalls = 0;
  const events = [];
  const context = {
    window: { SentinelSDK: { init: async () => undefined, token: () => new Promise((resolve) => { resolveSentinel = resolve; }) }, __piBridge: { send: (event) => { if (event.type !== "diagnostic") events.push(event); } } },
    AbortController, setTimeout, clearTimeout,
    fetch: async (url) => { if (url !== "/api/auth/session") conversationCalls++; return validSession("SECRET"); },
  };
  const completion = vm.runInNewContext(conversationScript("cancel-sentinel", {}, {}), context);
  await new Promise((resolve) => setImmediate(resolve));
  context.window.__piChatRequests.get("cancel-sentinel").abort();
  resolveSentinel("sentinel");
  await completion;
  assert.equal(conversationCalls, 0);
  assert.match(events[0].error, /cancelled/);
});

test("direct send from a fresh page reloads saved model defaults once including no-default models", async () => {
  const sent = [];
  let catalogCalls = 0;
  const context = {
    window: { SentinelSDK: { init: async () => undefined, token: async () => "sentinel" }, __piBridge: { send() {} } },
    document: { cookie: "oai-did=device" }, navigator: { language: "en" }, crypto: { randomUUID: () => "id" }, AbortController, TextDecoder, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      if (url === "/api/auth/session") return validSession();
      if (url.startsWith("/backend-api/models")) {
        catalogCalls++;
        return { ...validSession(), json: async () => ({ models: [{ slug: "saved-pro-slug", default_thinking_effort: "account-default", thinking_efforts: [{ thinking_effort: "instant" }, { thinking_effort: "high" }] }, { slug: "no-default" }] }) };
      }
      if (url.includes("/sentinel/chat-requirements/")) return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => url.endsWith("/prepare") ? { prepare_token: "prep", turnstile: { required: "not_required" } } : { token: "reqtok" } };
      sent.push(JSON.parse(options.body));
      return { ok: true, status: 200, headers: { get: (name) => name === "content-type" ? "text/event-stream" : null }, body: new ReadableStream({ start(controller) { controller.close(); } }) };
    },
  };
  await vm.runInNewContext(conversationScript("fresh", { model: "saved-pro-slug" }, {}), context);
  await vm.runInNewContext(conversationScript("known", { model: "no-default" }, {}), context);
  assert.equal(catalogCalls, 1);
  assert.deepEqual(sent, [{ model: "saved-pro-slug", thinking_effort: "instant" }, { model: "no-default" }]);
});

test("cancellation during lazy catalog loading prevents conversation POST", async () => {
  let finishCatalog;
  let conversationCalls = 0;
  const events = [];
  const context = {
    window: { SentinelSDK: { init: async () => undefined, token: async () => "sentinel" }, __piBridge: { send: (event) => { if (event.type !== "diagnostic") events.push(event); } } },
    document: { cookie: "oai-did=device" }, navigator: { language: "en" }, crypto: { randomUUID: () => "id" }, AbortController, TextDecoder, setTimeout, clearTimeout,
    fetch: async (url) => {
      if (url === "/api/auth/session") return validSession();
      if (url.startsWith("/backend-api/models")) return new Promise((resolve) => { finishCatalog = () => resolve({ ...validSession(), json: async () => ({ models: [{ slug: "saved" }] }) }); });
      if (url.includes("/sentinel/chat-requirements/")) return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({}) };
      conversationCalls++;
      throw new Error("POST must not run");
    },
  };
  const completion = vm.runInNewContext(conversationScript("cancel-catalog", { model: "saved" }, {}), context);
  await new Promise((resolve) => setImmediate(resolve));
  context.window.__piChatRequests.get("cancel-catalog").abort();
  finishCatalog();
  await completion;
  assert.equal(conversationCalls, 0);
  assert.match(events.at(-1).error, /cancelled/);
});

for (const [name, session, expected] of [
  ["CF HTML 200", { ...validSession("SECRET"), headers: { get: (name) => name === "content-type" ? "text/html" : null } }, /challenge/],
  ["signed out", { ...validSession("SECRET"), ok: false, status: 401 }, /expired/],
  ["anonymous JSON", { ...validSession("SECRET"), json: async () => ({ accessToken: "SECRET" }) }, /expired/],
  ["invalid JSON", { ...validSession("SECRET"), json: async () => { throw new Error("SECRET"); } }, /invalid session JSON/],
]) {
  test(`conversation rejects ${name} authentication without sending backend request`, async () => {
    const events = [];
    let conversationCalls = 0;
    await vm.runInNewContext(conversationScript("auth-fail", {}, {}), {
      window: { SentinelSDK: { init: async () => undefined, token: async () => "sentinel" }, __piBridge: { send: (event) => { if (event.type !== "diagnostic") events.push(event); } } },
      AbortController, setTimeout, clearTimeout,
      fetch: async (url) => { if (url !== "/api/auth/session") conversationCalls++; return session; },
    });
    assert.equal(conversationCalls, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.match(events[0].error, expected);
    assert.doesNotMatch(JSON.stringify(events), /SECRET/);
  });
}

function loadHost(config = {}) {
  const ipcMain = new EventEmitter();
  const created = [];
  const windows = [];
  let tick;
  const timeouts = [];
  class Window extends EventEmitter {
    constructor() {
      super();
      this.contentView = { addChildView: (view) => { this.attached = view; }, removeChildView: () => { this.attached = null; } };
      windows.push(this);
    }
    getContentSize() { return [1000, 780]; }
    focus() {}
    close() { this.emit("close"); this.emit("closed"); }
  }
  class View {
    constructor(options) {
      const wc = new EventEmitter();
      Object.assign(wc, {
        mainFrame: { url: "https://chatgpt.com/" }, getURL: () => "https://chatgpt.com/",
        id: created.length + 1, setWindowOpenHandler: (handler) => { wc.openWindow = handler; }, loadURL: async (url) => {
          wc.emit("did-start-navigation", {}, url, false, true);
          if (config.loadURL) await config.loadURL(wc);
        },
        executeJavaScript: async (code) => code.includes("pageAuthStatus") ? { loggedIn: true, state: "signed_in" } : undefined,
        close: () => { wc.closed = true; }, session: { setPermissionRequestHandler() {}, webRequest: { onBeforeSendHeaders() {}, onCompleted(_filter, handler) { wc.completed = handler; } }, clearStorageData: async () => {}, clearCache: async () => {} },
      });
      this.webContents = wc;
      this.setBounds = () => {};
      created.push({ view: this, options });
    }
  }
  let source = stripTypeScriptTypes(readFileSync(new URL("../electron/main/chatgpt-chat-view.ts", import.meta.url), "utf8"));
  source = source.replace(/^import .*;$/gm, "").replace(/export /g, "").replace(/import.meta.url/g, '"file:///main.js"');
  const context = { app: new EventEmitter(), BrowserWindow: Window, ipcMain, WebContentsView: View, join: (...parts) => parts.join("/"), getModuleDirectory: () => "/main", authStatusScript, conversationScript, streamPayload, trustedChatGptUrl, chatGptDocumentEndpoint, logChatGptDocumentEvent, logChatGptConversationEvent, URL,
    setTimeout: config.fakeTimeouts ? (callback, ms) => { const timer = { callback, ms }; timeouts.push(timer); return timer; } : setTimeout,
    clearTimeout: config.fakeTimeouts ? () => {} : clearTimeout,
    setInterval: (callback) => { tick = callback; return 1; }, clearInterval() {} };
  vm.runInNewContext(`${source}\nglobalThis.Host = ChatGptChatView`, context);
  return { host: new context.Host(), ipcMain, created, windows, timeouts, tick: () => tick() };
}

test("main validates sender and frame, routes streams, cancels and disposes", async () => {
  const { host, ipcMain, created } = loadHost();
  const events = [];
  await host.open({ requestId: "a", body: {} }, (...event) => events.push(event));
  const { view, options } = created[0];
  assert.equal(options.webPreferences.partition, "persist:chatgpt-chat");
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.offscreen, true);
  assert.equal(options.webPreferences.backgroundThrottling, false);
  const wc = view.webContents;
  const emit = (sender, senderFrame, payload) => ipcMain.emit("pi-desktop/chatgpt-chat/stream", { sender, senderFrame }, payload);
  emit({}, wc.mainFrame, { requestId: "a", type: "end" });
  emit(wc, { url: "https://chatgpt.com/" }, { requestId: "a", type: "end" });
  wc.mainFrame.url = "https://evil.test/";
  emit(wc, wc.mainFrame, { requestId: "a", type: "end" });
  wc.mainFrame.url = "https://chatgpt.com/";
  assert.equal(events.length, 0);
  emit(wc, wc.mainFrame, { requestId: "a", type: "chunk", chunk: "SSE" });
  assert.equal(events[0][0], "chatgpt.conversation.chunk");
  await host.cancel({ requestId: "a" });
  assert.equal(events.at(-1)[0], "chatgpt.conversation.error");
  emit(wc, wc.mainFrame, { requestId: "a", type: "end" });
  assert.equal(events.length, 2);
  await host.open({ requestId: "b", body: {} }, (...event) => events.push(event));
  host.dispose();
  assert.equal(events.at(-1)[1].requestId, "b");
  assert.equal(ipcMain.listenerCount("pi-desktop/chatgpt-chat/stream"), 0);
});

test("first open survives initial navigation but active streams terminate on navigation", async () => {
  const { host, created } = loadHost();
  const events = [];
  // No status/login call has initialized the view. loadURL emits navigation.
  assert.equal((await host.open({ requestId: "first", body: {} }, (...event) => events.push(event))).opened, true);
  assert.equal(events.length, 0);
  created[0].view.webContents.emit("did-start-navigation", {}, "https://chatgpt.com/#route", true, true);
  assert.equal(events.length, 0);
  created[0].view.webContents.emit("did-start-navigation", {}, "https://chatgpt.com/", false, true);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "chatgpt.conversation.error");
  assert.match(events[0][1].error, /navigated/);
  host.dispose();
});

test("login uses a temporary normal view then recreates the offscreen transport in the same partition", async () => {
  const harness = loadHost();
  const first = harness.host.login();
  const second = harness.host.login();
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.windows.length, 1);
  assert.equal(harness.windows[0].attached, harness.created[0].view);
  assert.equal(harness.created[0].options.webPreferences.offscreen, false);
  await harness.tick();
  assert.equal((await first).loggedIn, true);
  assert.equal(harness.windows[0].attached, null);
  assert.equal(harness.created[0].view.webContents.closed, true);
  assert.equal((await harness.host.status()).loggedIn, true);
  assert.equal(harness.created[1].options.webPreferences.offscreen, true);
  assert.equal(harness.created[1].options.webPreferences.partition, harness.created[0].options.webPreferences.partition);
  const reopened = harness.host.login();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.created[1].view.webContents.closed, true);
  assert.equal(harness.created[2].options.webPreferences.offscreen, false);
  harness.host.dispose();
  assert.equal((await reopened).loggedIn, false);
  assert.equal(harness.created[2].view.webContents.closed, true);
});

test("logout terminates active requests, aborts page work and clears isolated session", async () => {
  const harness = loadHost();
  const events = [];
  await harness.host.open({ requestId: "active", body: {} }, (...event) => events.push(event));
  const wc = harness.created[0].view.webContents;
  const calls = [];
  wc.executeJavaScript = async (code) => { calls.push(code); };
  wc.session.clearStorageData = async () => { calls.push("storage"); };
  wc.session.clearCache = async () => { calls.push("cache"); };
  assert.equal((await harness.host.logout()).loggedIn, false);
  assert.match(calls[0], /abort/);
  assert.deepEqual(calls.slice(1), ["storage", "cache"]);
  assert.equal(events[0][0], "chatgpt.conversation.error");
  harness.host.dispose();
});

test("opening reserves IDs and rejects concurrent duplicate requests", async () => {
  const { host } = loadHost();
  let resolveStatus;
  host.status = () => new Promise((resolve) => { resolveStatus = resolve; });
  const opening = host.open({ requestId: "same", body: {} }, () => {});
  await assert.rejects(host.open({ requestId: "same", body: {} }, () => {}), /Duplicate/);
  resolveStatus({ loggedIn: true });
  assert.equal((await opening).opened, true);
  host.dispose();
});

for (const action of ["cancel", "cancelAll", "logout", "dispose"]) {
  test(`${action} while login status is pending prevents the conversation fetch`, async () => {
    const { host, created } = loadHost();
    await host.status();
    const scripts = [];
    created[0].view.webContents.executeJavaScript = async (script) => { scripts.push(script); };
    let resolveStatus;
    host.status = () => new Promise((resolve) => { resolveStatus = resolve; });
    const events = [];
    const opening = host.open({ requestId: "opening", body: {} }, (...event) => events.push(event));
    const rejection = assert.rejects(opening, /cancelled/);
    await host[action]({ requestId: "opening" });
    resolveStatus({ loggedIn: true });
    await rejection;
    assert.equal(scripts.some((script) => script.includes("pageConversation")), false);
    assert.equal(events.length, 1);
    if (action !== "dispose") host.dispose();
  });
}

test("closing login while a status poll awaits does not close the old window twice", async () => {
  const harness = loadHost();
  const login = harness.host.login();
  await new Promise((resolve) => setImmediate(resolve));
  let resolveStatus;
  harness.host.status = () => new Promise((resolve) => { resolveStatus = resolve; });
  const polling = harness.tick();
  let closeCount = 0;
  harness.windows[0].on("close", () => { closeCount++; });
  harness.windows[0].close();
  assert.equal((await login).loggedIn, false);
  resolveStatus({ loggedIn: true });
  await polling;
  assert.equal(closeCount, 1);
  harness.host.dispose();
});

test("cancellation while browser readiness awaits prevents fetch after it resolves", async () => {
  const { host } = loadHost();
  host.status = async () => ({ loggedIn: true });
  let resolveReady;
  host.ready = () => new Promise((resolve) => { resolveReady = resolve; });
  let executed = false;
  const opening = host.open({ requestId: "ready", body: {} }, () => {});
  const rejection = assert.rejects(opening, /cancelled/);
  await new Promise((resolve) => setImmediate(resolve));
  await host.cancel({ requestId: "ready" });
  resolveReady({ webContents: { executeJavaScript: () => { executed = true; return Promise.resolve(); } } });
  await rejection;
  assert.equal(executed, false);
  host.dispose();
});

test("cancellation still emits a terminal event if page execution context disappears", async () => {
  const { host, created } = loadHost();
  const events = [];
  await host.open({ requestId: "gone", body: {} }, (...event) => events.push(event));
  created[0].view.webContents.executeJavaScript = async () => { throw new Error("execution context destroyed"); };
  await assert.rejects(host.cancel({ requestId: "gone" }), /context destroyed/);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "chatgpt.conversation.error");
  host.dispose();
});

for (const outcome of ["resolve", "reject"]) {
  test(`stale initial load ${outcome} cannot close or return a replacement view`, async () => {
    let settle;
    let loads = 0;
    const { host, created } = loadHost({ loadURL: () => {
      if (++loads === 1) return new Promise((resolve, reject) => { settle = outcome === "resolve" ? resolve : () => reject(new Error("old load failed")); });
    } });
    const first = host.ready();
    const rejected = assert.rejects(first, outcome === "resolve" ? /unavailable/ : /old load failed/);
    created[0].view.webContents.emit("render-process-gone");
    await host.ready();
    assert.equal((await host.status()).loggedIn, true);
    assert.equal(created.length, 2);
    settle();
    await rejected;
    assert.notEqual(created[1].view.webContents.closed, true);
    assert.equal((await host.status()).loggedIn, true);
    host.dispose();
  });
}

function authProbe(response, options = {}) {
  const calls = [];
  const context = {
    AbortController, setTimeout, clearTimeout, Date,
    fetch: async (endpoint) => {
      calls.push(endpoint);
      if (response instanceof Error) throw response;
      const value = endpoint === "/backend-api/me" ? (options.backend ?? { status: 401, contentType: "application/json" }) : response;
      return { ok: (value.status ?? 200) >= 200 && (value.status ?? 200) < 300, status: value.status ?? 200, redirected: value.redirected ?? false,
        headers: { get: (name) => name === "content-type" ? value.contentType ?? "application/json" : value.challenge ? "challenge" : null },
        json: async () => { if (value.invalidJson) throw new SyntaxError(); return value.json ?? {}; },
      };
    },
  };
  return { completion: vm.runInNewContext(authStatusScript(options.backendDiagnostic ?? false, options.authenticatedDiagnostic ?? false), context), calls };
}

for (const [name, response, state, reason] of [
  ["CF HTML 200", { contentType: "text/html", json: { user: { id: "ignored" } } }, "challenge", "html_or_challenge"],
  ["redirect", { redirected: true }, "checking", "login_redirect"],
  ["network failure", new Error("private network data must not escape"), "error", "network_error"],
  ["anonymous JSON", { json: {} }, "signed_out", "no_authenticated_user"],
  ["invalid JSON", { invalidJson: true }, "error", "invalid_json"],
  ["expired JSON", { json: { user: { id: "user" }, expires: "2000-01-01T00:00:00Z" } }, "signed_out", "expired_session"],
  ["authenticated session", { json: { user: { id: "user", email: "private@example.com" }, accessToken: "SECRET", expires: "2099-01-01T00:00:00Z" } }, "signed_in", "authenticated_session"],
]) {
  test(`auth probe classifies ${name} without returning account data`, async () => {
    const { completion } = authProbe(response);
    const result = await completion;
    assert.equal(result.state, state);
    assert.equal(result.loggedIn, state === "signed_in");
    assert.equal(result.diagnostic.reason, reason);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|private@|private network/);
  });
}

test("diagnostic observes cookie-only backend status without overriding valid session", async () => {
  const { completion, calls } = authProbe({ json: { user: { id: "user" }, accessToken: "SECRET" } }, { backendDiagnostic: true, backend: { status: 401 } });
  const result = await completion;
  assert.equal(result.loggedIn, true);
  assert.deepEqual(calls, ["/api/auth/session", "/backend-api/me"]);
  assert.equal(result.diagnostic.checks[1].status, 401);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test("authenticated-transition diagnostic avoids repeated backend probes while signed out", async () => {
  const anonymous = authProbe({ json: {} }, { authenticatedDiagnostic: true });
  await anonymous.completion;
  assert.deepEqual(anonymous.calls, ["/api/auth/session"]);
  const authenticated = authProbe({ json: { user: { id: "user" } } }, { authenticatedDiagnostic: true });
  await authenticated.completion;
  assert.deepEqual(authenticated.calls, ["/api/auth/session", "/backend-api/me"]);
});

test("main status coalesces concurrent probes and surfaces safe execution errors", async () => {
  const { host, created } = loadHost();
  await host.ready();
  let resolveProbe;
  let calls = 0;
  created[0].view.webContents.executeJavaScript = () => { calls++; return new Promise((resolve) => { resolveProbe = resolve; }); };
  const first = host.status();
  const second = host.status();
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  resolveProbe({ loggedIn: false, state: "challenge", diagnostic: { endpoint: "/api/auth/session", status: 200, contentType: "text/html", reason: "html_or_challenge" } });
  assert.equal((await first).state, "challenge");
  assert.equal(calls, 1);
  created[0].view.webContents.executeJavaScript = async () => { throw new Error("sensitive details"); };
  assert.equal((await host.status()).diagnostic.reason, "page_execution_error");
  host.dispose();
});

test("three login probe failures return visible error rather than pending forever", async () => {
  const harness = loadHost();
  const login = harness.host.login();
  await new Promise((resolve) => setImmediate(resolve));
  harness.host.status = async () => ({ loggedIn: false, state: "error", diagnostic: { endpoint: "/api/auth/session", status: null, contentType: null, reason: "network_error" } });
  await harness.tick(); await harness.tick(); await harness.tick();
  const result = await login;
  assert.equal(result.state, "error");
  assert.equal(result.diagnostic.reason, "network_error");
  assert.equal(harness.windows[0].attached, null);
  harness.host.dispose();
});

test("login has a finite wait for signed-out/challenge pages", async () => {
  const harness = loadHost({ fakeTimeouts: true });
  const login = harness.host.login();
  await new Promise((resolve) => setImmediate(resolve));
  harness.host.status = async () => ({ loggedIn: false, state: "challenge" });
  await harness.tick();
  harness.timeouts.find((timer) => timer.ms === 180000).callback();
  const result = await login;
  assert.equal(result.state, "error");
  assert.equal(result.diagnostic.reason, "login_timeout");
  harness.host.dispose();
});

test("login initial navigation has a bounded wait and late load cannot show a window", async () => {
  let finishLoad;
  const harness = loadHost({ fakeTimeouts: true, loadURL: () => new Promise((resolve) => { finishLoad = resolve; }) });
  const login = harness.host.login();
  harness.timeouts.find((timer) => timer.ms === 30000).callback();
  const result = await login;
  assert.equal(result.state, "error");
  assert.equal(result.diagnostic.reason, "initial_load_failed_or_timeout");
  assert.equal(harness.created[0].view.webContents.closed, true);
  finishLoad();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.windows.length, 0);
  harness.host.dispose();
});

test("initial settings status times out, releases its promise and can retry on a fresh view", async () => {
  let loads = 0;
  const harness = loadHost({ fakeTimeouts: true, loadURL: () => ++loads === 1 ? new Promise(() => {}) : Promise.resolve() });
  const first = harness.host.status();
  harness.timeouts.find((timer) => timer.ms === 30000).callback();
  const result = await first;
  assert.equal(result.state, "error");
  assert.equal(result.diagnostic.reason, "page_load_timeout");
  assert.equal(harness.created[0].view.webContents.closed, true);
  const second = harness.host.status();
  assert.notEqual(first, second);
  assert.equal((await second).loggedIn, true);
  assert.equal(harness.created.length, 2);
  harness.host.dispose();
});

test("diagnostic logging projects safe fields and deduplicates unchanged polling", () => {
  const logs = [];
  const log = createChatGptDiagnosticLogger({ log: (...args) => logs.push(args) });
  const status = { loggedIn: false, state: "challenge", message: "SECRET", accessToken: "SECRET", diagnostic: {
    endpoint: "/api/auth/session", status: 200, contentType: "text/html", reason: "html_or_challenge", rawBody: "SECRET",
    checks: [{ endpoint: "/backend-api/me", status: 401, contentType: "application/json", reason: "http_error", cookie: "SECRET" }],
  } };
  log(status); log(status);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET|cookie|accessToken|rawBody/);
  log({ ...status, state: "signed_in" });
  assert.equal(logs.length, 2);
});

test("document navigation and denied popup logs exclude query, fragment and URL credentials", async () => {
  const logs = [];
  createChatGptDiagnosticLogger({ log: (...args) => logs.push(args) });
  const { host, created } = loadHost();
  await host.ready();
  const wc = created[0].view.webContents;
  wc.emit("did-start-navigation", {}, "https://chatgpt.com/auth/login_with?email=SECRET#SECRET", false, true);
  assert.equal(wc.openWindow({ url: "https://user:SECRET@auth.openai.com/login?state=SECRET#SECRET" }).action, "deny");
  assert.equal(logs.at(-1)[4].data.endpoint, "https://auth.openai.com/login");
  assert.doesNotMatch(JSON.stringify(logs), /SECRET|email=|state=/);
  assert.equal(chatGptDocumentEndpoint("data:text/html,SECRET"), "unsupported");
  host.dispose();
});

test("document network failure exposes numeric error, ignores aborted navigation and never logs description", async () => {
  const logs = [];
  createChatGptDiagnosticLogger({ log: (...args) => logs.push(args) });
  const { host, created } = loadHost();
  await host.ready();
  const wc = created[0].view.webContents;
  wc.emit("did-fail-load", {}, -3, "SECRET", "https://chatgpt.com/auth/login_with?q=SECRET", true);
  assert.equal((await host.status()).loggedIn, true);
  wc.emit("did-fail-load", {}, -105, "SECRET", "https://auth.openai.com/login?q=SECRET", true);
  const status = await host.status();
  assert.equal(status.state, "error");
  assert.equal(status.diagnostic.reason, "document_load_failed_-105");
  assert.match(status.message, /-105/);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET/);
  assert.equal(logs.at(-1)[4].data.errorCode, -105);
  host.dispose();
});

test("main document HTTP failure is visible while subresources and other views are ignored", async () => {
  const logs = [];
  createChatGptDiagnosticLogger({ log: (...args) => logs.push(args) });
  const { host, created } = loadHost();
  await host.ready();
  const wc = created[0].view.webContents;
  const response = { webContentsId: wc.id, resourceType: "mainFrame", url: "https://chatgpt.com/auth/login_with?q=SECRET", statusCode: 500, responseHeaders: { "Content-Type": ["text/html; charset=utf-8"], "Set-Cookie": ["SECRET"] } };
  wc.completed({ ...response, resourceType: "xhr" });
  wc.completed({ ...response, webContentsId: wc.id + 1 });
  assert.equal((await host.status()).loggedIn, true);
  wc.completed(response);
  const status = await host.status();
  assert.equal(status.state, "error");
  assert.equal(status.diagnostic.status, 500);
  assert.equal(status.diagnostic.contentType, "text/html");
  assert.equal(status.diagnostic.endpoint, "https://chatgpt.com/auth/login_with");
  assert.doesNotMatch(JSON.stringify(logs), /SECRET|Set-Cookie/);
  host.dispose();
});

test("render exit returns explicit failure instead of login_cancelled", async () => {
  const logs = [];
  createChatGptDiagnosticLogger({ log: (...args) => logs.push(args) });
  const harness = loadHost();
  const login = harness.host.login();
  await new Promise((resolve) => setImmediate(resolve));
  harness.created[0].view.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  const status = await login;
  assert.equal(status.state, "error");
  assert.equal(status.diagnostic.reason, "document_render_gone");
  assert.equal(logs.at(-1)[4].data.reason, "crashed");
  harness.host.dispose();
});

test("empty document diagnostics return only counts and visible pending guidance", async () => {
  const logs = [];
  createChatGptDiagnosticLogger({ log: (...args) => logs.push(args) });
  const { host, created, timeouts } = loadHost({ fakeTimeouts: true });
  await host.ready();
  const wc = created[0].view.webContents;
  wc.executeJavaScript = async (code) => code.includes("pageAuthStatus") ? { loggedIn: false, state: "signed_out" } : { text: 0, visuals: 0 };
  wc.emit("did-finish-load");
  await timeouts.find((timer) => timer.ms === 3000).callback();
  const status = await host.status();
  assert.equal(status.state, "checking");
  assert.equal(status.diagnostic.reason, "document_empty");
  assert.match(status.message, /visible content/);
  assert.equal(logs.at(-1)[3], "ChatGPT browser document diagnostic");
  host.dispose();
});

test("failed authentication requests log endpoint and HTTP status without headers or body", async () => {
  const logs = [];
  createChatGptDiagnosticLogger({ log: (...args) => logs.push(args) });
  const { host, created } = loadHost();
  await host.ready();
  const wc = created[0].view.webContents;
  wc.completed({ webContentsId: wc.id, resourceType: "xhr", url: "https://chatgpt.com/api/auth/signin?email=SECRET#SECRET", statusCode: 403, responseHeaders: { "Set-Cookie": ["SECRET"], "Content-Type": ["SECRET"] }, responseBody: "SECRET" });
  assert.equal(logs.at(-1)[4].event, "provider.chatgpt.document.auth_response_failed");
  assert.deepEqual(logs.at(-1)[4].data, { endpoint: "https://chatgpt.com/api/auth/signin", status: 403 });
  assert.doesNotMatch(JSON.stringify(logs), /SECRET|responseBody|Content-Type|Set-Cookie/);
  assert.equal((await host.status()).loggedIn, true);
  host.dispose();
});

test("HTML403 challenge remains interactive across polls and load error until user verification navigates", async () => {
  let loads = 0;
  const harness = loadHost({ fakeTimeouts: true, loadURL: (wc) => {
    loads++;
    wc.completed({ webContentsId: wc.id, resourceType: "mainFrame", url: "https://chatgpt.com/", statusCode: 403, responseHeaders: { "Content-Type": ["text/html"] } });
    wc.emit("did-fail-load", {}, -379, "SECRET", "https://chatgpt.com/", true);
    throw new Error("HTTP response failure");
  } });
  const login = harness.host.login();
  let settled = false;
  void login.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  const wc = harness.created[0].view.webContents;
  wc.emit("did-finish-load");
  await harness.timeouts.find((timer) => timer.ms === 3000).callback();
  await harness.tick(); await harness.tick(); await harness.tick();
  assert.equal((await harness.host.status()).state, "challenge");
  assert.equal(settled, false);
  assert.equal(harness.windows[0].attached, harness.created[0].view);
  assert.equal(wc.closed, undefined);
  assert.equal(loads, 1);
  wc.emit("did-start-navigation", {}, "https://chatgpt.com/", false, true);
  await harness.tick();
  assert.equal((await login).loggedIn, true);
  harness.host.dispose();
});

for (const failure of ["network", "http"]) {
  test(`${failure} document failure can be explicitly reopened and probed without clearing partition`, async () => {
    let loads = 0;
    const harness = loadHost({ loadURL: () => { loads++; } });
    await harness.host.ready();
    const wc = harness.created[0].view.webContents;
    let clears = 0;
    wc.session.clearStorageData = async () => { clears++; };
    if (failure === "network") wc.emit("did-fail-load", {}, -105, "ignored", "https://chatgpt.com/", true);
    else wc.completed({ webContentsId: wc.id, resourceType: "mainFrame", url: "https://chatgpt.com/", statusCode: 500, responseHeaders: { "Content-Type": ["text/html"] } });
    assert.equal((await harness.host.status()).state, "error");
    const login = harness.host.login();
    await new Promise((resolve) => setImmediate(resolve));
    await harness.tick();
    assert.equal((await login).loggedIn, true);
    assert.equal(loads, 2);
    assert.equal(harness.created.length, 2);
    assert.equal(wc.closed, true);
    assert.equal(clears, 0);
    assert.equal(harness.created[0].options.webPreferences.partition, "persist:chatgpt-chat");
    harness.host.dispose();
  });
}

function transportFixture({ failure, postType = "text/event-stream", postStatus = 200, deferredToken = false, deferredInit = false } = {}) {
  const events = [];
  const actions = [];
  const timers = new Map();
  let conversationRequest;
  let chatreqRequest;
  let finalizeRequest;
  let timerId = 0;
  const page = { __piBridge: { send: (event) => events.push(event) }, screen: { width: 1440, height: 900 } };
  const sdk = {
    init: async (flow) => { actions.push(`init:${flow}`); if (deferredInit) return new Promise(() => {}); throw new Error("Chat must not invoke voice/session-observer init"); },
    token: async (flow) => { actions.push(`token:${flow}`); if (failure === "token") throw new Error("SDK_PRIVATE_SECRET token failure"); if (deferredToken) return new Promise(() => {}); return failure === "invalid_token" ? { private: "SECRET" } : "PAGE_TOKEN_SECRET"; },
  };
  const context = {
    window: page, navigator: { language: "en", languages: ["en"], userAgent: "test-agent", hardwareConcurrency: 8 }, crypto: { randomUUID: () => "id" }, AbortController, TextDecoder, TextEncoder, btoa,
    performance: { now: () => 0, timeOrigin: 0, memory: { jsHeapSizeLimit: 4294705152 } },
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; }, clearTimeout: (id) => timers.delete(id),
    document: { cookie: "oai-did=device", documentElement: { getAttribute: () => null }, createElement: () => ({}), head: { appendChild: (script) => {
      actions.push(`load:${script.src}`);
      if (failure === "load") script.onerror(); else { page.SentinelSDK = sdk; script.onload(); }
    } } },
    fetch: async (url, options) => {
      actions.push(url);
      if (failure === "fetch") throw new Error("BROWSER_PRIVATE_SECRET");
      if (url === "/api/auth/session") return validSession("SESSION_SECRET");
      if (url === "/backend-api/sentinel/chat-requirements/prepare") { chatreqRequest = options; return { ok: true, status: 200, headers: { get: (name) => name === "content-type" ? "application/json" : null }, json: async () => ({ prepare_token: "PREPARE_SECRET", so: "SO_SECRET", turnstile: { required: "not_required" }, proofofwork: { required: true, seed: "test-seed", difficulty: "ffff" } }) }; }
      if (url === "/backend-api/sentinel/chat-requirements/finalize") { finalizeRequest = options; return { ok: true, status: 200, headers: { get: (name) => name === "content-type" ? "application/json" : null }, json: async () => ({ token: "CHATREQ_SECRET" }) }; }
      conversationRequest = options;
      return { ok: postStatus >= 200 && postStatus < 300, status: postStatus, headers: { get: (name) => name === "content-type" ? postType : null }, body: postType === "text/event-stream" ? new ReadableStream({ start(controller) { controller.close(); } }) : { getReader() { throw new Error("must not read non-SSE body"); } } };
    },
  };
  return { events, actions, timers, get conversationRequest() { return conversationRequest; }, get chatreqRequest() { return chatreqRequest; }, get finalizeRequest() { return finalizeRequest; }, completion: vm.runInNewContext(conversationScript("safe-request", { messages: ["USER_BODY_SECRET"] }, {}), context) };
}

test("cold page loads official Sentinel bootstrap and acquires chat token without voice init", async () => {
  const fixture = transportFixture();
  await fixture.completion;
  assert.deepEqual(fixture.actions, ["/api/auth/session", "load:https://chatgpt.com/backend-api/sentinel/sdk.js", "token:conversation", "/backend-api/sentinel/chat-requirements/prepare", "/backend-api/sentinel/chat-requirements/finalize", "/backend-api/conversation"]);
  const diagnostics = fixture.events.filter((event) => event.type === "diagnostic");
  assert.deepEqual(diagnostics.filter((event) => event.outcome === "started").map((event) => event.stage), ["session", "sdk_load", "sdk_token", "chatreq", "post", "stream"]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /SESSION_SECRET|PAGE_TOKEN_SECRET|USER_BODY_SECRET|PREPARE_SECRET|SO_SECRET|CHATREQ_SECRET|oai-did/);
  // The finalized chat-requirements token and SO token ride on the POST; the
  // risk engine rejects conversation requests without that header group.
  assert.equal(fixture.conversationRequest.headers["OpenAI-Sentinel-Chat-Requirements-Token"], "CHATREQ_SECRET");
  assert.equal(fixture.conversationRequest.headers["OpenAI-Sentinel-SO-Token"], "SO_SECRET");
  // prepare/finalize authenticate with the session bearer token, not cookies.
  assert.equal(fixture.chatreqRequest.headers.Authorization, "Bearer SESSION_SECRET");
  // A server-issued proof-of-work challenge is solved and rides on finalize
  // and the conversation POST (official answer format: gAAAAAB + base64 + ~S).
  const proofToken = JSON.parse(fixture.finalizeRequest.body).proofofwork;
  assert.match(proofToken, /^gAAAAAB.+~S$/);
  assert.equal(fixture.conversationRequest.headers["OpenAI-Sentinel-Proof-Token"], proofToken);
  const chatreqDone = diagnostics.find((event) => event.stage === "chatreq" && event.outcome === "completed");
  assert.equal(chatreqDone.powRequested, true);
  assert.equal(chatreqDone.powSolved, true);
  assert.equal(fixture.events.at(-1).type, "end");
});

for (const [failure, stage, reason] of [["fetch", "session", "session_failed"], ["load", "sdk_load", "sdk_load_failed"], ["token", "sdk_token", "sdk_token_failed"], ["invalid_token", "sdk_token", "sdk_token_invalid"]]) {
  test(`transport ${failure} fails once with precise safe stage and no conversation request`, async () => {
    const fixture = transportFixture({ failure });
    await fixture.completion;
    const failed = fixture.events.filter((event) => event.type === "diagnostic" && event.outcome === "failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].stage, stage);
    assert.equal(failed[0].reason, reason);
    assert.equal(fixture.events.filter((event) => event.type === "error").length, 1);
    assert.equal(fixture.actions.includes("/backend-api/conversation"), false);
    assert.doesNotMatch(JSON.stringify(failed), /SECRET|synthetic/);
    assert.doesNotMatch(JSON.stringify(fixture.events), /SECRET|synthetic/);
  });
}

test("an init method that never settles cannot block the ordinary chat token path", async () => {
  const fixture = transportFixture({ deferredInit: true });
  await fixture.completion;
  assert.equal(fixture.actions.some((action) => action.startsWith("init:")), false);
  assert.equal(fixture.actions.filter((action) => action === "token:conversation").length, 1);
  assert.equal(fixture.actions.filter((action) => action === "/backend-api/conversation").length, 1);
  assert.equal(fixture.events.at(-1).type, "end");
  assert.equal(fixture.timers.size, 0);
});

test("ordinary chat only requires the token API, not an init-shaped SDK", async () => {
  let posts = 0;
  const events = [];
  await vm.runInNewContext(conversationScript("token-only", {}, {}), {
    window: { SentinelSDK: { token: async () => "page-token" }, __piBridge: { send: (event) => events.push(event) } },
    document: { cookie: "oai-did=device", createElement: () => { throw new Error("An available token SDK must not be rejected for missing init"); } },
    navigator: { language: "en" }, crypto: { randomUUID: () => "id" }, AbortController, TextDecoder, setTimeout, clearTimeout,
    fetch: async (url) => {
      if (url === "/api/auth/session") return validSession();
      if (url.includes("/sentinel/chat-requirements/")) return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => url.endsWith("/prepare") ? { prepare_token: "prep", turnstile: { required: "not_required" } } : { token: "reqtok" } };
      posts++;
      return { ok: true, status: 200, headers: { get: (name) => name === "content-type" ? "text/event-stream" : null }, body: new ReadableStream({ start(controller) { controller.close(); } }) };
    },
  });
  assert.equal(posts, 1);
  assert.equal(events.at(-1).type, "end");
});

test("pending Sentinel token has a bounded, non-retrying terminal failure", async () => {
  const fixture = transportFixture({ deferredToken: true });
  await new Promise((resolve) => setImmediate(resolve));
  [...fixture.timers.values()].find((timer) => timer.ms === 15000).callback();
  await fixture.completion;
  const failed = fixture.events.find((event) => event.type === "diagnostic" && event.outcome === "failed");
  assert.equal(failed.stage, "sdk_token");
  assert.equal(failed.reason, "sdk_token_timeout");
  assert.equal(fixture.actions.filter((action) => action === "token:conversation").length, 1);
  assert.equal(fixture.actions.includes("/backend-api/conversation"), false);
});

for (const [postType, postStatus, reason] of [["text/html", 200, "post_content_type"], ["application/json", 403, "post_http_error"]]) {
  test(`POST ${postStatus} ${postType} reports safe HTTP/format failure and never treats it as SSE`, async () => {
    const fixture = transportFixture({ postType, postStatus });
    await fixture.completion;
    const failed = fixture.events.find((event) => event.type === "diagnostic" && event.outcome === "failed");
    assert.equal(failed.stage, "post");
    assert.equal(failed.reason, reason);
    assert.equal(failed.status, postStatus);
    assert.equal(failed.contentType, postType);
    assert.equal(fixture.events.some((event) => event.type === "chunk" || event.type === "end"), false);
  });
}

test("page stage diagnostics are sender-bound, sanitized and never forwarded as runtime events", async () => {
  const logs = [];
  createChatGptDiagnosticLogger({ log: (...args) => logs.push(args) });
  const { host, created, ipcMain } = loadHost();
  const runtimeEvents = [];
  await host.open({ requestId: "diag", body: {} }, (...event) => runtimeEvents.push(event));
  const wc = created[0].view.webContents;
  ipcMain.emit("pi-desktop/chatgpt-chat/stream", { sender: wc, senderFrame: wc.mainFrame }, { requestId: "diag", type: "diagnostic", stage: "sdk_token", outcome: "failed", reason: "SECRET", contentType: "SECRET", token: "SECRET", body: "SECRET" });
  assert.equal(runtimeEvents.length, 0);
  assert.equal(logs.at(-1)[4].data.reason, "unknown");
  assert.doesNotMatch(JSON.stringify(logs), /SECRET/);
  // A bounded server-provided detail is loggable; an oversized one is dropped.
  ipcMain.emit("pi-desktop/chatgpt-chat/stream", { sender: wc, senderFrame: wc.mainFrame }, { requestId: "diag", type: "diagnostic", stage: "post", outcome: "failed", reason: "post_http_error", status: 403, detail: "Unusual activity detected from your device" });
  assert.equal(logs.at(-1)[4].data.detail, "Unusual activity detected from your device");
  assert.equal(runtimeEvents.length, 0);
  ipcMain.emit("pi-desktop/chatgpt-chat/stream", { sender: wc, senderFrame: wc.mainFrame }, { requestId: "diag", type: "diagnostic", stage: "post", outcome: "failed", reason: "post_http_error", status: 403, detail: "r".repeat(300) });
  assert.equal(logs.at(-1)[4].data.detail, undefined);
  host.dispose();
});
