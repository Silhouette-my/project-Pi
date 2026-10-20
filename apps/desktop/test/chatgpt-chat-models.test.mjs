import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import vm from "node:vm";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerProviderIpc } = await import("../electron/main/ipc/provider-ipc.ts");
const { parseChatGptChatModels, chatGptChatModelsScript, listChatGptChatModels } = await import("../electron/main/chatgpt-chat-models.ts");
const { buildChatGptConversationBody } = await import("../../../packages/agent-runtime/dist/chatgpt-conversation.js");
const { IPC } = await import("@pi-desktop/shared");

// Synthetic slugs do not claim to identify the user's real Pro model.
const rawCatalog = {
  default_model_slug: "fixture-default-slug",
  models: [
    { slug: "fixture-pro-request-slug", title: "Fixture Pro", description: "Synthetic account model", default_thinking_effort: "fixture-effort", internalCredential: "must-not-leave-page" },
    { slug: "fixture-default-slug", title: "Fixture Chat" },
  ],
  accessToken: "must-not-leave-page",
};

test("consumer catalog preserves request slugs, default and names without exposing other fields", () => {
  const catalog = parseChatGptChatModels(rawCatalog);
  assert.deepEqual(catalog, {
    models: [
      { id: "fixture-pro-request-slug", name: "Fixture Pro", description: "Synthetic account model", defaultThinkingEffort: "fixture-effort" },
      { id: "fixture-default-slug", name: "Fixture Chat" },
    ], defaultModelId: "fixture-default-slug",
  });
  assert.ok(!JSON.stringify(catalog).includes("must-not-leave-page"));
  const body = buildChatGptConversationBody(catalog.models[0].id, [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }]);
  assert.equal(body.model, "fixture-pro-request-slug");
  assert.equal(body.requested_default_model, "fixture-pro-request-slug");
});

test("empty or invalid account catalogs fail instead of inventing a static model", () => {
  for (const value of [{}, { models: [] }, { models: [{ title: "6 Pro" }] }, { models: [null] }]) {
    assert.throws(() => parseChatGptChatModels(value), /ChatGPT/);
  }
});

test("browser catalog uses consumer endpoint and keeps session authorization in the page", async () => {
  const requests = [];
  const page = {};
  const result = await listChatGptChatModels({ executeAccountScript: (script) => vm.runInNewContext(script, {
    AbortController, setTimeout, clearTimeout, window: page,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return Response.json(url === "/api/auth/session" ? { user: { id: "fixture-user" }, accessToken: "page-only-secret" } : rawCatalog);
    },
  }) });
  assert.deepEqual(requests.map(({ url }) => url), ["/api/auth/session", "/backend-api/models?supports_model_picker_upgrade_presets=true"]);
  assert.equal(requests[1].options.headers.Authorization, "Bearer page-only-secret");
  assert.equal(requests[1].options.credentials, "include");
  assert.ok(!JSON.stringify(result).includes("page-only-secret"));
  assert.equal(result.models[0].id, "fixture-pro-request-slug");
  assert.equal(page.__piChatModelDefaults.get("fixture-pro-request-slug"), "fixture-effort");
});

test("Cloudflare HTML200 and account errors do not become a model catalog", async () => {
  for (const response of [new Response("challenge", { headers: { "content-type": "text/html" } }), Response.json({}, { status: 401 })]) {
    let count = 0;
    await assert.rejects(vm.runInNewContext(chatGptChatModelsScript(), {
      AbortController, setTimeout, clearTimeout,
      fetch: async () => ++count === 1 ? Response.json({ user: { id: "fixture-user" }, accessToken: "page-only-secret" }) : response,
    }), /ChatGPT/);
  }
});

test("setup and saved refresh use account models; cached reads do not access the account", async () => {
  const handlers = new Map();
  const row = { id: "chat", apiStyle: "chatgpt_conversation", hasSecret: false };
  const catalog = parseChatGptChatModels(rawCatalog);
  let accountReads = 0;
  let cached = [];
  registerProviderIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({ call: async (method, input) => {
      if (method === "providers.list") return { providers: [row] };
      if (method === "providers.cacheModels") { cached = input.models; return {}; }
      if (method === "providers.listModels") return { models: cached };
      throw new Error(`Unexpected Host call ${method}`);
    } }),
    modelsDevCatalog: { configureAccount() {} },
    vendorOAuth: {}, logger: { app() {} },
    listRuntimeProviders: async () => [row],
    enrichProvider: (provider) => provider,
    enrichProviderList: (providers) => providers,
    bindingForModel: () => undefined,
    listChatGptModels: async () => { accountReads++; return catalog; },
  });
  for (const request of [
    { apiStyle: "chatgpt_conversation" },
    { providerId: "chat", source: "refresh" },
  ]) {
    const result = await handlers.get(IPC.invoke.providersListModels)(request);
    assert.equal(result.source, "remote");
    assert.deepEqual(result.models.map((model) => model.modelId), ["fixture-default-slug", "fixture-pro-request-slug"]);
    assert.equal(result.models[1].displayName, "Fixture Pro");
  }
  const cachedResult = await handlers.get(IPC.invoke.providersListModels)({ providerId: "chat", source: "cache" });
  assert.equal(cachedResult.source, "cache");
  assert.equal(accountReads, 2);
  assert.equal(cachedResult.models[1].modelId, "fixture-pro-request-slug");
});
