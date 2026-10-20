import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { emptyProjectWorkflowSnapshot } from "@pi-desktop/shared";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { openProjectWorkflowReference } = await import("../electron/main/services/project-workflow-reference.ts");

test("recorded candidate opens inside its own project without changing the active session", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-reference-"));
  try {
    const project = join(root, "project"), outside = join(root, "outside");
    await mkdir(project); await mkdir(outside);
    const candidate = join(project, "candidate.md"), secret = join(outside, "not-project.md");
    await writeFile(candidate, "candidate revision 2"); await writeFile(secret, "outside");
    await symlink(secret, join(project, "escape.md"));
    const state = emptyProjectWorkflowSnapshot();
    const source = { kind: "user", ref: "source-1" };
    const artifact = { id: "candidate-2", projectId: "project-1", workstreamId: "work-1", label: "Candidate",
      kind: "candidate", revision: "revision-2", environment: "local", entryPoint: candidate, source, createdAt: "now" };
    state.artifacts.push(artifact);
    const opened = [];
    const dependencies = { host: { snapshot: async () => state },
      getHost: () => ({ async call(method) {
        assert.equal(method, "project.groups.list");
        return { groups: [{ id: "project-1", primaryPath: project, roots: [{ path: project }] }] };
      } }),
      openPath: async (path) => { opened.push(path); return ""; },
      openExternal: async (url) => opened.push(url),
    };
    assert.deepEqual(await openProjectWorkflowReference(dependencies, { projectId: "project-1", kind: "artifact", id: "candidate-2" }),
      { opened: true, uri: await realpath(candidate), revision: "revision-2" });
    artifact.entryPoint = join(project, "escape.md");
    await assert.rejects(openProjectWorkflowReference(dependencies, { projectId: "project-1", kind: "artifact", id: "candidate-2" }), { errorCode: "UNAUTHORIZED" });
    await assert.rejects(openProjectWorkflowReference(dependencies, { projectId: "project-2", kind: "artifact", id: "candidate-2" }), { errorCode: "NOT_FOUND" });
    artifact.entryPoint = "javascript:alert(1)";
    await assert.rejects(openProjectWorkflowReference(dependencies, { projectId: "project-1", kind: "artifact", id: "candidate-2" }), { errorCode: "UNAUTHORIZED" });
    assert.equal(opened.length, 1);
    artifact.entryPoint = "https://example.com/candidates/revision-2";
    assert.equal((await openProjectWorkflowReference(dependencies, { projectId: "project-1", kind: "artifact", id: "candidate-2" })).revision, "revision-2");
    assert.equal(opened[1], artifact.entryPoint);
  } finally { await rm(root, { recursive: true, force: true }); }
});
