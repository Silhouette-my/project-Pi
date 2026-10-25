import assert from "node:assert/strict";
import test from "node:test";

const {
  forgetProjectAgentTabClosed,
  hasProjectAgentTab,
  isProjectPanelContextKey,
  markProjectAgentTabClosed,
  projectAgentWorkPanelTab,
  projectIdOfContextKey,
  projectPanelContextKey,
  projectSideWorkPanelTab,
  shouldDefaultOpenProjectAgent,
  wasProjectAgentTabClosed,
  workPanelContextKey,
} = await import("../src/lib/project-panel.ts");
const {
  closeWorkPanelTabState,
  isKnownWorkPanelTab,
  openWorkPanelTabState,
  sanitizeWorkPanelTabsState,
  switchWorkPanelContextState,
  emptyWorkPanelContext,
} = await import("../src/lib/work-panel-tabs.ts");
const {
  hasWorkPanelNavigationReveal,
  requestWorkPanelNavigationReveal,
  resetWorkPanelNavigationReveal,
  takeWorkPanelNavigationReveal,
} = await import("../src/lib/work-panel-navigation-reveal.ts");

test("the project page presents a project-scoped context; other pages keep the session's", () => {
  assert.equal(
    workPanelContextKey({ page: "project", projectConsoleId: "p1", activeSessionId: "s1" }),
    "project:p1",
  );
  assert.equal(workPanelContextKey({ page: "chat", projectConsoleId: "p1", activeSessionId: "s1" }), "s1");
  assert.equal(workPanelContextKey({ page: "project", activeSessionId: "s1" }), "s1");
  assert.equal(workPanelContextKey({ page: "chat" }), undefined);
  assert.equal(workPanelContextKey({ page: "project", projectConsoleId: "p1" }), "project:p1");
  assert.ok(isProjectPanelContextKey(projectPanelContextKey("p1")));
  assert.ok(!isProjectPanelContextKey("session-1"));
  assert.equal(projectIdOfContextKey("project:p1"), "p1");
  assert.equal(projectIdOfContextKey("session-1"), undefined);
});

test("project tabs are known, keyed by their resource, and dropped without one", () => {
  const agent = projectAgentWorkPanelTab("p1");
  const side = projectSideWorkPanelTab("child", "Explore auth");
  assert.deepEqual([agent.id, agent.kind, agent.resource], ["project-agent:p1", "project-agent", "p1"]);
  assert.deepEqual([side.id, side.kind, side.resource, side.label], ["project-side:child", "project-side", "child", "Explore auth"]);
  assert.ok(isKnownWorkPanelTab(agent) && isKnownWorkPanelTab(side));
  assert.ok(!isKnownWorkPanelTab({ id: "project-agent:", kind: "project-agent" }));
  const sanitized = sanitizeWorkPanelTabsState({
    tabs: [{ id: "project-side:", kind: "project-side" }, agent],
    activeTabId: "project-side:",
  });
  assert.deepEqual(sanitized.tabs.map((tab) => tab.id), [agent.id]);
  assert.equal(sanitized.activeTabId, agent.id);
  // Reopening the same side conversation reuses its tab.
  const state = openWorkPanelTabState(
    openWorkPanelTabState({ tabs: [agent], activeTabId: agent.id }, side),
    side,
  );
  assert.equal(state.tabs.length, 2);
  assert.equal(state.activeTabId, side.id);
});

test("project and session contexts survive swapping between them", () => {
  const agent = projectAgentWorkPanelTab("p1");
  const side = projectSideWorkPanelTab("child");
  const sessionTab = { id: "review", kind: "review" };
  let contexts = {
    "session-1": { ...emptyWorkPanelContext(), open: true, tabs: [sessionTab], activeTabId: "review" },
  };
  // Chat -> project page.
  let swapped = switchWorkPanelContextState(contexts, "session-1", contexts["session-1"], "project:p1");
  assert.deepEqual(swapped.visible, emptyWorkPanelContext());
  const projectContext = {
    ...swapped.visible,
    open: true,
    tabs: [agent, side],
    activeTabId: side.id,
  };
  // Project page -> chat again: both contexts are intact.
  swapped = switchWorkPanelContextState(swapped.contexts, "project:p1", projectContext, "session-1");
  assert.deepEqual(swapped.visible.tabs, [sessionTab]);
  assert.deepEqual(swapped.contexts["project:p1"].tabs, [agent, side]);
  assert.equal(swapped.contexts["project:p1"].activeTabId, side.id);
  // And back to the project: the project context returns unchanged.
  swapped = switchWorkPanelContextState(swapped.contexts, "session-1", swapped.visible, "project:p1");
  assert.deepEqual(swapped.visible.tabs, [agent, side]);
  assert.equal(swapped.visible.open, true);
  assert.deepEqual(swapped.contexts["session-1"].tabs, [sessionTab]);
});

test("default open adds the Agent once, never to the Agent's own session, never after a close", () => {
  forgetProjectAgentTabClosed();
  const base = { contextKey: "s1", projectId: "p1", sessionId: "s1", agentSessionId: "agent", tabs: [] };
  assert.equal(shouldDefaultOpenProjectAgent(base), true);
  // No project, no context, or a remote session: nothing to present.
  assert.equal(shouldDefaultOpenProjectAgent({ ...base, projectId: undefined }), false);
  assert.equal(shouldDefaultOpenProjectAgent({ ...base, contextKey: undefined }), false);
  assert.equal(shouldDefaultOpenProjectAgent({ ...base, remote: true }), false);
  // The Agent's own session is the conversation itself.
  assert.equal(shouldDefaultOpenProjectAgent({ ...base, sessionId: "agent", contextKey: "agent" }), false);
  // Already there: not added twice.
  const tabs = [projectAgentWorkPanelTab("p1")];
  assert.ok(hasProjectAgentTab(tabs, "p1"));
  assert.equal(shouldDefaultOpenProjectAgent({ ...base, tabs }), false);
  // An Agent tab of another project does not count.
  assert.equal(shouldDefaultOpenProjectAgent({ ...base, tabs: [projectAgentWorkPanelTab("p2")] }), true);

  // Closing it in a session context is remembered for that context only.
  const closed = closeWorkPanelTabState({ tabs, activeTabId: tabs[0].id }, tabs[0].id);
  assert.deepEqual(closed.tabs, []);
  markProjectAgentTabClosed("s1");
  assert.ok(wasProjectAgentTabClosed("s1"));
  assert.equal(shouldDefaultOpenProjectAgent({ ...base, tabs: closed.tabs }), false);
  assert.equal(
    shouldDefaultOpenProjectAgent({ ...base, contextKey: "s2", sessionId: "s2" }),
    true,
    "another session context is unaffected",
  );
  forgetProjectAgentTabClosed("s1");
  assert.equal(shouldDefaultOpenProjectAgent(base), true);
});

test("the project page presents the Agent on every entry, whatever was closed before", () => {
  forgetProjectAgentTabClosed();
  markProjectAgentTabClosed("project:p1");
  assert.equal(
    shouldDefaultOpenProjectAgent({ contextKey: "project:p1", projectId: "p1", tabs: [] }),
    true,
  );
  forgetProjectAgentTabClosed();
});

test("a navigation reveal is taken only by the context it was requested for", () => {
  resetWorkPanelNavigationReveal();
  assert.equal(hasWorkPanelNavigationReveal(), false);
  requestWorkPanelNavigationReveal("project:p1");
  assert.equal(hasWorkPanelNavigationReveal(), true);
  assert.equal(takeWorkPanelNavigationReveal("session-1"), false, "a stale request is dropped");
  assert.equal(hasWorkPanelNavigationReveal(), false);
  requestWorkPanelNavigationReveal("project:p1");
  assert.equal(takeWorkPanelNavigationReveal("project:p1"), true);
  assert.equal(takeWorkPanelNavigationReveal("project:p1"), false, "taken once");
});

test("the project Agent tab is labelled Project Agent and its composer carries no scope chip", async () => {
  const { readFileSync } = await import("node:fs");
  const locale = (name, file) =>
    readFileSync(new URL(`../../../packages/i18n/src/locales/${name}/${file}.ts`, import.meta.url), "utf8");
  assert.match(locale("zh-CN", "index"), /agentTab: "项目 Agent"/);
  assert.match(locale("en", "index"), /agentTab: "Project Agent"/);
  assert.match(locale("zh-CN", "workflow"), /agentPlaceholder: "与项目 Agent 讨论"/);
  const tab = readFileSync(new URL("../src/features/project-panel/ProjectAgentTab.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(tab, /scopeLabel=/);
});

test("empty right-panel conversations show one short line", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (name, file) =>
    readFileSync(new URL(`../../../packages/i18n/src/locales/${name}/${file}.ts`, import.meta.url), "utf8");
  for (const locale of ["en", "de", "es", "fr", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"]) {
    const workflow = read(locale, "workflow");
    const [, agent] = workflow.match(/agentDockEmpty: "([^"]*)"/);
    const [, side] = workflow.match(/sideEmpty: "([^"]*)"/);
    assert.equal(agent, side, `${locale}: project Agent and side conversations share the empty line`);
    assert.ok(agent.length <= 20, `${locale}: ${agent}`);
    const index = read(locale, "index");
    const block = index.slice(index.indexOf("\n  sideChat: {"), index.indexOf("\n  sideChat: {") + 800);
    assert.ok(block.includes(`\n    empty: "${agent}"`), `${locale}: side chat matches`);
  }
});
