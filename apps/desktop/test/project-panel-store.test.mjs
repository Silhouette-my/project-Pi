import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createWorkPanelSlice, switchWorkPanelPage, switchWorkPanelSession } = await import(
  "../src/stores/slices/work-panel-slice.ts"
);
const { projectAgentWorkPanelTab, projectSideWorkPanelTab, wasProjectAgentTabClosed, forgetProjectAgentTabClosed } = await import(
  "../src/lib/project-panel.ts"
);

const review = { id: "review", kind: "review" };
const agent = projectAgentWorkPanelTab("p1");
const side = projectSideWorkPanelTab("child");

function chatState() {
  return {
    page: "chat",
    projectConsoleId: undefined,
    activeSessionId: "s1",
    workPanelOpen: true,
    workPanelTabs: [review],
    activeWorkPanelTabId: "review",
    workPanelFileRequest: null,
    workPanelContexts: {
      s1: { open: true, tabs: [review], activeTabId: "review", fileRequest: null },
    },
  };
}

test("entering the project page swaps in the project context and leaving restores the session's", () => {
  const chat = chatState();
  const toProject = { ...chat, page: "project", projectConsoleId: "p1" };
  const entered = switchWorkPanelPage(toProject, { page: "chat", projectConsoleId: undefined });
  assert.ok(entered);
  assert.deepEqual(entered.workPanelTabs, []);
  assert.equal(entered.workPanelOpen, false);
  assert.deepEqual(entered.workPanelContexts.s1.tabs, [review], "the session context is retained");

  // The project context gains tabs while it is presented.
  const onProject = {
    ...toProject,
    ...entered,
    workPanelOpen: true,
    workPanelTabs: [agent, side],
    activeWorkPanelTabId: side.id,
  };
  const back = switchWorkPanelPage(
    { ...onProject, page: "chat", projectConsoleId: undefined },
    { page: "project", projectConsoleId: "p1" },
  );
  assert.ok(back);
  assert.deepEqual(back.workPanelTabs, [review]);
  assert.equal(back.workPanelOpen, true);
  assert.deepEqual(back.workPanelContexts["project:p1"].tabs, [agent, side]);
  assert.equal(back.workPanelContexts["project:p1"].activeTabId, side.id);

  // And into the project again: nothing was lost.
  const again = switchWorkPanelPage(
    { ...onProject, ...back, page: "project", projectConsoleId: "p1" },
    { page: "chat", projectConsoleId: undefined },
  );
  assert.deepEqual(again.workPanelTabs, [agent, side]);
  assert.equal(again.activeWorkPanelTabId, side.id);
});

test("a page change that keeps the same context kind leaves the projection alone", () => {
  const chat = chatState();
  assert.equal(
    switchWorkPanelPage({ ...chat, page: "settings" }, { page: "chat", projectConsoleId: undefined }),
    undefined,
  );
  assert.equal(
    switchWorkPanelPage({ ...chat, page: "chat" }, { page: "chat", projectConsoleId: undefined }),
    undefined,
  );
});

test("moving between two projects swaps their contexts", () => {
  const first = {
    ...chatState(),
    page: "project",
    projectConsoleId: "p1",
    workPanelTabs: [agent],
    activeWorkPanelTabId: agent.id,
    workPanelContexts: { "project:p1": { open: true, tabs: [agent], activeTabId: agent.id, fileRequest: null } },
  };
  const swapped = switchWorkPanelPage({ ...first, projectConsoleId: "p2" }, { page: "project", projectConsoleId: "p1" });
  assert.deepEqual(swapped.workPanelTabs, []);
  assert.deepEqual(swapped.workPanelContexts["project:p1"].tabs, [agent]);
});

test("a session change underneath the project page does not disturb the project context", () => {
  const onProject = {
    ...chatState(),
    page: "project",
    projectConsoleId: "p1",
    workPanelOpen: true,
    workPanelTabs: [agent],
    activeWorkPanelTabId: agent.id,
  };
  const result = switchWorkPanelSession(onProject, "s2");
  assert.deepEqual(result.workPanelTabs, [agent]);
  assert.equal(result.workPanelOpen, true);
  assert.equal(result.activeWorkPanelTabId, agent.id);
  assert.equal(result.workPanelContexts.s1.tabs[0].id, "review", "session contexts are untouched");

  // On the chat page the switch is the ordinary per-session one (ADR 0028).
  const chat = chatState();
  const chatResult = switchWorkPanelSession(chat, "s2");
  assert.deepEqual(chatResult.workPanelTabs, []);
  assert.deepEqual(chatResult.workPanelContexts.s1.tabs, [review]);
});

test("bulk tab closing updates the presented project context, not the chat beneath it", () => {
  for (const closeAll of [false, true]) {
    forgetProjectAgentTabClosed();
    const chat = chatState();
    const chatContext = chat.workPanelContexts.s1;
    let state = {
      ...chat,
      page: "project",
      projectConsoleId: "p1",
      workPanelTabs: [agent, side, review],
      activeWorkPanelTabId: agent.id,
      workPanelContexts: {
        ...chat.workPanelContexts,
        "project:p1": { open: true, tabs: [agent, side, review], activeTabId: agent.id, fileRequest: null },
      },
    };
    const actions = createWorkPanelSlice({
      get: () => state,
      set: (update) => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; },
      isSessionSelectionPending: () => false,
    });
    if (closeAll) actions.closeAllWorkPanelTabs();
    else actions.closeOtherWorkPanelTabs("review");
    assert.equal(state.workPanelContexts.s1, chatContext, "the underlying chat retains its context");
    assert.deepEqual(state.workPanelTabs.map((tab) => tab.id), closeAll ? [] : ["review"]);
    assert.deepEqual(state.workPanelContexts["project:p1"].tabs, state.workPanelTabs);
    assert.equal(wasProjectAgentTabClosed("project:p1"), true);
    assert.equal(wasProjectAgentTabClosed("s1"), false);
  }
  forgetProjectAgentTabClosed();
});

test("restoring a session browser does not merge the project panel into its underlying chat", () => {
  const chat = chatState();
  const projectContext = { open: true, tabs: [agent, side], activeTabId: side.id, fileRequest: null };
  let state = {
    ...chat,
    page: "project",
    projectConsoleId: "p1",
    sessions: [{ id: "s1" }],
    workPanelTabs: projectContext.tabs,
    activeWorkPanelTabId: projectContext.activeTabId,
    workPanelContexts: { ...chat.workPanelContexts, "project:p1": projectContext },
  };
  const actions = createWorkPanelSlice({
    get: () => state,
    set: (update) => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; },
    isSessionSelectionPending: () => false,
  });
  actions.restoreBrowserWorkPanelTabs("s1", [{ sessionId: "s1", tabId: "browser-restored", url: "https://example.invalid/restored", title: "Restored browser" }]);
  assert.equal(state.workPanelTabs, projectContext.tabs);
  assert.equal(state.activeWorkPanelTabId, side.id);
  assert.equal(state.workPanelContexts["project:p1"], projectContext);
  assert.deepEqual(state.workPanelContexts.s1.tabs.map((tab) => tab.id), ["review", "browser-restored"]);
  assert.equal(state.workPanelContexts.s1.tabs.at(-1).location, "https://example.invalid/restored");
});
