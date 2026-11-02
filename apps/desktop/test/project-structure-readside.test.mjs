import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createProjectStructureService } = await import("../electron/main/services/project-structure.ts");
const { registerProjectWorkflowIpc } = await import("../electron/main/ipc/project-workflow-ipc.ts");
const { createProjectStructureApi } = await import("../src/lib/project-structure-api.ts");

test("structure API resolves only the requested Host project and root, independent of active session", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-structure-scope-"));
  try {
    const roots = await Promise.all(["a", "a-second", "b"].map(async (name) => { const path = join(base, name); await mkdir(path); await writeFile(join(path, "file.ts"), name); return realpath(path); }));
    const groups = [{ id: "a", name: "A", primaryPath: roots[0], roots: roots.slice(0, 2).map((path) => ({ path, name: path })) }, { id: "b", name: "B", primaryPath: roots[2], roots: [{ path: roots[2], name: "B" }] }, { id: "remote", remote: { hostKey: "host", path: "/remote" }, roots: [] }];
    const calls = [];
    const service = createProjectStructureService(() => ({ async call(method) { calls.push(method); assert.equal(method, "project.groups.list"); return { groups }; } }));
    const files = await service.readFile({ projectId: "a", rootId: roots[1], kind: "source", relativePath: "file.ts" });
    assert.equal(files.content, "a-second"); assert.equal(files.currentWorkingFile, true);
    const snapshot = await service.gitSnapshot({ projectId: "a" }); assert.equal(snapshot.repositories.length, 2); assert.equal(snapshot.repositories[1].rootId, roots[1]);
    await assert.rejects(service.readFile({ projectId: "a", rootId: roots[2], kind: "source", relativePath: "file.ts" }), { errorCode: "UNAUTHORIZED" });
    await assert.rejects(service.gitSnapshot({ projectId: "missing" }), { errorCode: "NOT_FOUND" });
    await assert.rejects(service.architectureSnapshot({ projectId: "remote" }), { errorCode: "UNSUPPORTED" });
    await assert.rejects(service.gitDiff({ projectId: "a", rootId: roots[0], commit: "--output=bad" }), /full commit/);
    await assert.rejects(service.readFile({ projectId: "a", rootId: roots[0], relativePath: "../b/file.ts", kind: "source" }), /relative/);
    await assert.rejects(service.gitSnapshot({ projectId: "a", absolutePath: roots[2] }), { errorCode: "INVALID_ARGUMENT" });
    assert.ok(calls.length > 0);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("all structure channels require the main window and the renderer uses those exact channels", async () => {
  const handlers = new Map();
  registerProjectWorkflowIpc({
    registrar: { handle() { assert.fail("Structure reads are not external-agent channels"); }, handleWithEvent(channel, handler) { handlers.set(channel, handler); }, assertMainWindowSender(event) { if (event.sender !== "main") throw new Error("Wrong sender"); } },
    host: {}, getHost: () => ({ async call() { return { groups: [] }; } }), getRuntime: () => null,
  });
  const invoke = async (channel, input) => { assert.ok(handlers.has(channel)); return handlers.get(channel)({ sender: "main" }, input); };
  const api = createProjectStructureApi(invoke);
  for (const name of ["projectStructureGitSnapshot", "projectStructureGitDiff", "projectStructureArchitectureSnapshot", "projectStructureReadFile"]) {
    await assert.rejects(handlers.get(IPC.invoke[name])({ sender: "plugin" }, {}), /Wrong sender/);
  }
  await assert.rejects(api.gitSnapshot({ projectId: "missing" }), { errorCode: "NOT_FOUND" });
  await assert.rejects(api.gitDiff({ projectId: "missing", rootId: "/tmp" }), { errorCode: "NOT_FOUND" });
  await assert.rejects(api.architectureSnapshot({ projectId: "missing" }), { errorCode: "NOT_FOUND" });
  await assert.rejects(api.readFile({ projectId: "missing", rootId: "/tmp", relativePath: "file", kind: "source" }), { errorCode: "NOT_FOUND" });
});
