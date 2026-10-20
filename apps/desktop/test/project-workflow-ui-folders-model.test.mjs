import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { navigationHighlights, navigationSessions, folderParents, workflowGroupForPath, workflowProjectEntries } =
  await import("../src/features/project-workflow/navigation-model.ts");
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");

test("folder projection uses manual order, not background update time; work conversations remain in Projects", () => {
  const snapshot = {
    conversations: [{ sessionId: "work" }],
    navigation: [
      { sessionId: "b", order: -1 },
      { sessionId: "c", folderId: "folder", order: 0 },
    ],
  };
  const sessions = [
    { id: "a", createdAt: "2026-01-01", updatedAt: "2026-10-20" },
    { id: "b", createdAt: "2026-01-02", updatedAt: "2026-01-02" },
    { id: "c", createdAt: "2026-01-01" },
    { id: "work", createdAt: "2026-01-01" },
    { id: "legacy", projectPath: "/legacy", createdAt: "2026-01-01" },
  ];
  assert.deepEqual(
    navigationSessions(snapshot, sessions).map((s) => s.id),
    ["b", "a"],
  );
  sessions[0].updatedAt = "2027-01-01";
  assert.deepEqual(
    navigationSessions(snapshot, sessions).map((s) => s.id),
    ["b", "a"],
  );
  assert.deepEqual(
    navigationSessions(snapshot, sessions, "folder").map((s) => s.id),
    ["c"],
  );
});
test("folder parent choices prevent cycles and third nesting level", () => {
  const folders = [
    { id: "parent", order: 0 },
    { id: "child", parentId: "parent", order: 1 },
    { id: "other", order: 2 },
  ];
  assert.deepEqual(folderParents(folders, folders[0]), []);
  assert.deepEqual(
    folderParents(folders, folders[1]).map((f) => f.id),
    ["parent", "other"],
  );
});
test("navigation highlights are disjoint and do not alter folder ownership or access dates", () => {
  const snapshot = {
    conversations: [{ sessionId: "side" }],
    projectAgents: [{ projectId: "project", sessionId: "agent" }],
    navigation: [
      { sessionId: "favorite", favorite: true, order: 2, lastAccessedAt: "2026-10-20", folderId: "folder" },
      { sessionId: "recent", favorite: false, order: 0, lastAccessedAt: "2026-10-19", folderId: "folder" },
      { sessionId: "ordinary", favorite: false, order: 1 },
      { sessionId: "side", favorite: true, order: 0 },
      { sessionId: "agent", favorite: true, order: 0 },
    ],
  };
  const before = structuredClone(snapshot);
  const sessions = ["favorite", "recent", "ordinary", "side", "agent"].map((id) => ({ id, createdAt: "2026-10-01" }));
  const highlights = navigationHighlights(snapshot, sessions);
  assert.deepEqual(highlights.favorites.map((item) => item.id), ["favorite"]);
  assert.deepEqual(highlights.recent.map((item) => item.id), ["recent"]);
  const remaining = navigationSessions(snapshot, sessions).filter((item) => !highlights.promotedIds.has(item.id));
  assert.deepEqual(remaining.map((item) => item.id), ["ordinary"]);
  assert.deepEqual(snapshot, before);
  const folder = navigationSessions(snapshot, sessions, "folder");
  assert.deepEqual(
    folder.map((item) => item.id),
    ["recent", "favorite"],
    "highlight views must not remove chats from their owning folder",
  );
});
test("durable project identity resolves an existing visible path without inventing navigation entries", () => {
  const groups = [
    { id: "project", primaryPath: "/visible", roots: [{ path: "/visible/second-root" }] },
    { id: "closed", primaryPath: "/closed", roots: [] },
  ];
  assert.equal(workflowGroupForPath(groups, "/visible/")?.id, "project");
  assert.equal(workflowGroupForPath(groups, "/visible/second-root")?.id, "project");
  assert.equal(workflowGroupForPath(groups, "/legacy-only"), undefined);
  const entries = [
    { path: "/visible", name: "Retained title", sessions: [{ id: "first" }] },
    { path: "/visible/second-root", name: "Other root", sessions: [{ id: "second" }] },
    { path: "/legacy-only", name: "Legacy", sessions: [] },
  ];
  const projected = workflowProjectEntries(entries, groups);
  assert.deepEqual(
    projected.map((entry) => entry.name),
    ["Retained title", "Legacy"],
  );
  assert.deepEqual(
    projected[0].sessions.map((session) => session.id),
    ["first", "second"],
  );
  assert.equal(
    entries[0].sessions.length,
    1,
    "projection must not mutate retained project metadata",
  );
});
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
function surface(persist) {
  let state = {
    sessions: [],
    sessionMeta: {},
    runningSessions: {},
    workspace: null,
    activeSessionId: null,
    page: "chat",
    sessionPanes: {},
    sessionMessages: {},
    messages: [],
  };
  const get = () => state;
  const set = (next) => {
    state = { ...state, ...(typeof next === "function" ? next(state) : next) };
  };
  const runtime = createSessionRuntime({ get, set });
  const slice = createSessionSlice({ get, set, runtime, persistSessionAndSelect: persist });
  return { get, set, runtime, slice };
}
test("new chat returns actual created identity and deduplicates an in-flight creation", async () => {
  const pending = deferred();
  let creations = 0;
  const { slice } = surface(async () => {
    creations++;
    return pending.promise;
  });
  const first = slice.newSession({ projectPath: null });
  const second = slice.newSession({ projectPath: null });
  pending.resolve("created-chat");
  assert.deepEqual(await Promise.all([first, second]), ["created-chat", "created-chat"]);
  assert.equal(creations, 1);
});
test("new chat returns undefined when another navigation supersedes creation", async () => {
  const pending = deferred();
  const { slice, runtime } = surface(() => pending.promise);
  const first = slice.newSession({ projectPath: null });
  runtime.beginNavigationIntent();
  pending.resolve("created-but-not-selected");
  assert.equal(await first, undefined);
});
test("new chat returns a reused empty chat identity", async () => {
  const { slice, set } = surface(() => {
    throw Error("should reuse empty");
  });
  set({
    sessions: [{ id: "existing", projectPath: null, messageCount: 0, updatedAt: "2026-10-20" }],
    activeSessionId: "existing",
  });
  assert.equal(await slice.newSession({ projectPath: null }), "existing");
});
