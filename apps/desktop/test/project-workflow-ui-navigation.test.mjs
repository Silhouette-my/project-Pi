import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createInteractionSlice } = await import("../src/stores/slices/interaction-slice.ts");

function harness() {
  let navigationIntents = 0;
  const selections = [];
  let state = {
    page: "chat",
    activeSessionId: "session-running",
    isRunning: true,
    runningSessions: { "session-running": true },
    navStack: [{ page: "chat", sessionId: "session-running" }],
    navIndex: 0,
    selectSession: (...args) => selections.push(args),
  };
  const actions = createInteractionSlice({
    get: () => state,
    set: (update) => {
      state = {
        ...state,
        ...(typeof update === "function" ? update(state) : update),
      };
    },
    runtime: { beginNavigationIntent: () => ++navigationIntents },
    interactionRuntime: {},
  });
  state = { ...state, ...actions };
  return {
    actions,
    selections,
    get: () => state,
  };
}

test("Project Console history restores distinct project destinations around chat", () => {
  const h = harness();

  h.actions.setPage("project", { projectId: "project-a" });
  h.actions.setPage("project", { projectId: "project-b" });
  h.actions.setPage("chat");

  assert.deepEqual(h.get().navStack, [
    { page: "chat", sessionId: "session-running" },
    { page: "project", sessionId: undefined, projectId: "project-a" },
    { page: "project", sessionId: undefined, projectId: "project-b" },
    { page: "chat", sessionId: "session-running", projectId: undefined },
  ]);

  h.actions.navBack();
  assert.equal(h.get().page, "project");
  assert.equal(h.get().projectConsoleId, "project-b");
  assert.equal(h.get().activeSessionId, "session-running");
  assert.deepEqual(h.selections, [], "restoring a project destination does not select a chat session");

  h.actions.navBack();
  assert.equal(h.get().projectConsoleId, "project-a");
  h.actions.navForward();
  assert.equal(h.get().projectConsoleId, "project-b");
  h.actions.navForward();
  assert.equal(h.get().page, "chat");
  assert.equal(h.get().projectConsoleId, undefined);
  assert.deepEqual(h.selections, [["session-running", { record: false, navigationIntent: 7 }]]);
});

test("same Project Console destination is deduplicated but another project is retained", () => {
  const h = harness();

  h.actions.setPage("project", { projectId: "project-a" });
  h.actions.setPage("project", { projectId: "project-a" });
  h.actions.setPage("project", { projectId: "project-b" });

  assert.equal(h.get().navStack.length, 3);
  assert.deepEqual(h.get().navStack.slice(1).map(({ projectId }) => projectId), [
    "project-a",
    "project-b",
  ]);
});

test("opening the console leaves the active running session and transcript selection untouched", () => {
  const h = harness();
  const before = {
    activeSessionId: h.get().activeSessionId,
    isRunning: h.get().isRunning,
    runningSessions: h.get().runningSessions,
  };

  h.actions.setPage("project", { projectId: "project-a" });

  assert.deepEqual({
    activeSessionId: h.get().activeSessionId,
    isRunning: h.get().isRunning,
    runningSessions: h.get().runningSessions,
  }, before);
  assert.deepEqual(h.selections, []);
});
