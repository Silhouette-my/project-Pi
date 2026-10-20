import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { useAppStore } = await import("../src/stores/app-store.ts");
const { api } = await import("../src/lib/api.ts");

test("draft chat instruction selection reaches the first send after model changes", async (t) => {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  t.after(() => { globalThis.localStorage = previousStorage; });
  const provider = {
    id: "chat", enabled: true, authKind: "none", apiStyle: "chatgpt_conversation",
    models: [{ id: "gpt-6" }, { id: "gpt-6-thinking" }],
  };
  const hostSessions = new Map();
  let nextId = 0;
  const configuredPresets = [];
  t.mock.method(api, "createSession", async (config) => {
    // The existing host creation contract does not accept promptPreset.
    const { promptPreset: _ignored, ...rest } = config;
    const session = { ...rest, id: `draft-preset-${++nextId}`, title: "Existing conversation" };
    hostSessions.set(session.id, session);
    return { session };
  });
  t.mock.method(api, "configureSession", async (id, config) => {
    configuredPresets.push(config.promptPreset);
    const session = { ...hostSessions.get(id), ...config };
    if (session.promptPreset === null) delete session.promptPreset;
    hostSessions.set(id, session);
    return { session };
  });

  for (const preset of [undefined, "none", "exploration", null]) {
    useAppStore.setState({
      providers: [provider], providerModels: {}, activeSessionId: undefined,
      sessions: [], recentModels: [], draftConfiguration: null,
      settings: { defaultProviderId: "chat", defaultModelId: "gpt-6", defaultMode: "chat" },
      workspace: null, activeProjectPath: null, messages: [], retainedSessionIds: [],
      runningSessions: {}, isRunning: false, pendingPlans: {},
    });
    const configure = (extra) => useAppStore.getState().configureActiveSession({
      mode: "chat", providerId: "chat", modelId: "gpt-6", thinkingLevel: "high", ...extra,
    });
    if (preset === null) await configure({ promptPreset: "exploration" });
    await configure({ promptPreset: preset });
    await configure({ modelId: "gpt-6-thinking" });
    assert.equal(useAppStore.getState().draftConfiguration.promptPreset, preset);
    const beforeConfigure = configuredPresets.length;
    let submitted = false;
    t.mock.method(api, "prompt", async ({ sessionId }) => {
      const persisted = hostSessions.get(sessionId);
      assert.equal(persisted.promptPreset, preset ?? undefined);
      assert.equal(persisted.modelId, "gpt-6-thinking");
      assert.equal(persisted.thinkingLevel, "high");
      assert.equal(useAppStore.getState().activeSessionId, sessionId);
      submitted = true;
      return {};
    });
    assert.equal(await useAppStore.getState().sendPrompt("Explore the options"), true);
    assert.equal(submitted, true);
    assert.equal(useAppStore.getState().draftConfiguration, null);
    assert.deepEqual(configuredPresets.slice(beforeConfigure), preset === undefined ? [] : [preset]);
  }
});

test("an active session stages preset changes without model updates clearing them", async (t) => {
  const id = "active-preset";
  useAppStore.setState({
    activeSessionId: id, sessions: [{ id, mode: "chat", promptPreset: "exploration" }],
    runningSessions: { [id]: true }, pendingPlans: {},
  });
  const configure = (extra) => useAppStore.getState().configureActiveSession({
    mode: "chat", providerId: "chat", modelId: "gpt-6-thinking", thinkingLevel: "high", ...extra,
  });
  await configure({ promptPreset: "none" });
  await configure({ promptPreset: undefined });
  assert.equal(useAppStore.getState().sessions[0].promptPreset, "none");
  await configure({ promptPreset: null });
  await configure({ modelId: "gpt-6" });
  assert.equal(useAppStore.getState().sessions[0].promptPreset, null);
  let submitted;
  t.mock.method(api, "configureSession", async (sessionId, config) => {
    assert.equal(sessionId, id);
    submitted = config;
    return { session: { id, ...config } };
  });
  useAppStore.setState({ runningSessions: {} });
  await configure({ modelId: "gpt-6-thinking" });
  assert.equal(submitted.promptPreset, null);
  assert.equal(useAppStore.getState().sessions[0].promptPreset, null);
});

test("first send stops if the selected draft preset cannot be configured", async (t) => {
  const toasts = [];
  const previousShowToast = useAppStore.getState().showToast;
  t.after(() => useAppStore.setState({ showToast: previousShowToast }));
  useAppStore.setState({
    activeSessionId: undefined, sessions: [], workspace: null, recentModels: [],
    draftConfiguration: { mode: "chat", thinkingLevel: "high", promptPreset: "exploration" },
    runningSessions: {}, pendingPlans: {}, messages: [], retainedSessionIds: [],
    showToast: (message, options) => toasts.push({ message, ...options }),
  });
  t.mock.method(api, "createSession", async (config) => ({ session: { ...config, id: "failed-preset" } }));
  t.mock.method(api, "configureSession", async () => { throw new Error("Preset configuration failed"); });
  t.mock.method(api, "prompt", async () => assert.fail("must not send with the wrong preset"));
  assert.equal(await useAppStore.getState().sendPrompt("Explore the options"), false);
  assert.equal(useAppStore.getState().draftConfiguration.promptPreset, "exploration");
  assert.deepEqual(toasts, [{ message: "Preset configuration failed", variant: "error" }]);
});
