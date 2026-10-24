import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  MAX_RETURN_TITLE_CHARS,
  agentReturnBlockReason,
  agentReturnPillLabel,
  resolveReturnTarget,
  sideReturnBlockReason,
  sideReturnContent,
} = await import("../src/features/project-panel/project-return-core.ts");
const { sideSourceTitle } = await import("../src/features/project-panel/side-source.ts");

const target = (sessionId, kind = "chat", title = sessionId) => ({ sessionId, title, kind });
const targets = [target("chat-a"), target("main-1", "workstream"), target("side-1", "side"), target("chat-b")];

test("the Agent returns to the user's pick, else where they came from, else the first workstream main", () => {
  assert.equal(resolveReturnTarget(targets, "chat-b", "chat-a").sessionId, "chat-b");
  assert.equal(resolveReturnTarget(targets, undefined, "side-1").sessionId, "side-1");
  assert.equal(resolveReturnTarget(targets, undefined, undefined).sessionId, "main-1");
  // A pick or a last conversation that left the project falls through.
  assert.equal(resolveReturnTarget(targets, "gone", "also-gone").sessionId, "main-1");
  assert.equal(resolveReturnTarget([target("only")], undefined, undefined).sessionId, "only");
  assert.equal(resolveReturnTarget([], "x", "y"), undefined);
});

test("the Agent return gate names the first thing the user can fix", () => {
  const ok = { hasTarget: true, running: false, hasAnswer: true };
  assert.equal(agentReturnBlockReason(ok), undefined);
  assert.equal(agentReturnBlockReason({ ...ok, running: true }), "workPanel.return.busy");
  assert.equal(agentReturnBlockReason({ ...ok, hasAnswer: false }), "workPanel.return.nothing");
  assert.equal(agentReturnBlockReason({ ...ok, hasTarget: false }), "workPanel.return.noTarget");
  assert.equal(
    agentReturnBlockReason({ hasTarget: false, running: true, hasAnswer: false }),
    "workPanel.return.busy",
  );
});

test("the side return gate waits for the reply and needs an answer", () => {
  assert.equal(sideReturnBlockReason({ running: false, hasAnswer: true }), undefined);
  assert.equal(sideReturnBlockReason({ running: true, hasAnswer: true }), "workPanel.return.busy");
  assert.equal(sideReturnBlockReason({ running: false, hasAnswer: false }), "workPanel.return.nothing");
});

test("a side conversation returns its newest answer, titled by its first words", () => {
  const messages = [
    { role: "user", content: "Is 6px enough?" },
    { role: "assistant", content: "## Yes\n\nKeep **6px** spacing in dark mode too." },
    { role: "user", content: "And light?" },
    { role: "assistant", content: "   " },
    { role: "tool", content: "ignored" },
  ];
  const content = sideReturnContent(messages);
  assert.equal(content.text, "## Yes\n\nKeep **6px** spacing in dark mode too.");
  assert.equal(content.title, "Yes Keep 6px spacing in dark mode too.");
  assert.equal(sideReturnContent([{ role: "user", content: "hi" }]), undefined);
  assert.equal(sideReturnContent(undefined), undefined);
});

test("a long answer gives a bounded one-line title", () => {
  const content = sideReturnContent([{ role: "assistant", content: `word ${"x".repeat(200)}` }]);
  assert.ok(Array.from(content.title).length <= MAX_RETURN_TITLE_CHARS);
  assert.ok(content.title.endsWith("…"));
  assert.equal(content.text.length, 205);
});

test("the Agent pill names the target only while a mode returns", () => {
  const text = {
    pill: (mode) => `Return: ${mode}`,
    pillTarget: (mode, to) => `Return: ${mode} → ${to}`,
  };
  assert.equal(agentReturnPillLabel("None", "none", "Main", text), "Return: None");
  assert.equal(agentReturnPillLabel("Summary", "summary", "Main", text), "Return: Summary → Main");
  assert.equal(agentReturnPillLabel("Summary", "summary", undefined, text), "Return: Summary");
});

test("a returned proposal's source reads as its side conversation, never a main", () => {
  const snapshot = {
    conversations: [
      { sessionId: "side", relation: "child" },
      { sessionId: "main", relation: "main" },
    ],
  };
  const sessions = [
    { id: "side", title: " Row spacing " },
    { id: "main", title: "Main" },
  ];
  assert.equal(sideSourceTitle(snapshot, sessions, { kind: "session", ref: "side" }, "Untitled"), "Row spacing");
  assert.equal(sideSourceTitle(snapshot, sessions, { kind: "session", ref: "main" }, "Untitled"), undefined);
  assert.equal(sideSourceTitle(snapshot, sessions, { kind: "user", ref: "side" }, "Untitled"), undefined);
  assert.equal(sideSourceTitle(snapshot, [], { kind: "session", ref: "side" }, "Untitled"), "Untitled");
  assert.equal(sideSourceTitle(null, sessions, { kind: "session", ref: "side" }, "Untitled"), undefined);
});

test("the Agent, side conversation and chat side chat share the floating return control", async () => {
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const agent = await read("../src/features/project-panel/ProjectAgentTab.tsx");
  const side = await read("../src/features/project-panel/ProjectSideTab.tsx");
  for (const source of [agent, side]) {
    assert.match(source, /<FloatingReturnBar/);
    assert.match(source, /showAction=\{/);
    assert.doesNotMatch(source, /project-panel-context|project-panel-actions|<Badge|Dialog/);
  }
  // The Agent's menu carries modes and a target section; a side's modes are the Host policy.
  assert.match(agent, /id: "mode"[\s\S]*id: "target"/);
  assert.match(side, /kind: "conversation\.policy"/);
  assert.match(side, /kind: "conversation\.return"/);
  // The dialogs and the direct send are gone.
  for (const gone of ["BringInDialog", "SendToConversationDialog", "ProjectPanelDialog"]) {
    await assert.rejects(read(`../src/features/project-panel/${gone}.tsx`), { code: "ENOENT" });
  }
  const ret = await read("../src/features/project-panel/project-agent-return.ts");
  assert.doesNotMatch(ret, /sendPrompt\([^)]*target/);
  assert.match(ret, /insertIntoComposerDraft/);
});
