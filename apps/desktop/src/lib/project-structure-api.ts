import { IPC, type ProjectStructureApi } from "@pi-desktop/shared";

export function createProjectStructureApi(invoke: <T>(channel: string, input?: unknown) => Promise<T>): ProjectStructureApi {
  return {
    gitSnapshot: (input) => invoke(IPC.invoke.projectStructureGitSnapshot, input),
    gitDiff: (input) => invoke(IPC.invoke.projectStructureGitDiff, input),
    architectureSnapshot: (input) => invoke(IPC.invoke.projectStructureArchitectureSnapshot, input),
    readFile: (input) => invoke(IPC.invoke.projectStructureReadFile, input),
  };
}
