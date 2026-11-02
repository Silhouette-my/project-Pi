import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { categoryRoot, treePlacement } = await import("../src/features/project-workflow/navigation-tree-model.ts");
const { sidebarCategories, reorderedCategoryIds, steppedCategoryIds } = await import("../src/features/project-workflow/navigation-category-model.ts");
const names = { chats: "对话", projects: "项目" };

test("a project dropped on an empty custom category lands at its root", () => {
  const project = { kind: "project", id: "p1", label: "P", parentId: categoryRoot("projects"), order: 0 };
  const placement = treePlacement([project], project, undefined, "after", categoryRoot("reading"));
  assert.deepEqual(placement, { folderId: categoryRoot("reading"), order: 0 });
});

test("the category body (including its empty line) is a drop target, not only the header", async () => {
  const source = await readFile(new URL("../src/features/project-workflow/NavigationTree.tsx", import.meta.url), "utf8");
  const body = source.match(/<div\s+className=\{`sidebar-category-body[\s\S]*?>\n/);
  assert.ok(body, "category body element");
  assert.match(body[0], /onDragOver=\{\(event\) => over\(event, undefined, rootKey, groupId\)\}/);
  assert.match(body[0], /onDrop=\{\(event\) => dropOn\(event, undefined, rootKey, groupId\)\}/);
});

test("category order defaults to built-ins then custom, and categoryOrder (built-ins included) overrides it", () => {
  const snapshot = { categories: [{ id: "b", name: "B", order: 2 }, { id: "a", name: "A", order: 1 }] };
  assert.deepEqual(sidebarCategories(snapshot, names).map((c) => c.id), ["chats", "projects", "a", "b"]);
  assert.deepEqual(sidebarCategories({ ...snapshot, categoryOrder: ["a", "projects", "chats", "b"] }, names).map((c) => c.id), ["a", "projects", "chats", "b"]);
  // Unlisted ids (a category created later) keep their default place after the listed ones.
  assert.deepEqual(sidebarCategories({ ...snapshot, categoryOrder: ["projects", "chats"] }, names).map((c) => c.id), ["projects", "chats", "a", "b"]);
  // Stale ids in the stored order are ignored.
  assert.deepEqual(sidebarCategories({ ...snapshot, categoryOrder: ["gone", "b"] }, names).map((c) => c.id), ["b", "chats", "projects", "a"]);
});

test("category reordering moves before/after and steps one place, null when nothing changes", () => {
  const ids = ["chats", "projects", "a"];
  assert.deepEqual(reorderedCategoryIds(ids, "a", "chats", false), ["a", "chats", "projects"]);
  assert.deepEqual(reorderedCategoryIds(ids, "chats", "a", true), ["projects", "a", "chats"]);
  assert.equal(reorderedCategoryIds(ids, "chats", "projects", false), null);
  assert.equal(reorderedCategoryIds(ids, "a", "a", true), null);
  assert.deepEqual(steppedCategoryIds(ids, "projects", -1), ["projects", "chats", "a"]);
  assert.deepEqual(steppedCategoryIds(ids, "projects", 1), ["chats", "a", "projects"]);
  assert.equal(steppedCategoryIds(ids, "chats", -1), null);
  assert.equal(steppedCategoryIds(ids, "a", 1), null);
});
