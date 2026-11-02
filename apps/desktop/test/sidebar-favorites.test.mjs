import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { favoriteProjects, favoriteSessions } = await import("../src/features/project-workflow/navigation-category-model.ts");
const view = await import("../src/lib/sidebar-view-state.ts");

const session = (id, updatedAt, extra = {}) => ({ id, title: id, createdAt: "2026-10-01", updatedAt, projectPath: null, ...extra });
const snapshot = (navigation, extra = {}) => ({
  conversations: [],
  projectAgents: [],
  workstreams: [],
  folders: [],
  expandedIds: [],
  navigation,
  ...extra,
});

test("the Favorites view lists starred conversations from anywhere, newest activity first", () => {
  const sessions = [
    session("old", "2026-10-02"),
    session("new", "2026-10-05"),
    session("plain", "2026-10-09"),
    session("project-chat", "2026-10-07", { projectPath: "/work" }),
    session("side", "2026-10-09"),
    session("agent", "2026-10-09"),
  ];
  const nav = [
    { sessionId: "old", order: 0, favorite: true },
    { sessionId: "new", order: 1, favorite: true },
    { sessionId: "plain", order: 2, favorite: false },
    { sessionId: "project-chat", order: 0, favorite: true },
    { sessionId: "side", order: 0, favorite: true },
    { sessionId: "agent", order: 0, favorite: true },
  ];
  const data = snapshot(nav, {
    projectAgents: [{ projectId: "p", sessionId: "agent" }],
    conversations: [{ sessionId: "side", projectId: "p", visibility: "side_only" }],
  });
  assert.deepEqual(favoriteSessions(data, sessions).map((item) => item.id), ["project-chat", "new", "old"]);
  assert.deepEqual(favoriteSessions(snapshot([]), sessions), []);
});

test("favourite projects are the starred, unarchived ones in tree order", () => {
  const projects = [
    { id: "a", order: 2 },
    { id: "b", order: 0, archived: true },
    { id: "c", order: 1 },
    { id: "d", order: 3 },
  ];
  const data = snapshot([], {
    projectNavigation: [
      { projectId: "a", order: 2, favorite: true },
      { projectId: "b", order: 0, favorite: true },
      { projectId: "c", order: 1, favorite: true },
      { projectId: "d", order: 3 },
    ],
  });
  assert.deepEqual(favoriteProjects(data, projects).map((item) => item.id), ["c", "a"]);
  assert.deepEqual(favoriteProjects(snapshot([]), projects), []);
});

test("an access after the last update moves a favourite up", () => {
  const sessions = [session("a", "2026-10-02"), session("b", "2026-10-03")];
  const nav = [
    { sessionId: "a", order: 0, favorite: true, lastAccessedAt: "2026-10-08T00:00:00Z" },
    { sessionId: "b", order: 1, favorite: true },
  ];
  assert.deepEqual(favoriteSessions(snapshot(nav), sessions).map((item) => item.id), ["a", "b"]);
});

test("the list view choice persists and falls back to the tree", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
  };
  try {
    store.set("pi.sidebar.listView", "bogus");
    view.resetSidebarListView();
    view.toggleSidebarFavoritesView();
    assert.equal(store.get("pi.sidebar.listView"), "favorites", "an unknown stored value reads as the tree");
    view.toggleSidebarFavoritesView();
    assert.equal(store.get("pi.sidebar.listView"), "tree");
    view.setSidebarListView("favorites");
    view.resetSidebarListView();
    view.setSidebarListView("tree");
    assert.equal(store.get("pi.sidebar.listView"), "tree", "a reload reads the stored favourites choice, then switches");
  } finally {
    delete globalThis.localStorage;
    view.resetSidebarListView();
  }
});

test("starring a conversation without a navigation record keeps the position it shows", async () => {
  const { navigationRecordFor, rememberVisibleOrders, visibleOrderOf } = await import(
    "../src/features/project-workflow/navigation-visible-order.ts"
  );
  const data = snapshot([{ sessionId: "placed", order: 7, favorite: false, folderId: "f" }]);
  rememberVisibleOrders([
    { kind: "session", id: "unplaced", order: 3 },
    { kind: "session", id: "placed", order: 7 },
    { kind: "folder", id: "f", order: 0 },
  ]);
  assert.equal(visibleOrderOf("unplaced"), 3);
  assert.equal(visibleOrderOf("f"), undefined, "only conversations are remembered");
  assert.deepEqual(navigationRecordFor(data, "unplaced"), { sessionId: "unplaced", order: 3, favorite: false });
  assert.deepEqual(navigationRecordFor(data, "placed"), data.navigation[0], "a stored record is used as is");
  assert.equal(navigationRecordFor(data, "never-shown").order, 0);
  assert.equal(navigationRecordFor(data, "x", 5).order, 5);
});
