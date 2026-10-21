import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  assertBuiltinSkillEnabled,
  builtinSkillCatalog,
  builtinSkills,
  DEEP_RESEARCH_SKILL_ID,
  LATEX_SKILL_ID,
  VISUALIZE_SKILL_ID,
  loadBuiltinSkillBody,
} = await import("../electron/main/builtin-skills.ts");

test("bundled catalog advertises the latex and deep-research skills", () => {
  const catalog = builtinSkillCatalog();
  for (const id of [LATEX_SKILL_ID, DEEP_RESEARCH_SKILL_ID, VISUALIZE_SKILL_ID]) {
    const entry = catalog.find((skill) => skill.id === id);
    assert.ok(entry, `catalog is missing ${id}`);
    assert.ok(entry.name.length > 0);
    assert.ok(entry.description.length > 0);
  }
});

test("latex skill loads with sibling scripts next to its document", () => {
  const skill = loadBuiltinSkillBody(LATEX_SKILL_ID);
  assert.ok(skill);
  assert.match(skill.body, /compile_latex\.py/);
  assert.match(skill.location, /resources[/\\]skills[/\\]latex[/\\]SKILL\.md$/);
  const dir = path.dirname(skill.location);
  for (const rel of [
    "scripts/compile_latex.py",
    "scripts/latex_doctor.py",
    "scripts/install_texlive.py",
  ]) {
    assert.ok(existsSync(path.join(dir, rel)), `missing sibling resource ${rel}`);
  }
});

test("deep-research skill loads with its reference documents", () => {
  const skill = loadBuiltinSkillBody(DEEP_RESEARCH_SKILL_ID);
  assert.ok(skill);
  assert.match(skill.body, /report-source\.md/);
  const dir = path.dirname(skill.location);
  for (const rel of ["references/research-method.md", "references/report-contract.md"]) {
    assert.ok(existsSync(path.join(dir, rel)), `missing sibling resource ${rel}`);
  }
});

test("new skills are active by default and withheld when disabled", async () => {
  const active = builtinSkills({ workspacePath: null });
  const ids = new Set(active.map((skill) => skill.id));
  assert.ok(ids.has(LATEX_SKILL_ID));
  assert.ok(ids.has(DEEP_RESEARCH_SKILL_ID));
  assert.ok(ids.has(VISUALIZE_SKILL_ID));

  const disabled = builtinSkills({
    workspacePath: null,
    disabledIds: [LATEX_SKILL_ID],
  });
  const disabledIds = new Set(disabled.map((skill) => skill.id));
  assert.ok(!disabledIds.has(LATEX_SKILL_ID));
  assert.ok(disabledIds.has(DEEP_RESEARCH_SKILL_ID));

  await assert.rejects(
    () => assertBuiltinSkillEnabled(LATEX_SKILL_ID, async () => [LATEX_SKILL_ID]),
    /disabled in Settings/,
  );
  await assertBuiltinSkillEnabled(LATEX_SKILL_ID, async () => []);
});
