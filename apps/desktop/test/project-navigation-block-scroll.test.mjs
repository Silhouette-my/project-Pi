import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { fadeSides, edgeScrollStep } = await import("../src/features/project-workflow/block-scroll.ts");

test("fades appear only on the sides that hide content", () => {
  assert.equal(fadeSides(0, 256, 256), "none");
  assert.equal(fadeSides(0, 256, 600), "bottom");
  assert.equal(fadeSides(100, 256, 600), "both");
  assert.equal(fadeSides(344, 256, 600), "top");
});

test("edge auto-scroll speeds up toward the edge and is idle in the middle", () => {
  assert.equal(edgeScrollStep(150, 100, 300), 0);
  assert.ok(edgeScrollStep(101, 100, 300) < 0 && edgeScrollStep(299, 100, 300) > 0);
  assert.ok(edgeScrollStep(299, 100, 300) > edgeScrollStep(285, 100, 300));
});

test("blocks are height limited by 8 row heights, hide the scrollbar and never trap the wheel", async () => {
  const css = await readFile(new URL("../src/features/project-workflow/navigation-styles.css", import.meta.url), "utf8");
  assert.match(css, /max-height: calc\(var\(--sidebar-row-height\) \* 8\)/);
  assert.match(css, /is-block > \.workflow-tree-children::-webkit-scrollbar[\s\S]*display: none/);
  assert.doesNotMatch(css, /overscroll-behavior/);
  assert.doesNotMatch(css, /scrollbar-width/);
});
