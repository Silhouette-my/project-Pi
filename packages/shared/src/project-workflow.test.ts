import { describe, expect, it } from "vitest";
import * as Value from "typebox/value";
import { IPC, IPC_WHITELIST } from "./protocol.js";
import { projectWorkflowFixture, workflowFixtureWorkstream } from "./project-workflow-fixtures.js";
import { ProjectWorkflowSnapshotSchema, emptyProjectWorkflowSnapshot, isProjectWorkflowAction,
  isProjectWorkflowCommand, isProjectWorkflowUserCommand } from "./project-workflow.js";

describe("project workflow boundary", () => {
  it("starts at revision zero and validates representative records", () => {
    expect(emptyProjectWorkflowSnapshot().revision).toBe(0);
    expect(Value.Check(ProjectWorkflowSnapshotSchema, projectWorkflowFixture())).toBe(true);
    expect(isProjectWorkflowUserCommand({ kind: "workstream.create", commandId: "create-1", expectedRevision: 0,
      workstream: workflowFixtureWorkstream })).toBe(true);
  });
  it("rejects untyped payloads, stale-shape records and runtime mutations on user surface", () => {
    const runtime = { kind: "workstream.transition", commandId: "transition-1", expectedRevision: 0,
      projectId: "project-1", workstreamId: "work-1", status: "executing", nextAction: "Check" };
    expect(isProjectWorkflowCommand(runtime)).toBe(true);
    expect(isProjectWorkflowUserCommand(runtime)).toBe(false);
    expect(isProjectWorkflowCommand({ ...runtime, extraAuthority: true })).toBe(false);
    expect(isProjectWorkflowCommand({ ...runtime, expectedRevision: -1 })).toBe(false);
    expect(isProjectWorkflowCommand({ ...runtime, status: "done" })).toBe(false);
  });
  it("requires explicit action scope and authorization at execution start", () => {
    const start = { kind: "start", commandId: "start-1", expectedRevision: 0, projectId: "project-1", workstreamId: "work-1" };
    expect(isProjectWorkflowAction(start)).toBe(false);
    expect(isProjectWorkflowAction({ ...start, authorizationId: "grant-1" })).toBe(true);
    expect(isProjectWorkflowAction({ ...start, kind: "pause" })).toBe(true);
  });
  it("exposes only named workflow channels through preload", () => {
    for (const name of ["projectWorkflowSnapshot", "projectWorkflowMutate", "projectWorkflowAction", "projectWorkflowSearch"] as const) {
      expect(IPC_WHITELIST.has(IPC.invoke[name])).toBe(true);
    }
    expect(IPC_WHITELIST.has(IPC.event.projectWorkflowChanged)).toBe(true);
    expect(IPC_WHITELIST.has("project.workflow.mutate")).toBe(false);
  });
});
