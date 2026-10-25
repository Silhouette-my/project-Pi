import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { categoryRoot, treePlacement } = await import("../src/features/project-workflow/navigation-tree-model.ts");

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
