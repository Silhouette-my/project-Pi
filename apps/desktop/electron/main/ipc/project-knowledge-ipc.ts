import { IPC, ErrorCodes } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export function registerProjectKnowledgeIpc(registrar: IpcRegistrar, getHost: () => HostProcess | null): void {
  for (const [channel, method] of [
    [IPC.invoke.projectKnowledgeGet, "project.knowledge.get"],
    [IPC.invoke.projectKnowledgeForget, "project.knowledge.forget"],
    [IPC.invoke.projectKnowledgeClearHistory, "project.knowledge.clearHistory"],
  ] as const) {
    registrar.handle(channel, async (input: unknown) => {
      if (!input || typeof input !== "object") throw invalid("project knowledge request required");
      const value = input as Record<string, unknown>;
      if (typeof value.groupId !== "string" || !value.groupId.trim()) throw invalid("groupId required");
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      if (method === "project.knowledge.get") return host.call(method, { groupId: value.groupId });
      if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) {
        throw invalid("a nonnegative expectedRevision required");
      }
      if (method === "project.knowledge.clearHistory") return host.call(method, { groupId: value.groupId, expectedRevision: value.expectedRevision });
      if (typeof value.entryId !== "string" || !value.entryId.trim()) throw invalid("entryId required");
      return host.call(method, { groupId: value.groupId, entryId: value.entryId, expectedRevision: value.expectedRevision });
    });
  }
}

function invalid(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}
