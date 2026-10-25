import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { favoriteSessions } = await import("../src/features/project-workflow/navigation-category-model.ts");
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

test("the Favorites view lists starred standalone conversations, newest activity first", () => {
  const sessions = [
    session("old", "2026-10-02"),
    session("new", "2026-10-05"),
    session("plain", "2026-10-09"),
    session("project-chat", "2026-10-09", { projectPath: "/work" }),
    session("agent", "2026-10-09"),
  ];
  const nav = [
    { sessionId: "old", order: 0, favorite: true },
    { sessionId: "new", order: 1, favorite: true },
    { sessionId: "plain", order: 2, favorite: false },
    { sessionId: "project-chat", order: 0, favorite: true },
    { sessionId: "agent", order: 0, favorite: true },
  ];
  const data = snapshot(nav, { projectAgents: [{ projectId: "p", sessionId: "agent" }] });
  assert.deepEqual(favoriteSessions(data, sessions).map((item) => item.id), ["new", "old"]);
  assert.deepEqual(favoriteSessions(snapshot([]), sessions), []);
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
