import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { SETTINGS_NAV, searchSettings } = await import(
  "../src/lib/settings-search.ts"
);
const { en } = await import(
  "../../../packages/i18n/src/locales/en/index.ts"
);
const { flattenCatalog } = await import(
  "../../../packages/i18n/src/locale-info.ts"
);

const copy = flattenCatalog(en);
const t = (key) => copy[key] ?? key;

test("command folding is searchable from the AI preferences beside show thinking", () => {
  const ai = SETTINGS_NAV.find((entry) => entry.id === "ai");
  assert.ok(ai, "AI settings entry is registered");
  const showThinkingAt = ai.keywordKeys.indexOf("settings.showThinking");
  assert.ok(showThinkingAt >= 0, "show thinking remains indexed");
  assert.deepEqual(
    ai.keywordKeys.slice(showThinkingAt, showThinkingAt + 4),
    [
      "settings.showThinking",
      "settings.showThinkingDesc",
      "settings.keepCommandsExpanded",
      "settings.keepCommandsExpandedDesc",
    ],
  );

  const titleHits = searchSettings("collapse commands", t, {
    developerMode: false,
    includeDevelopmentOnly: false,
  }).filter((hit) => hit.tab === "ai");
  assert.ok(
    titleHits.some((hit) => hit.rowKey === "settings.keepCommandsExpanded"),
    "the command-folding title is searchable",
  );

  const descriptionHits = searchSettings("shell calls", t, {
    developerMode: false,
    includeDevelopmentOnly: false,
  }).filter((hit) => hit.tab === "ai");
  assert.ok(
    descriptionHits.some(
      (hit) => hit.rowKey === "settings.keepCommandsExpandedDesc",
    ),
    "the command-folding description is searchable",
  );
});
