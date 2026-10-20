import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { composerToolbar } from "./helpers/composer-toolbar.mjs";
import { slotSsr } from "./helpers/slot-ssr.mjs";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { openProjectAgentConversation, ProjectAgentNavigationCancelled } =
  await import("../src/features/project-workflow/project-agent-navigation.ts");

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function surface() {
  const selected = [];
  const prompts = [];
  let current = true;
  let state = {
    page: "project",
    projectConsoleId: "project",
    activeSessionId: "unrelated-chat",
    navIndex: 0,
    navStack: [{ page: "project", projectId: "project" }],
    refreshSessions: async () => {},
    selectSession: async (id) => {
      selected.push(id);
      state = { ...state, page: "chat", activeSessionId: id };
    },
    sendPrompt: async (text, draft, target) => {
      prompts.push({ text, draft, target });
      return true;
    },
  };
  const options = {
    open: async () => ({ sessionId: "project-agent" }),
    getState: () => state,
    isCurrent: () => current,
    openError: "Open failed",
    sendError: "Send failed; draft kept",
  };
  return {
    options, selected, prompts,
    update: (patch) => { state = { ...state, ...patch }; },
    unmount: () => { current = false; },
  };
}

test("empty-project entry opens its canonical chat, then sends only to that session", async () => {
  const s = surface();
  await openProjectAgentConversation({ ...s.options, prompt: "  Discuss the project  " });
  assert.deepEqual(s.selected, ["project-agent"]);
  assert.deepEqual(s.prompts, [{
    text: "Discuss the project",
    draft: { text: "Discuss the project", fileReferences: [] },
    target: "project-agent",
  }]);
  await openProjectAgentConversation(s.options);
  assert.equal(s.prompts.length, 1, "opening without input never starts a turn");
});

test("a newer route while project entry resolves prevents selection and submission", async () => {
  const s = surface();
  const opening = deferred();
  const pending = openProjectAgentConversation({
    ...s.options, open: () => opening.promise, prompt: "Do not send elsewhere",
  });
  s.update({ page: "settings", navIndex: 1 });
  opening.resolve({ sessionId: "project-agent" });
  await assert.rejects(pending, ProjectAgentNavigationCancelled);
  assert.deepEqual(s.selected, []);
  assert.deepEqual(s.prompts, []);
});

test("unmount and a superseding session selection both keep the initial prompt unsent", async () => {
  const unmounted = surface();
  unmounted.unmount();
  await assert.rejects(openProjectAgentConversation(unmounted.options), ProjectAgentNavigationCancelled);
  assert.deepEqual(unmounted.selected, []);
  const switched = surface();
  switched.update({
    selectSession: async () => {
      switched.update({ page: "chat", activeSessionId: "different-chat" });
    },
  });
  await assert.rejects(
    openProjectAgentConversation({ ...switched.options, prompt: "Keep this draft" }),
    ProjectAgentNavigationCancelled,
  );
  assert.deepEqual(switched.prompts, []);
});

test("open and send failures remain rejected so the overview retains its draft", async () => {
  const missing = surface();
  await assert.rejects(
    openProjectAgentConversation({ ...missing.options, open: async () => undefined }),
    /Open failed/,
  );
  assert.deepEqual(missing.selected, []);
  const failed = surface();
  failed.update({ sendPrompt: async () => false });
  await assert.rejects(
    openProjectAgentConversation({ ...failed.options, prompt: "Keep this draft" }),
    /draft kept/,
  );
});

test("project discussion reuses the model/send toolbar without mode or permission switches", async (t) => {
  const ssr = await slotSsr(t);
  const render = await composerToolbar(t, ssr, {
    discussionOnly: true,
    localToolsAllowed: false,
  });
  const html = render();
  assert.match(html, /workflow\.agentTitle/);
  assert.doesNotMatch(html, /composer-mode-menu|composer-permission/);
  assert.match(html, /composer-model/);
  assert.match(html, /aria-label="chat\.send"/);
});
