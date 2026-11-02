import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createComposerCommandService } = await import("../electron/main/ipc/composer-ipc.ts");
const { loadBuiltinSkillBody } = await import("../electron/main/builtin-skills.ts");
const VISUALIZE = "pi-desktop/visualize";

test("composer catalog and loaded document select one matching visualization contract", async () => {
  let inlineVisualizations = false;
  let disabled = [];
  const service = createComposerCommandService({
    plugins: { listLoaded: () => [], getSkills: () => [], getCommands: () => [] },
    agentExtensions: { allCommands: () => [] },
    activeUserSkills: async () => [],
    disabledBuiltinSkills: async () => disabled,
    inlineVisualizationsEnabled: async () => inlineVisualizations,
    pluginActiveInProject: () => true,
    loadComposerTemplatesCached: async () => [],
  });

  for (const enabled of [false, true]) {
    inlineVisualizations = enabled;
    for (const remote of [false, true]) {
      const commands = await service.buildComposerCommands("/repo", { remote });
      const entries = commands.filter((command) => command.skillId === VISUALIZE);
      assert.equal(entries.length, 1);
      const skill = loadBuiltinSkillBody(VISUALIZE, { remote, inlineVisualizations });
      const genUi = enabled && !remote;
      assert.match(skill.body, genUi ? /::visualize\{"path":/ : /```visualize/);
      assert.equal(entries[0].description.includes("interactive visualizations directly"), genUi);
    }
  }

  disabled = [VISUALIZE];
  assert.ok(!(await service.buildComposerCommands("/repo")).some((command) => command.skillId === VISUALIZE));
});
