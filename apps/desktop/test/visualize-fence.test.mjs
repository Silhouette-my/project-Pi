import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// Main-process modules use bundler-style extensionless imports (same hook as
// image-generation.test.mjs, which imports the same builtin-skills module).
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

/*
 * The ```visualize fence grammar and the bundled skill that teaches it.
 * The fence payload is one JSON object naming an absolute fragment path;
 * anything else stays a plain code block. The rendering pipeline itself is
 * covered by visualize-card-rendering.test.mjs.
 */

const { parseVisualizeFence } = await import(
  "../src/features/visualize/visualize-fence.ts"
);
const {
  clearWidgetStates,
  readWidgetState,
  writeWidgetState,
} = await import("../src/features/visualize/widget-state.ts");

test("a visualize fence parses path, wide mode, and title", () => {
  assert.deepEqual(
    parseVisualizeFence('{"path":"/tmp/scratch/battery-drain.html"}'),
    { path: "/tmp/scratch/battery-drain.html", mode: undefined, title: undefined },
  );
  assert.deepEqual(
    parseVisualizeFence(
      '{"path":"/repo/work/app-shell.html","mode":"wide","title":"App shell"}',
    ),
    { path: "/repo/work/app-shell.html", mode: "wide", title: "App shell" },
  );
  assert.deepEqual(
    parseVisualizeFence('{"path":"C:\\\\work\\\\map.html"}'),
    { path: "C:\\work\\map.html", mode: undefined, title: undefined },
  );
});

test("anything that is not an absolute-path object is not a reference", () => {
  // Half-typed or malformed payloads fall back to a plain code block.
  assert.equal(parseVisualizeFence('{"path":'), null);
  assert.equal(parseVisualizeFence(""), null);
  assert.equal(parseVisualizeFence("[]"), null);
  assert.equal(parseVisualizeFence('"just a string"'), null);
  // Relative paths cannot be resolved by the contained file reader.
  assert.equal(parseVisualizeFence('{"path":"./visual.html"}'), null);
  assert.equal(parseVisualizeFence('{"path":""}'), null);
  assert.equal(parseVisualizeFence('{"mode":"wide"}'), null);
  // Unknown modes are dropped, not fatal.
  assert.equal(
    parseVisualizeFence('{"path":"/x/y.html","mode":"tall"}').mode,
    undefined,
  );
});

test("widget state round-trips per card and clears", () => {
  clearWidgetStates();
  assert.equal(readWidgetState("card-a"), null);
  writeWidgetState("card-a", { privateContent: { scenario: "heavy" } });
  writeWidgetState("card-b", null);
  assert.deepEqual(readWidgetState("card-a"), {
    privateContent: { scenario: "heavy" },
  });
  assert.equal(readWidgetState("card-b"), null);
  clearWidgetStates();
  assert.equal(readWidgetState("card-a"), null);
});

test("the visualize skill is bundled, enabled by default, and loadable", async () => {
  const {
    assertBuiltinSkillEnabled,
    builtinSkillCatalog,
    builtinSkills,
    loadBuiltinSkillBody,
  } = await import("../electron/main/builtin-skills.ts");
  const catalogIds = builtinSkillCatalog().map((skill) => skill.id);
  assert.ok(catalogIds.includes("pi-desktop/visualize"));
  const skills = builtinSkills({});
  assert.ok(skills.some((skill) => skill.id === "pi-desktop/visualize"));
  const disabled = builtinSkills({ disabledIds: ["pi-desktop/visualize"] });
  assert.ok(!disabled.some((skill) => skill.id === "pi-desktop/visualize"));
  await assert.rejects(
    assertBuiltinSkillEnabled("pi-desktop/visualize", async () => [
      "pi-desktop/visualize",
    ]),
    /disabled in Settings/,
  );

  const skill = loadBuiltinSkillBody("pi-desktop/visualize");
  assert.ok(skill?.body, "the bundled skill body must load");
  // The PI-Desktop grammar, not the official inline `visualize{…}` syntax.
  assert.match(skill.body, /```visualize/);
  assert.match(skill.body, /"path":"\/absolute\/path\/to\/<title>\.html"/);
  assert.match(skill.body, /"mode":"wide"/);
  // The bridge surface the host actually implements, with its Phase 1 limits.
  assert.match(skill.body, /window\.openai\.sendFollowUpMessage/);
  assert.match(skill.body, /window\.openai\.setWidgetState/);
  assert.match(skill.body, /session memory only/);
  // The CDN allowlist the sandbox CSP enforces.
  assert.match(skill.body, /cdn\.jsdelivr\.net/);
  assert.match(skill.body, /fonts\.googleapis\.com/);
});
