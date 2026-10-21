import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";
import { Host } from "../../../scripts/e2e/host.mjs";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createProjectWorkflowHostPort } = await import("../electron/main/services/project-workflow-host.ts");
const { registerProjectWorkflowIpc } = await import("../electron/main/ipc/project-workflow-ipc.ts");
const { createProjectWorkflowApi } = await import("../src/lib/project-workflow-api.ts");
const binary = process.env.PI_DESKTOP_HOST_BIN || resolve("target/debug/pi-desktop-host-core");

test("real Host user path preserves chats, adoption fences, candidate feedback and restart", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "project-workflow-host-"));
  const home = join(root, "home"), project = join(root, "project");
  await mkdir(home); await mkdir(project);
  const hostProcess = new Host(binary, join(root, "data"), { env: { HOME: home }, quiet: true });
  const handlers = new Map(), listeners = new Set(), opened = [];
  const port = createProjectWorkflowHostPort(() => hostProcess, (event) => { for (const listener of listeners) listener(event); });
  registerProjectWorkflowIpc({
    registrar: { handle() { assert.fail("user-only workflow endpoint"); },
      handleWithEvent: (channel, handler) => handlers.set(channel, handler), assertMainWindowSender: () => {} },
    host: port, getHost: () => hostProcess, getRuntime: () => null,
    openPath: async (path) => { opened.push(path); return ""; }, openExternal: async (url) => opened.push(url),
  });
  const api = createProjectWorkflowApi((channel, input) => handlers.get(channel)({ sender: { id: 1 } }, input),
    (channel, listener) => { assert.equal(channel, IPC.event.projectWorkflowChanged); listeners.add(listener); return () => listeners.delete(listener); });
  let serial = 0;
  const mutate = async (kind, fields) => api.mutate({ kind, commandId: `command-${++serial}`, expectedRevision: (await api.snapshot()).revision, ...fields });
  try {
    await hostProcess.start();
    const { group } = await hostProcess.call("project.group.create", { name: "Workflow project", folders: [project] });
    const projectId = group.id;
    const { session } = await hostProcess.call("session.create", { title: "Existing chat", mode: "agent", projectPath: project });
    const source = { kind: "user", ref: "explicit-user-action" }, stamp = "2026-10-20T00:00:00Z";
    const workstream = { id: "work-1", projectId, title: "Ship result", goal: "Produce a usable candidate", owner: { kind: "session", ref: session.id },
      acceptance: [{ id: "ac-1", title: "Candidate works", status: "pending", evidenceIds: [] }], status: "ready", priority: 0, order: 0,
      dependencyIds: [], nextAction: "Implement", revision: 0, decisionRevision: 0, createdAt: stamp, updatedAt: stamp };
    await mutate("workstream.create", { workstream });
    const changes = [];
    const unsubscribe = api.onChanged((event) => changes.push(event));
    await mutate("folder.create", { folder: { id: "folder-1", name: "Research", order: 0 } });
    await mutate("navigation.move", { sessionIds: [session.id], folderId: "folder-1" });
    await mutate("folder.remove", { folderId: "folder-1" });
    assert.equal((await api.snapshot()).navigation.find((row) => row.sessionId === session.id).folderId, undefined);
    assert.equal((await hostProcess.call("session.get", { id: session.id })).session.id, session.id);
    const overview = await api.snapshot({ projectId });
    assert.equal(overview.workstreams[0].owner.ref, session.id, "Project Console requires no active session");
    const decision = { id: "decision-1", projectId, workstreamId: "work-1", title: "Use local result", statement: "Use the local candidate", state: "proposed", sources: [source], createdAt: stamp };
    await mutate("decision.propose", { decision });
    await mutate("decision.resolve", { projectId, workstreamId: "work-1", decisionId: decision.id, resolution: "adopt", source });
    const staleRevision = (await api.snapshot()).revision - 1;
    await assert.rejects(api.mutate({ kind: "workstream.update", commandId: "stale-edit", expectedRevision: staleRevision,
      projectId, workstreamId: "work-1", patch: { goal: "Wrong stale goal" } }), { errorCode: "CONFLICT" });
    const path = join(project, "candidate.md"); await writeFile(path, "Recorded candidate revision 1");
    const artifact = { id: "candidate-1", projectId, workstreamId: "work-1", label: "Candidate 1", kind: "candidate",
      revision: "revision-1", environment: "local-test", entryPoint: path, source, createdAt: stamp };
    await mutate("artifact.put", { artifact });
    await mutate("workstream.update", { projectId, workstreamId: "work-1", patch: { currentCandidateId: artifact.id } });
    const evidence = { id: "evidence-1", projectId, workstreamId: "work-1", candidateId: artifact.id, candidateRevision: artifact.revision,
      environment: artifact.environment, scenario: "local-check", acceptanceId: "ac-1", outcome: "passed", kind: "integration",
      limits: "Synthetic local test; no live deployment", source, createdAt: stamp };
    await mutate("evidence.add", { evidence });
    assert.equal((await api.snapshot()).workstreams[0].acceptance[0].status, "pending", "test completion does not adopt acceptance");
    await mutate("workstream.update", { projectId, workstreamId: "work-1", patch: { acceptance: [{ id: "ac-1", title: "Candidate works", status: "satisfied", evidenceIds: [evidence.id] }] } });
    const feedback = { id: "feedback-1", projectId, workstreamId: "work-1", candidateId: artifact.id, candidateRevision: artifact.revision,
      environment: artifact.environment, acceptanceId: "ac-1", comment: "Fails with my input", source, createdAt: stamp };
    await mutate("feedback.add", { feedback });
    let state = await api.snapshot();
    assert.equal(state.workstreams[0].acceptance[0].status, "reopened");
    assert.equal(state.evidence[0].kind, "integration");
    assert.equal(state.feedback[0].candidateRevision, artifact.revision);
    await assert.rejects(mutate("feedback.add", { feedback: { ...feedback, id: "bad-feedback", candidateRevision: "wrong-revision" } }), { errorCode: "INVALID_ARGUMENT" });
    const openedReference = await api.openReference({ projectId, kind: "artifact", id: artifact.id });
    assert.equal(openedReference.revision, artifact.revision);
    assert.equal(opened.length, 1);
    assert.ok((await api.search({ query: "Candidate 1", projectId })).hits.some((hit) => hit.artifactId === artifact.id));
    assert.ok(changes.length >= 10);
    unsubscribe();
    await hostProcess.stop(); await hostProcess.start();
    state = await api.snapshot();
    assert.equal(state.workstreams[0].goal, workstream.goal);
    assert.equal(state.decisions[0].state, "effective");
    assert.equal(state.workstreams[0].acceptance[0].status, "reopened");
    assert.equal((await hostProcess.call("session.get", { id: session.id })).session.title, "Existing chat");
  } finally { await hostProcess.stop(); await rm(root, { recursive: true, force: true }); }
});
