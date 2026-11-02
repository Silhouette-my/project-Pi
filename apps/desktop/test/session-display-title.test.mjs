import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { sessionDisplayTitle } = await import("../src/lib/session-display-title.ts");

test("an imported prompt wrapper shows the user's own request", () => {
  const raw = "# Files mentioned by the user: ## Plan.zip: /Users/me/Plan.zip Distinguish instructions. ## My request: 请把压缩包放到 docs 下\n并执行";
  assert.equal(sessionDisplayTitle(raw), "请把压缩包放到 docs 下 并执行");
});

test("markdown heading markers and extra whitespace are dropped", () => {
  assert.equal(sessionDisplayTitle("## Release   notes\n\nfor v2"), "Release notes for v2");
  assert.equal(sessionDisplayTitle("Plain title"), "Plain title");
  assert.equal(sessionDisplayTitle(undefined), "");
});

test("the 对话树 detail header keeps its open button on one line", async () => {
  const css = await readFile(new URL("../src/features/project-workflow/project-structure-styles.css", import.meta.url), "utf8");
  assert.match(css, /\.project-session-detail > \.workflow-section-heading > \.btn \{[^}]*white-space: nowrap/);
  assert.match(css, /\.project-session-detail h2 \{[^}]*-webkit-line-clamp: 2/);
});

test("the work panel launcher offers a whole-conversation side chat on chat pages", async () => {
  const source = await readFile(new URL("../src/components/workpanel/WorkPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /data-work-panel-launcher-item="side-chat"/);
  assert.match(source, /s\.page === "chat" && selectCanOpenSideChat\(s\)/);
  assert.match(source, /openWholeConversationSideChat\(\)/);
});
