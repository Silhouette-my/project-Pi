/** Configure a custom OpenAI-compatible endpoint that does not require a key. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const fixtureSource = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { ProviderSetupDialog } from "../../apps/desktop/src/components/settings/ProviderSetupDialog";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const calls = [];
let createdProvider = null;
let updatedProvider = null;
let updateInput = null;
let savedCallback = false;
let chatgptAccountStatus = { loggedIn: false, state: "signed_out" };
let chatgptLoginStarted = false;
let resolveChatgptLogin;
let chatgptCatalogCalls = 0;
let providerTestResult = { ok: true, network: "ok" };
window.addEventListener("error", (event) => {
  console.error("CUSTOM_PROVIDER_NO_KEY_WINDOW_ERROR", event.error?.stack ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("CUSTOM_PROVIDER_NO_KEY_REJECTION", event.reason?.stack ?? event.reason);
});

window.piDesktop = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, ...args) {
    const input = args[0];
    calls.push({ channel, input });
    if (channel === "pi-desktop/plugin/providerCatalog") {
      return { ok: true, data: [] };
    }
    if (channel === "pi-desktop/chatgptChat/status") {
      return { ok: true, data: chatgptAccountStatus };
    }
    if (channel === "pi-desktop/chatgptChat/login") {
      chatgptLoginStarted = true;
      return new Promise((resolve) => { resolveChatgptLogin = resolve; });
    }
    if (channel === "pi-desktop/chatgptChat/importLogin") {
      chatgptAccountStatus = { loggedIn: true, state: "signed_in" };
      return { ok: true, data: chatgptAccountStatus };
    }
    if (channel === "pi-desktop/chatgptChat/logout") {
      chatgptAccountStatus = { loggedIn: false, state: "signed_out" };
      return { ok: true, data: undefined };
    }
    if (channel === "pi-desktop/providers/listModels") {
      if (input.apiStyle === "chatgpt_conversation") {
        if (!chatgptAccountStatus.loggedIn) {
          return { ok: true, data: { models: [], source: "remote" } };
        }
        chatgptCatalogCalls += 1;
        return {
          ok: true,
          data: {
            models: [{
              modelId: "fixture-pro-request-slug",
              displayName: "Fixture Pro",
              providerId: "custom",
              toolCall: true,
              capabilities: ["text", "tools"],
              source: "discovered",
            }],
            source: "remote",
          },
        };
      }
      return { ok: true, data: { models: [], source: "remote" } };
    }
    if (channel === "pi-desktop/providers/lookupModel") {
      return { ok: true, data: { info: null } };
    }
    if (channel === "pi-desktop/providers/testConnection") {
      return { ok: true, data: providerTestResult };
    }
    if (channel === "pi-desktop/providers/create") {
      createdProvider = {
        id: "custom:no-auth",
        ...input,
        enabled: true,
        hasSecret: false,
        createdAt: "2026-10-13T00:00:00.000Z",
        updatedAt: "2026-10-13T00:00:00.000Z",
      };
      return { ok: true, data: { provider: createdProvider } };
    }
    if (channel === "pi-desktop/providers/update") {
      updateInput = input;
      updatedProvider = {
        ...createdProvider,
        ...input,
        hasSecret: input.authKind === "none" ? false : Boolean(input.secretValue) || createdProvider.hasSecret,
      };
      return { ok: true, data: { provider: updatedProvider } };
    }
    throw new Error("Unexpected fixture IPC: " + channel);
  },
};

await i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});
useAppStore.setState({ providers: [] });

const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
async function waitFor(predicate, message, maxAttempts = 120) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await settle();
    const value = predicate();
    if (value) return value;
  }
  throw new Error(message);
}
function setValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

const rootNode = createRoot(document.getElementById("root"));
function mount(element) { flushSync(() => rootNode.render(element)); }

window.customProviderNoApiKeyProbe = async () => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const button = (label) => [...document.querySelectorAll("button")]
    .find((item) => item.getAttribute("aria-label") === label || item.textContent.trim() === label);
  const keyField = () => document.querySelector('input[type="password"]');
  const edit = (provider, key) => {
    updateInput = null;
    updatedProvider = null;
    mount(React.createElement(ProviderSetupDialog, {
      key,
      provider,
      onClose: () => mount(null),
      onSaved: () => {},
    }));
  };
  const saveEdit = async () => {
    flushSync(() => button("Save provider").click());
    await waitFor(() => updateInput && updatedProvider, "the provider edit was not saved");
    return structuredClone(updateInput);
  };
  mount(React.createElement(ProviderSetupDialog, {
    key: "new-provider",
    provider: null,
    onClose: () => mount(null),
    onSaved: () => { savedCallback = true; },
  }));
  const customTile = await waitFor(
    () => document.querySelector('[data-service-id="custom"]'),
    "the custom endpoint service was not offered",
  );
  flushSync(() => customTile.click());
  check(!document.querySelector('[role="switch"][aria-label="No API key required"]'),
    "the obsolete no-key switch is still present");
  check(keyField() && !keyField().disabled, "the optional API-key input is not enabled");
  const nameField = [...document.querySelectorAll("label")]
    .find((label) => label.textContent.includes("Name"))?.querySelector("input");
  const urlField = document.querySelector('input[type="url"]');
  check(nameField && urlField, "the custom endpoint identity fields were missing");
  setValue(nameField, "No Auth Gateway");
  setValue(urlField, "https://no-auth.example.org/v1");
  const discoveryCall = await waitFor(
    () => calls.find((call) => call.channel === "pi-desktop/providers/listModels"
      && call.input.baseUrl === "https://no-auth.example.org/v1"),
    "the custom endpoint was not probed without an API key",
  );
  const modelField = document.querySelector('input[placeholder^="Enter a model ID"]');
  check(modelField, "the custom model input was missing");
  setValue(modelField, "no-auth-chat");
  flushSync(() => button("Add custom model").click());
  await waitFor(
    () => document.querySelector(".provider-chosen")?.innerText.includes("no-auth-chat"),
    "the model was not added to the custom provider",
  );
  // A whitespace-only key has the same meaning as an empty key.
  flushSync(() => setValue(keyField(), "   "));
  flushSync(() => button("Save provider").click());
  await waitFor(() => savedCallback && createdProvider, "the custom provider was not saved");
  const noAuthProvider = structuredClone(createdProvider);
  check(noAuthProvider.authKind === "none" && !Object.hasOwn(noAuthProvider, "secretValue"),
    "an empty API key did not automatically save as no-auth");

  edit(noAuthProvider, "edit-no-auth-unchanged");
  const unchangedNoAuth = await saveEdit();
  check(!Object.hasOwn(unchangedNoAuth, "authKind") && !Object.hasOwn(unchangedNoAuth, "secretValue"),
    "reopening and saving a no-auth provider changed its authentication");

  edit(noAuthProvider, "edit-no-auth-add-key");
  check(!keyField().disabled, "a no-auth provider cannot accept an API key");
  flushSync(() => setValue(keyField(), "  saved-api-key  "));
  const keyedUpdate = await saveEdit();
  check(keyedUpdate.authKind === "api_key_and_base_url" && keyedUpdate.secretValue === "saved-api-key",
    "typing a key did not switch the no-auth provider to API-key authentication");
  createdProvider = structuredClone(updatedProvider);
  const keyedProvider = structuredClone(createdProvider);

  edit(keyedProvider, "edit-keyed-keep-key");
  const keepKeyUpdate = await saveEdit();
  check(!Object.hasOwn(keepKeyUpdate, "authKind") && !Object.hasOwn(keepKeyUpdate, "secretValue"),
    "an untouched empty input overwrote the saved key");

  edit(keyedProvider, "edit-keyed-clear-and-cancel");
  const clearButton = button("Clear saved API key");
  check(clearButton, "the saved-key removal action was missing");
  check(clearButton.textContent.trim() === "" && clearButton.querySelector('svg[aria-hidden="true"]'),
    "the saved-key removal action is not an accessible icon-only button");
  const inputRect = keyField().getBoundingClientRect();
  const clearRect = clearButton.getBoundingClientRect();
  check(clearRect.left >= inputRect.right && clearRect.top < inputRect.bottom
    && clearRect.bottom > inputRect.top, "the clear icon is not beside the API-key input");
  check(clearRect.width >= 24 && clearRect.height >= 24, "the clear icon target is too small");
  flushSync(() => clearButton.click());
  check(document.activeElement === keyField(), "clearing the key did not focus its input");
  check(!updateInput, "clearing a key persisted before Save");
  check(keyField().value === "" && !keyField().disabled, "clearing a saved key disabled the input");
  const afterClear = calls.length;
  const clearProbe = await waitFor(
    () => calls.slice(afterClear).find((call) => call.channel === "pi-desktop/providers/listModels"
      && call.input.baseUrl === keyedProvider.baseUrl && call.input.source !== "cache"),
    "clearing the saved key did not refresh model discovery",
  );
  check(!Object.hasOwn(clearProbe.input, "providerId") && !Object.hasOwn(clearProbe.input, "apiKey"),
    "model discovery reused a saved key after it was cleared");
  mount(null);
  check(!updateInput, "closing the form after Clear changed the saved key");

  edit(keyedProvider, "edit-keyed-clear-and-replace");
  flushSync(() => button("Clear saved API key").click());
  flushSync(() => setValue(keyField(), "replacement-api-key"));
  const replacementUpdate = await saveEdit();
  check(replacementUpdate.authKind !== "none" && replacementUpdate.secretValue === "replacement-api-key",
    "a replacement key was discarded after Clear");

  edit(keyedProvider, "edit-keyed-clear-and-save");
  flushSync(() => button("Clear saved API key").click());
  const clearedUpdate = await saveEdit();
  check(clearedUpdate.authKind === "none" && !Object.hasOwn(clearedUpdate, "secretValue"),
    "clearing and saving did not switch to no-auth");
  check(updatedProvider.hasSecret === false, "the cleared provider is still marked as credentialed");

  const missingKeyProvider = { ...keyedProvider, hasSecret: false };
  edit(missingKeyProvider, "edit-keyed-missing-key");
  const missingKeyUpdate = await saveEdit();
  check(missingKeyUpdate.authKind === "none" && !Object.hasOwn(missingKeyUpdate, "secretValue"),
    "an existing custom provider without a stored key did not become no-auth");

  mount(React.createElement(ProviderSetupDialog, {
    key: "new-keyed-provider",
    provider: null,
    initialDraft: {
      name: "Key Gateway",
      baseUrl: keyedProvider.baseUrl,
      apiStyle: "chat_completions",
      models: keyedProvider.models,
    },
    onClose: () => mount(null),
    onSaved: () => {},
  }));
  flushSync(() => setValue(keyField(), "new-api-key"));
  createdProvider = null;
  flushSync(() => button("Save provider").click());
  await waitFor(() => createdProvider, "the new keyed provider was not saved");
  check(createdProvider.authKind === "api_key_and_base_url" && createdProvider.secretValue === "new-api-key",
    "a new custom provider with an API key did not retain API-key authentication");

  let chatgptSaved = false;
  mount(React.createElement(ProviderSetupDialog, {
    key: "chatgpt-provider",
    provider: null,
    onClose: () => mount(null),
    onSaved: () => { chatgptSaved = true; },
  }));
  const chatgptTile = await waitFor(
    () => document.querySelector('[data-service-id="chatgpt-chat"]'),
    "the direct ChatGPT Chat service option was missing",
  );
  flushSync(() => chatgptTile.click());
  const chatgptBaseUrl = await waitFor(
    () => document.querySelector('input[type="url"]')?.value === "https://chatgpt.com/backend-api",
    "selecting the ChatGPT format did not fill its base URL",
  );
  const chatgptEndpointFixed = document.querySelector('input[type="url"]')?.disabled === true;
  const apiKeyHidden = !document.querySelector('input[type="password"]')
    && !document.querySelector('[role="switch"][aria-label="No API key required"]');
  const initialChatgptStatus = await waitFor(
    () => document.querySelector('[role="status"]')?.textContent.includes("not connected"),
    "the ChatGPT login status was not shown",
  );
  const chatgptLoginButton = [...document.querySelectorAll("button")]
    .find((button) => button.textContent.includes("Log in to ChatGPT"));
  if (!chatgptLoginButton) throw new Error("the ChatGPT login action was missing");
  flushSync(() => chatgptLoginButton.click());
  chatgptAccountStatus = {
    loggedIn: false,
    state: "checking",
    message: "Waiting for authentication redirect.",
  };
  const chatgptRedirectWaitVisible = await waitFor(
    () => [...document.querySelectorAll('[role="status"]')]
      .some((node) => node.textContent.includes("Waiting for authentication redirect")),
    "the pending login redirect message was not shown",
    240,
  );
  chatgptAccountStatus = {
    loggedIn: false,
    state: "challenge",
    message: "Finish sign-in in the ChatGPT window.",
  };
  const chatgptChallengeVisible = await waitFor(
    () => document.querySelector('[role="alert"]')?.textContent.includes("Finish sign-in"),
    "the pending login challenge did not update the settings status",
    240,
  );
  const loginStillPending = chatgptLoginStarted && typeof resolveChatgptLogin === "function";
  chatgptAccountStatus = { loggedIn: true, state: "signed_in" };
  const chatgptLoginUpdatedStatus = await waitFor(
    () => document.querySelector('[role="status"]')?.textContent.includes("account connected"),
    "the ChatGPT login action did not update the status",
    240,
  );
  const refreshedCatalog = await waitFor(
    () => chatgptCatalogCalls > 0
      && document.querySelector(".provider-models-row-name")?.textContent === "Fixture Pro"
      && document.querySelector(".provider-chosen-row-id")?.textContent === "fixture-pro-request-slug",
    "the account model catalog was not reloaded and selected after login",
    240,
  );
  resolveChatgptLogin?.({ ok: true, data: { loggedIn: true, state: "signed_in" } });
  const modelCheckbox = document.querySelector(".provider-models-row input[type=checkbox]");
  if (!modelCheckbox?.checked) throw new Error("the discovered ChatGPT model was not preselected");
  flushSync(() => modelCheckbox.click());
  await waitFor(
    () => !document.querySelector(".provider-chosen-row-id"),
    "the account model could not be deselected",
  );
  flushSync(() => modelCheckbox.click());
  const chatgptNameField = [...document.querySelectorAll("label")]
    .find((label) => label.textContent.includes("Name"))
    ?.querySelector("input");
  if (!chatgptNameField) throw new Error("the ChatGPT provider name field was missing");
  setValue(chatgptNameField, "ChatGPT Subscription");
  await waitFor(
    () => document.querySelector(".provider-chosen-row-id")?.textContent === "fixture-pro-request-slug",
    "the refreshed account catalog model was not selected for the ChatGPT provider",
  );
  const chatgptSaveButton = [...document.querySelectorAll("button")]
    .find((button) => button.textContent.trim() === "Save provider");
  if (!chatgptSaveButton) throw new Error("the ChatGPT provider save action was missing");
  flushSync(() => chatgptSaveButton.click());
  await waitFor(() => chatgptSaved && createdProvider?.apiStyle === "chatgpt_conversation",
    "the ChatGPT provider was not saved");
  const chatgptSavedWithoutKey = createdProvider.authKind === "none"
    && !Object.hasOwn(createdProvider, "secretValue")
    && createdProvider.baseUrl === "https://chatgpt.com/backend-api"
    && createdProvider.models?.[0]?.id === "fixture-pro-request-slug";

  const chatgptLogoutButton = [...document.querySelectorAll("button")]
    .find((button) => button.textContent.trim() === "Log out");
  if (!chatgptLogoutButton) throw new Error("the ChatGPT logout action was missing");
  flushSync(() => chatgptLogoutButton.click());
  const chatgptLogoutUpdatedStatus = await waitFor(
    () => document.querySelector('[role="status"]')?.textContent.includes("not connected"),
    "the ChatGPT logout action did not update the status",
  );
  const catalogCallsBeforeRelogin = chatgptCatalogCalls;
  const reloginButton = [...document.querySelectorAll("button")]
    .find((button) => button.textContent.includes("Import previous Pi Chat login"));
  if (!reloginButton) throw new Error("the ChatGPT import action was missing");
  flushSync(() => reloginButton.click());
  const chatgptLoginCompletionRefreshed = await waitFor(
    () => chatgptCatalogCalls > catalogCallsBeforeRelogin
      && document.querySelector('[role="status"]')?.textContent.includes("account connected"),
    "a completed login did not refresh the account model catalog",
  );

  const testToasts = [];
  useAppStore.setState({ showToast: (message, options) => testToasts.push({ message, ...options }) });
  mount(React.createElement(ProviderSetupDialog, {
    key: "saved-chatgpt-test-connection", provider: createdProvider,
    onClose: () => mount(null), onSaved() {},
  }));
  const testButton = await waitFor(
    () => [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Test connection"),
    "the saved ChatGPT provider Test connection action was missing",
  );
  flushSync(() => testButton.click());
  await waitFor(() => testToasts.some((toast) => toast.variant === "success") && !testButton.disabled,
    "the successful ChatGPT connection test was not shown");
  const chatgptTestSavedProviderId = calls.some((call) => call.channel === "pi-desktop/providers/testConnection" && call.input === createdProvider.id);
  providerTestResult = { ok: false, network: "failed", message: "Fixture ChatGPT login required" };
  flushSync(() => testButton.click());
  await waitFor(() => testToasts.some((toast) => toast.message === providerTestResult.message && toast.variant === "error") && !testButton.disabled,
    "the signed-out ChatGPT connection failure was not shown");
  providerTestResult = { ok: false, network: "failed", message: "Fixture account catalog failed HTTP 503" };
  flushSync(() => testButton.click());
  await waitFor(() => testToasts.some((toast) => toast.message === providerTestResult.message && toast.variant === "error") && !testButton.disabled,
    "the ChatGPT catalog connection failure was not shown");

  return {
    discoveryOmittedApiKey: !Object.hasOwn(discoveryCall.input, "apiKey"),
    chatgptBaseUrl,
    chatgptEndpointFixed,
    chatgptApiKeyHidden: apiKeyHidden,
    chatgptStatusShown: Boolean(initialChatgptStatus),
    chatgptLoginUpdatedStatus: Boolean(chatgptLoginUpdatedStatus),
    chatgptLoginRemainedPendingWhileStatusUpdated: loginStillPending && Boolean(chatgptChallengeVisible),
    chatgptRedirectWaitVisible: Boolean(chatgptRedirectWaitVisible),
    chatgptCatalogRefreshed: Boolean(refreshedCatalog),
    chatgptLogoutUpdatedStatus: Boolean(chatgptLogoutUpdatedStatus),
    chatgptLoginCompletionRefreshed: Boolean(chatgptLoginCompletionRefreshed),
    chatgptSavedWithoutKey,
    chatgptTestSavedProviderId,
    chatgptTestSuccessToast: testToasts.some((toast) => toast.variant === "success"),
    chatgptTestSignedOutFailureToast: testToasts.some((toast) => toast.message === "Fixture ChatGPT login required" && toast.variant === "error"),
    chatgptTestCatalogFailureToast: testToasts.some((toast) => toast.message === "Fixture account catalog failed HTTP 503" && toast.variant === "error"),
    savedAuthKind: noAuthProvider.authKind,
    selectedModel: noAuthProvider.models?.[0]?.id,
    noAuthReopenPreserved: true,
    typedKeyEnablesAuth: true,
    blankEditPreservesKey: true,
    clearDiscoveryOmitsStoredKey: true,
    cancelledClearPreservesKey: true,
    clearThenReplaceSavesKey: true,
    clearThenSaveRemovesKey: true,
    missingKeyBecomesNoAuth: true,
    newKeyedProviderPreserved: true,
  };
};
`;

test("a custom endpoint can be saved and selected without an API key", {
  timeout: 60_000,
  skip:
    process.platform === "linux" && !process.env.DISPLAY
      ? "Isolated Electron UI test requires a display"
      : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.custom-provider-no-api-key-ui-"));
  try {
    await build({
      stdin: {
        contents: fixtureSource,
        resolveDir: join(root, "scripts", "e2e"),
        sourcefile: join(root, "scripts", "e2e", "custom-provider-no-api-key.jsx"),
        loader: "tsx",
      },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    const styles = await Promise.all(
      ["tokens", "base", "ui-kit", "settings", "composer", "providers", "model-config"].map(
        (name) => readFile(join(root, "apps/desktop/src/styles/" + name + ".css"), "utf8"),
      ),
    );
    await writeFile(join(temp, "style.css"), styles.join("\n").replace(/@theme(?: inline)?/g, ":root"));
    await writeFile(
      join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="style.css"><body><div id="root"></div><script type="module" src="renderer.js"></script>',
    );
    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.customProviderNoApiKeyProbe()");
    console.log("CUSTOM_PROVIDER_NO_API_KEY_PROBE " + JSON.stringify(result));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});
`,
    );

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
        child.once("close", (exitCode, signal) => {
          if (exitCode === null) output += `\nElectron exited from signal ${signal}`;
          resolve(exitCode);
        });
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/)
      .find((item) => item.startsWith("CUSTOM_PROVIDER_NO_API_KEY_PROBE "));
    assert(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("CUSTOM_PROVIDER_NO_API_KEY_PROBE ".length)), {
      discoveryOmittedApiKey: true,
      savedAuthKind: "none",
      selectedModel: "no-auth-chat",
      chatgptBaseUrl: true,
      chatgptEndpointFixed: true,
      chatgptApiKeyHidden: true,
      chatgptStatusShown: true,
      chatgptLoginUpdatedStatus: true,
      chatgptLoginRemainedPendingWhileStatusUpdated: true,
      chatgptRedirectWaitVisible: true,
      chatgptCatalogRefreshed: true,
      chatgptLogoutUpdatedStatus: true,
      chatgptLoginCompletionRefreshed: true,
      chatgptSavedWithoutKey: true,
      chatgptTestSavedProviderId: true,
      chatgptTestSuccessToast: true,
      chatgptTestSignedOutFailureToast: true,
      chatgptTestCatalogFailureToast: true,
      noAuthReopenPreserved: true,
      typedKeyEnablesAuth: true,
      blankEditPreservesKey: true,
      clearDiscoveryOmitsStoredKey: true,
      cancelledClearPreservesKey: true,
      clearThenReplaceSavesKey: true,
      clearThenSaveRemovesKey: true,
      missingKeyBecomesNoAuth: true,
      newKeyedProviderPreserved: true,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
