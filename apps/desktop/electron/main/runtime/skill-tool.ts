import type { LocalToolHandler } from "@pi-desktop/host-runtime";
import { assertBuiltinSkillEnabled, loadBuiltinSkillBody } from "../builtin-skills";
import type { PluginRuntime } from "../plugin-runtime";
import { formatSkillToolContent, type LoadedSkillDocument } from "../skill-document";

type SkillToolDependencies = {
  sessionProjects: Map<string, string | null>;
  disabledBuiltinSkills: () => Promise<string[]>;
  loadUserSkillBody: (id: string, projectPath: string | null) => Promise<LoadedSkillDocument | null>;
  activeUserSkills: (projectPath: string | undefined) => Promise<ReadonlyArray<{ id: string }>>;
  plugins: Pick<PluginRuntime, "loadSkillBody" | "getSkills">;
  pluginActiveInProject: (pluginId: string, projectPath: string | null | undefined) => boolean;
};

/** Serve the document matching the host-captured runtime launch contract. */
export function createSkillTool({
  sessionProjects,
  disabledBuiltinSkills,
  loadUserSkillBody,
  activeUserSkills,
  plugins,
  pluginActiveInProject,
}: SkillToolDependencies): LocalToolHandler {
  return async ({ args, sessionId, visualizationsDir }) => {
    const id = String((args as { id?: unknown })?.id ?? "").trim();
    if (!id) {
      return { ok: false, isError: true, content: "Skill: `id` is required. Use an id from the Skills section." };
    }
    const projectPath = sessionProjects.get(sessionId) ?? null;
    try {
      await assertBuiltinSkillEnabled(id, disabledBuiltinSkills);
      // Only a locally launched GenUI runtime receives this directory. A
      // settings change cannot swap an active turn to a different skill body.
      const skill: LoadedSkillDocument =
        loadBuiltinSkillBody(id, { inlineVisualizations: Boolean(visualizationsDir) }) ??
        (await loadUserSkillBody(id, projectPath)) ??
        plugins.loadSkillBody(id);
      return { ok: true, content: formatSkillToolContent(skill) };
    } catch (error) {
      const userIds = (await activeUserSkills(projectPath ?? undefined)).map((skill) => skill.id);
      const pluginIds = plugins.getSkills()
        .filter((skill) => pluginActiveInProject(skill.pluginId, projectPath))
        .map((skill) => skill.id);
      const available = [...userIds, ...pluginIds].join(", ");
      return {
        ok: false,
        isError: true,
        content: `Skill: ${error instanceof Error ? error.message : String(error)}.${available ? ` Available skills: ${available}.` : ""}`,
      };
    }
  };
}
