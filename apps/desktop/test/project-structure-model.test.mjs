import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { projectSessionStructure, sessionTreeRoots, sessionTreeSelection } = await import(
  "../src/features/project-workflow/session-structure-model.ts"
);
const { projectOverview } = await import(
  "../src/features/project-workflow/project-overview-model.ts"
);
const { gitGraph } = await import("../src/features/project-workflow/git-structure-model.ts");
const empty = () => ({
  workstreams: [],
  conversations: [],
  runs: [],
  projectAgents: [],
  decisions: [],
  artifacts: [],
});
const session = (id, projectPath = "/project") => ({
  id,
  projectPath,
  title: id,
  updatedAt: "2026-10-21",
});
const work = (id, fields = {}) => ({ id, projectId: "p", status: "ready", order: 0, ...fields });
test("sessions derive only real parent edges and preserve unlinked, archived and missing sources", () => {
  const snapshot = empty();
  snapshot.workstreams = [work("w", { mainSessionId: "main" })];
  snapshot.projectAgents = [{ projectId: "p", sessionId: "agent" }];
  snapshot.conversations = [
    {
      projectId: "p",
      sessionId: "branch",
      workstreamId: "w",
      parentSessionId: "main",
      relation: "branch",
      archived: false,
    },
    {
      projectId: "p",
      sessionId: "child",
      workstreamId: "w",
      parentSessionId: "branch",
      relation: "child",
      archived: true,
    },
    {
      projectId: "p",
      sessionId: "orphan",
      workstreamId: "w",
      parentSessionId: "missing",
      relation: "branch",
    },
    {
      projectId: "p",
      sessionId: "from-history",
      workstreamId: "w",
      parentSessionId: "history-parent",
      relation: "branch",
    },
  ];
  snapshot.runs = [
    {
      projectId: "p",
      id: "run",
      sessionId: "legacy",
      workstreamId: "w",
      startedAt: "2026",
      updatedAt: "2026",
      effects: [],
    },
  ];
  const model = projectSessionStructure(
    snapshot,
    [
      session("main"),
      session("branch"),
      session("child"),
      session("history"),
      session("history-parent"),
      session("legacy", ""),
      session("agent", ""),
      session("other", "/elsewhere"),
    ],
    "p",
    ["/project/"],
  );
  assert.equal(model.byId.get("branch").parentId, "main");
  assert.equal(model.byId.get("child").parentId, "branch");
  assert.equal(
    model.byId.get("legacy").parentId,
    undefined,
    "run membership must not invent a parent",
  );
  assert.equal(model.byId.get("history").unlinked, true);
  assert.equal(
    model.byId.get("history-parent").unlinked,
    false,
    "an ancestor must not also appear in unlinked history",
  );
  assert.equal(model.byId.get("missing").externalSource, true);
  assert.equal(model.byId.get("missing").session, undefined);
  assert.equal(model.byId.has("other"), false);
  const filtered = sessionTreeSelection(model.nodes, "w", (node) => !!node.link?.archived);
  assert.deepEqual(new Set(filtered.map((node) => node.id)), new Set(["main", "branch", "child"]));
  assert.deepEqual(
    sessionTreeRoots(filtered).map((node) => node.id),
    ["main"],
  );
});
test("overview projects Host acceptance, never completion of a run", () => {
  const snapshot = empty();
  snapshot.workstreams = [
    work("open", {
      status: "blocked",
      blocker: { reason: "Review", owner: "user", resumeWhen: "Accepted" },
      acceptance: [{ status: "pending" }],
    }),
    work("done", { status: "completed", order: 1 }),
    { ...work("foreign"), projectId: "q" },
  ];
  snapshot.runs = [
    { projectId: "p", id: "completed-run", workstreamId: "open", state: "completed", effects: [] },
    {
      projectId: "p",
      id: "unknown-effect",
      workstreamId: "open",
      state: "completed",
      effects: [{ state: "unknown" }],
    },
  ];
  snapshot.decisions = [{ id: "d", projectId: "p", state: "proposed", createdAt: "2026" }];
  const view = projectOverview(snapshot, "p");
  assert.equal(view.completed, 1);
  assert.equal(view.current[0].acceptance[0].status, "pending");
  assert.equal(view.blockers[0].blocker.owner, "user");
  assert.deepEqual(
    view.unknownRuns.map((run) => run.id),
    ["unknown-effect"],
  );
  assert.equal(view.decisions.length, 1);
});
test("Git graph connects merges to both actual parents and marks truncated ancestry", () => {
  const commits = [
    { oid: "merge", parents: ["left", "right"] },
    { oid: "left", parents: ["base"] },
    { oid: "right", parents: ["base"] },
    { oid: "base", parents: ["outside"] },
  ];
  const graph = gitGraph(commits);
  assert.equal(graph.width, 2);
  assert.deepEqual(
    graph.nodes[0].parents.map((parent) => parent.oid),
    ["left", "right"],
  );
  assert.deepEqual(
    graph.nodes[0].parents.map((parent) => parent.row),
    [1, 2],
  );
  assert.equal(graph.nodes[3].parents[0].row, undefined);
  assert.equal(graph.nodes[1].parents[0].column, graph.nodes[2].parents[0].column);
});

const { architectureRevisionState } = await import(
  "../src/features/project-workflow/architecture-structure-model.ts"
);
test("architecture match needs a complete trusted repository read", () => {
  const artifact = { repositoryRevision: "abc" };
  const repo = { head: "abc", changes: { files: [] } };
  assert.equal(architectureRevisionState(artifact, repo), "matches");
  assert.equal(
    architectureRevisionState(artifact, { ...repo, error: "diff unavailable" }),
    "unknown",
  );
  assert.equal(
    architectureRevisionState(artifact, { ...repo, changes: { files: [], truncated: true } }),
    "unknown",
  );
  assert.equal(
    architectureRevisionState(artifact, { ...repo, changes: { files: [{ path: "source.ts" }] } }),
    "stale",
  );
  assert.equal(architectureRevisionState(artifact, { ...repo, head: "def" }), "stale");
  assert.equal(architectureRevisionState({}, repo), "unknown");
});
