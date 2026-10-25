import { describe, expect, it } from "vitest";
import * as Value from "typebox/value";
import { IPC, IPC_WHITELIST } from "./protocol.js";
import { projectWorkflowFixture, workflowFixtureWorkstream } from "./project-workflow-fixtures.js";
import { ProjectWorkflowSnapshotSchema, emptyProjectWorkflowSnapshot, isProjectWorkflowAction,
  isProjectWorkflowCommand, isProjectWorkflowUserCommand } from "./project-workflow.js";

describe("project workflow boundary", () => {
  it("accepts additive navigation trees without requiring new fields in old snapshots", () => {
    const legacy = emptyProjectWorkflowSnapshot();
    expect(Value.Check(ProjectWorkflowSnapshotSchema, legacy)).toBe(true);
    const snapshot = { ...legacy, folders: [{ id: "folder", name: "Project chats", scope: "project", projectId: "p", order: 0 }], projectNavigation: [{ projectId: "p", folderId: "category", order: 0 }] };
    expect(Value.Check(ProjectWorkflowSnapshotSchema, snapshot)).toBe(true);
    const move = { kind: "tree.move", commandId: "tree-1", expectedRevision: 0, target: { kind: "session", id: "s" }, scope: "project", projectId: "p", folderId: "folder", order: 0, siblingOrder: [{ kind: "session", id: "s" }, { kind: "folder", id: "nested" }] };
    expect(isProjectWorkflowUserCommand(move)).toBe(true);
    expect(isProjectWorkflowUserCommand({ ...move, scope: "workspace" })).toBe(false);
    expect(isProjectWorkflowUserCommand({ ...move, target: { kind: "workspace", id: "s" } })).toBe(false);
  });
  it("accepts user categories and category placement as additive fields", () => {
    const base = emptyProjectWorkflowSnapshot();
    const snapshot = { ...base, categories: [{ id: "k1", name: "Reading", order: 0 }],
      folders: [{ id: "f", name: "Papers", categoryId: "k1", order: 0 }],
      navigation: [{ sessionId: "s", categoryId: "k1", order: 1, favorite: false }],
      projectNavigation: [{ projectId: "p", categoryId: "k1", order: 2 }] };
    expect(Value.Check(ProjectWorkflowSnapshotSchema, snapshot)).toBe(true);
    for (const body of [
      { kind: "category.create", category: { id: "k2", name: "Archive", order: 1 } },
      { kind: "category.update", category: { id: "k1", name: "Renamed", order: 0 } },
      { kind: "category.remove", categoryId: "k1" },
      { kind: "category.reorder", categoryIds: ["projects", "k1", "chats"] },
      { kind: "tree.move", target: { kind: "project", id: "p" }, scope: "chats", categoryId: "k1", order: 0 },
    ]) expect(isProjectWorkflowUserCommand({ commandId: "c", expectedRevision: 0, ...body })).toBe(true);
    expect(isProjectWorkflowUserCommand({ commandId: "c", expectedRevision: 0, kind: "category.remove" })).toBe(false);
    expect(Value.Check(ProjectWorkflowSnapshotSchema, { ...snapshot, categoryOrder: ["projects", "chats", "k1"] })).toBe(true);
    expect(Value.Check(ProjectWorkflowSnapshotSchema, { ...snapshot, categoryOrder: [1] })).toBe(false);
  });
  it("treats the project favourite flag as optional and the command as user-owned", () => {
    const base = emptyProjectWorkflowSnapshot();
    for (const row of [{ projectId: "p", order: 0 }, { projectId: "p", order: 0, favorite: true }])
      expect(Value.Check(ProjectWorkflowSnapshotSchema, { ...base, projectNavigation: [row] })).toBe(true);
    expect(Value.Check(ProjectWorkflowSnapshotSchema, { ...base, projectNavigation: [{ projectId: "p", order: 0, favorite: "yes" }] })).toBe(false);
    const star = { kind: "project.favorite", commandId: "c", expectedRevision: 0, projectId: "p", favorite: true };
    expect(isProjectWorkflowUserCommand(star)).toBe(true);
    expect(isProjectWorkflowUserCommand({ ...star, order: 3 })).toBe(true);
    expect(isProjectWorkflowUserCommand({ ...star, favorite: "yes" })).toBe(false);
    expect(isProjectWorkflowUserCommand({ ...star, projectId: undefined })).toBe(false);
  });
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
