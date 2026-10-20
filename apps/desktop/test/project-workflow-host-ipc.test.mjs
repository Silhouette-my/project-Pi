import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { IPC, emptyProjectWorkflowSnapshot } from "@pi-desktop/shared";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerProjectWorkflowIpc } = await import("../electron/main/ipc/project-workflow-ipc.ts");
const { createProjectWorkflowHostPort, workflowChange } = await import("../electron/main/services/project-workflow-host.ts");

function fixture() {
  const handlers = new Map(), events = [], calls = [], actions = [];
  let state = emptyProjectWorkflowSnapshot();
  const commands = new Set();
  const connection = { async call(method, input) {
    calls.push({ method, input });
    if (method === "project.workflow.snapshot") return state;
    if (method === "project.workflow.search") return { hits: [] };
    if (commands.has(input.commandId)) return { snapshot: state, replayed: true };
    if (input.expectedRevision !== state.revision) throw Object.assign(new Error("Revision conflict"), { errorCode: "CONFLICT" });
    commands.add(input.commandId);
    state = { ...state, revision: state.revision + 1 };
    return { snapshot: state, replayed: false };
  } };
  const host = createProjectWorkflowHostPort(() => connection, (event) => events.push(event));
  let runtime = { async action(action) { actions.push(action); return { snapshot: state }; } };
  registerProjectWorkflowIpc({
    registrar: {
      handle() { assert.fail("Workflow user channels must not enter the external-agent invoke map"); },
      handleWithEvent(channel, handler) { handlers.set(channel, handler); },
      assertMainWindowSender(event) { if (event.sender.id !== 1) throw Object.assign(new Error("Wrong sender"), { errorCode: "PERMISSION_DENIED" }); },
    }, host, getHost: () => connection, getRuntime: () => runtime,
  });
  return { host, events, calls, actions, disconnectRuntime: () => { runtime = null; },
    invoke: (name, input, sender = 1) => handlers.get(IPC.invoke[name])({ sender: { id: sender } }, input) };
}

test("user workflow path reads, mutates, publishes once and keeps typed revision errors", async () => {
  const f = fixture();
  assert.equal((await f.invoke("projectWorkflowSnapshot")).revision, 0);
  const command = { commandId: "create-folder", expectedRevision: 0, kind: "folder.create", folder: { id: "folder-1", name: "Reading", order: 0 } };
  assert.equal((await f.invoke("projectWorkflowMutate", command)).snapshot.revision, 1);
  assert.equal((await f.invoke("projectWorkflowMutate", command)).replayed, true);
  assert.deepEqual(f.events, [{ revision: 1, commandId: "create-folder", kind: "folder.create" }]);
  await assert.rejects(f.invoke("projectWorkflowMutate", { ...command, commandId: "stale" }), { errorCode: "CONFLICT" });
  assert.deepEqual(await f.invoke("projectWorkflowSearch", { query: "reading" }), { hits: [] });
});

test("renderer cannot forge runtime observations, plugin provenance or use a foreign window", async () => {
  const f = fixture();
  const transition = { commandId: "transition", expectedRevision: 0, kind: "workstream.transition",
    projectId: "project-1", workstreamId: "work-1", status: "executing", nextAction: "Check" };
  await assert.rejects(f.invoke("projectWorkflowMutate", transition), { errorCode: "INVALID_ARGUMENT" });
  await assert.rejects(f.invoke("projectWorkflowSnapshot", {}, 2), { errorCode: "PERMISSION_DENIED" });
  assert.equal(f.calls.length, 0);
  await f.host.mutate(transition);
  assert.equal(f.events[0].workstreamId, "work-1");
});

test("explicit runtime intents use the owner port and unavailable execution stays a failure", async () => {
  const f = fixture();
  const action = { commandId: "pause", expectedRevision: 0, kind: "pause", projectId: "project-1", workstreamId: "work-1" };
  await f.invoke("projectWorkflowAction", action);
  assert.deepEqual(f.actions, [action]);
  await assert.rejects(f.invoke("projectWorkflowAction", { ...action, kind: "start" }), { errorCode: "INVALID_ARGUMENT" });
  f.disconnectRuntime();
  await assert.rejects(f.invoke("projectWorkflowAction", action), { errorCode: "AGENT_UNAVAILABLE" });
});

test("project-wide resource changes are not mislabeled as a workstream event", () => {
  const command = { commandId: "resource-1", expectedRevision: 0, kind: "resource.put",
    resource: { id: "constraint-1", projectId: "project-1", label: "Constraint", uri: "CONSTRAINTS.md", kind: "constraint",
      revision: "revision-1", updatedAt: "now", state: "effective", source: { kind: "user", ref: "source-1" } } };
  assert.deepEqual(workflowChange(command, 1), { commandId: "resource-1", kind: "resource.put", revision: 1, projectId: "project-1" });
  assert.equal(workflowChange({ ...command, resource: { ...command.resource, workstreamId: "work-1" } }, 2).workstreamId, "work-1");
});
