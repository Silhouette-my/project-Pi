import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import vm from "node:vm";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerProviderIpc } = await import("../electron/main/ipc/provider-ipc.ts");
const { authStatusScript } = await import("../electron/main/chatgpt-chat-page.ts");
const { listChatGptChatModels } = await import("../electron/main/chatgpt-chat-models.ts");
const { api } = await import("../src/lib/api.ts");
const { IPC } = await import("@pi-desktop/shared");

function setup(t, { signedIn = true, catalogStatus = 200, style = "chatgpt_conversation" } = {}) {
  const handlers = new Map();
  const hostCalls = [];
  const consumerRequests = [];
  const row = { id: "saved-chat", apiStyle: style, authKind: "none", baseUrl: "https://chatgpt.com/backend-api" };
  let observedStatus;
  const browserPage = {
    window: {}, AbortController, setTimeout, clearTimeout,
    fetch: async (url) => {
      consumerRequests.push(url);
      if (url === "/api/auth/session") return Response.json(signedIn ? { user: { id: "fixture" }, accessToken: "page-only-fixture" } : {});
      if (url === "/backend-api/me") return Response.json({}, { status: 401 });
      if (url === "/backend-api/models?supports_model_picker_upgrade_presets=true") return Response.json({ models: [{ slug: "fixture-pro", title: "Fixture Pro" }] }, { status: catalogStatus });
      throw new Error(`Unexpected consumer request ${url}`);
    },
  };
  const browser = { executeAccountScript: async (script) => {
    observedStatus = await vm.runInNewContext(authStatusScript(true), browserPage);
    if (!observedStatus.loggedIn) throw new Error("Log in to ChatGPT in provider settings first.");
    return vm.runInNewContext(script, browserPage);
  } };
  registerProviderIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({ call: async (method, input) => {
      hostCalls.push({ method, input });
      if (method === "providers.get") return { provider: row };
      if (style !== "chatgpt_conversation" && method === "providers.testConnection") return { ok: true };
      if (style !== "chatgpt_conversation" && method === "providers.getSecret") return { value: "fixture-key" };
      throw new Error(`Unexpected Host request ${method}`);
    } }),
    modelsDevCatalog: {}, vendorOAuth: {}, logger: { app() {} },
    listRuntimeProviders: async () => [row], enrichProvider: (value) => value,
    enrichProviderList: (value) => value, bindingForModel: () => undefined,
    listChatGptModels: () => listChatGptChatModels(browser),
  });
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { invoke: async (channel, ...args) => ({ ok: true, data: await handlers.get(channel)(...args) }) } };
  t.after(() => { globalThis.window = previousWindow; });
  return { hostCalls, consumerRequests, status: () => observedStatus, row };
}

test("saved ChatGPT Test connection uses validated session and consumer catalog despite observational me401", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("generic main fetch must not run"); });
  const fixture = setup(t);
  const result = await api.testProvider("saved-chat");
  assert.deepEqual(result, { ok: true, network: "ok" });
  assert.equal(fixture.status().loggedIn, true);
  assert.equal(fixture.status().diagnostic.checks[1].status, 401);
  assert.deepEqual(fixture.hostCalls, [{ method: "providers.get", input: { id: "saved-chat" } }]);
  assert.ok(fixture.consumerRequests.includes("/backend-api/models?supports_model_picker_upgrade_presets=true"));
  assert.equal(fixture.consumerRequests.some((url) => url.includes("conversation") || url.includes("codex") || url.includes("platform")), false);
});

test("Test connection rejects signed-out ChatGPT instead of converting it to success", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("generic main fetch must not run"); });
  const fixture = setup(t, { signedIn: false });
  const result = await api.testProvider("saved-chat");
  assert.equal(result.ok, false);
  assert.equal(result.network, "failed");
  assert.match(result.message, /Log in/);
  assert.equal(fixture.consumerRequests.some((url) => url.includes("/models")), false);
});

test("Test connection reports consumer catalog failure after authenticated session", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("generic main fetch must not run"); });
  const fixture = setup(t, { catalogStatus: 503 });
  const result = await api.testProvider("saved-chat");
  assert.equal(fixture.status().loggedIn, true);
  assert.equal(result.ok, false);
  assert.equal(result.network, "failed");
  assert.match(result.message, /503/);
});

test("other API styles retain credential configuration and generic endpoint test failures", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => { requests.push(String(url)); return Response.json({}, { status: 401 }); });
  const fixture = setup(t, { style: "chat_completions" });
  const result = await api.testProvider("saved-chat");
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.ok(fixture.hostCalls.some(({ method }) => method === "providers.testConnection"));
  assert.ok(fixture.hostCalls.some(({ method }) => method === "providers.getSecret"));
  assert.equal(requests.length, 1);
  assert.equal(fixture.consumerRequests.length, 0);
});
