import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { parseSkillFrontmatter } = await import("@pi-desktop/plugin-sdk");
const {
  assertBuiltinSkillEnabled,
  builtinSkillCatalog,
  builtinSkills,
  loadBuiltinSkillBody,
} = await import("../electron/main/builtin-skills.ts");

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const VISUALIZE = "pi-desktop/visualize";

test("enabled local sessions get the GenUI skill contract", () => {
  assert.ok(builtinSkillCatalog({ inlineVisualizations: true }).some((skill) => skill.id === VISUALIZE));
  const local = builtinSkills({ workspacePath: "/repo", inlineVisualizations: true });
  assert.equal(local.find((skill) => skill.id === VISUALIZE)?.name, "visualize");
  assert.ok(builtinSkills({}).some((skill) => skill.id === VISUALIZE));
  const body = loadBuiltinSkillBody(VISUALIZE, { inlineVisualizations: true }).body;
  assert.match(body, /::visualize\{"path":/);
  assert.match(body, /fragment/i);
  assert.match(body, /no network/i);
});

test("the skill only names tokens, classes, and libraries the bundled kit provides", () => {
  const body = loadBuiltinSkillBody(VISUALIZE, { inlineVisualizations: true }).body;
  const css = readFileSync(join(desktopRoot, "resources/gen-ui/visualize.css"), "utf8");
  const kit = readFileSync(join(desktopRoot, "resources/gen-ui/visualize-kit.html"), "utf8");
  const manifest = JSON.parse(readFileSync(join(desktopRoot, "resources/gen-ui/vendor/manifest.json"), "utf8"));
  const helpers = readFileSync(join(desktopRoot, "resources/gen-ui/visualize-helpers.js"), "utf8");
  const exported = new Set(
    helpers.match(/window\.viz = Object\.freeze\(\{([^}]*)\}\)/)?.[1].split(",").map((name) => name.trim()),
  );
  // Theme tokens the skill tells the model to use are defined by the stylesheet.
  const tokens = new Set(body.match(/`--[a-z0-9-]+`/g)?.map((token) => token.slice(1, -1)));
  assert.ok(tokens.size > 20);
  for (const token of tokens) {
    assert.match(css, new RegExp(`${token}:`), token);
  }
  for (let i = 1; i <= 6; i += 1) assert.match(css, new RegExp(`--viz-series-${i}:`));
  // Utility classes the skill names exist in the stylesheet.
  const classes = new Set(body.match(/`\.[a-z][a-z0-9-]*/g)?.map((name) => name.slice(2)));
  assert.ok(classes.size > 20);
  for (const name of classes) assert.match(css, new RegExp(`\\.${name}\\b`), `.${name}`);
  // Tabs and tooltips are wired by the kit runtime.
  assert.match(kit, /pi-desktop-visualization-tabs/);
  assert.match(kit, /closest\("\[data-tooltip\]"\)/);
  // Every library URL the skill still names is a bundled, pinned one; D3 is
  // preloaded by the kit, so the skill must not ask for a script tag.
  const bundled = new Set(manifest.resources.map((resource) => resource.url));
  const urls = body.match(/https:\/\/[^\s"'`<>]+/g) ?? [];
  for (const url of urls) assert.ok(bundled.has(url), url);
  assert.doesNotMatch(body, /<script src=/);
  // Every `viz.*` helper the skill names exists in the preloaded helpers.
  const helperNames = new Set(body.match(/viz\.[a-zA-Z]+/g)?.map((name) => name.slice(4)));
  assert.ok(helperNames.size >= 6);
  for (const name of helperNames) assert.ok(exported.has(name), `viz.${name}`);
  // Host APIs from the upstream kit that PI-Desktop does not provide.
  assert.doesNotMatch(body, /window\.zcode|widgetState|sendFollowUpMessage|openExternal|Tweak|lucide|viz-carousel|render\.py/);
});

test("remote-host sessions retain legacy visualization guidance even with GenUI enabled", () => {
  const remote = builtinSkills({ workspacePath: "/remote/project", remote: true, inlineVisualizations: true });
  assert.ok(remote.some((skill) => skill.id === VISUALIZE));
  assert.ok(remote.some((skill) => skill.id === "pi-desktop/imagegen"));
  const body = loadBuiltinSkillBody(VISUALIZE, { remote: true, inlineVisualizations: true }).body;
  assert.match(body, /```visualize/);
  assert.match(body, /sendFollowUpMessage/);
  assert.doesNotMatch(body, /::visualize\{"path":/);
});

test("users can disable the visualize skill like other built-ins", async () => {
  const skills = builtinSkills({ disabledIds: [VISUALIZE] });
  assert.ok(!skills.some((skill) => skill.id === VISUALIZE));
  await assert.rejects(
    assertBuiltinSkillEnabled(VISUALIZE, async () => [VISUALIZE]),
    /disabled in Settings/,
  );
  await assertBuiltinSkillEnabled(VISUALIZE, async () => []);
});

test("the GenUI switch selects guidance without disabling the existing visualize entry point", () => {
  for (const inlineVisualizations of [undefined, false, true]) {
    const options = { inlineVisualizations };
    const skills = builtinSkills(options);
    assert.equal(skills.filter((skill) => skill.id === VISUALIZE).length, 1);
    const body = loadBuiltinSkillBody(VISUALIZE, options).body;
    assert.match(body, inlineVisualizations ? /::visualize\{"path":/ : /```visualize/);
    assert.ok(!builtinSkills({ ...options, disabledIds: [VISUALIZE] }).some((skill) => skill.id === VISUALIZE));
  }
});

test("the visualize skill file has well-formed front matter and stays compact", () => {
  const raw = readFileSync(join(desktopRoot, "resources/skills/visualize.md"), "utf8");
  const parsed = parseSkillFrontmatter(raw);
  assert.equal(parsed.name, "visualize");
  assert.ok(parsed.description && parsed.description.length > 20);
  assert.ok(Buffer.byteLength(raw) < 12 * 1024);
});
