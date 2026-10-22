import assert from "node:assert/strict";
import test from "node:test";

const {
  buildQuotedAnswer,
  buildSendContent,
  exchangesOf,
  lastExchanges,
  latestAnswer,
  listConversationTargets,
  renderExchanges,
  withAttribution,
  MAX_FORWARD_CHARS,
} = await import("../src/features/project-panel/project-panel-text.ts");

const message = (id, role, content) => ({ id, role, content, createdAt: "2026-01-01T00:00:00Z" });
const labels = { user: "You", agent: "Agent" };
const transcript = [
  message("1", "user", "What is the goal?"),
  message("2", "assistant", "Ship the console."),
  message("3", "user", "And the risks?"),
  message("4", "assistant", "First part."),
  message("5", "assistant", "Second part."),
  message("6", "tool", "ignored"),
  message("7", "user", "Thanks"),
  message("8", "assistant", "   "),
];

test("the latest answer is the newest assistant message with visible text", () => {
  assert.equal(latestAnswer(transcript), "Second part.");
  assert.equal(latestAnswer([message("1", "user", "hi")]), undefined);
  assert.equal(latestAnswer([]), undefined);
});

test("exchanges group a question with everything said back", () => {
  const exchanges = exchangesOf(transcript);
  assert.deepEqual(exchanges, [
    { user: "What is the goal?", assistant: "Ship the console." },
    { user: "And the risks?", assistant: "First part.\n\nSecond part." },
    { user: "Thanks", assistant: "" },
  ]);
  assert.equal(lastExchanges(transcript, 1).length, 1);
  assert.equal(lastExchanges(transcript, 3).length, 3);
  assert.equal(lastExchanges(transcript, "all").length, 3);
  assert.deepEqual(lastExchanges(transcript, 1), [{ user: "Thanks", assistant: "" }]);
});

test("send content follows the chosen scope and is attributed once", () => {
  assert.equal(buildSendContent(transcript, { kind: "latest" }, labels), "Second part.");
  assert.equal(
    buildSendContent(transcript, { kind: "exchanges", count: 3 }, labels),
    [
      "You: What is the goal?",
      "Agent: Ship the console.",
      "You: And the risks?",
      "Agent: First part.\n\nSecond part.",
      "You: Thanks",
    ].join("\n\n"),
  );
  assert.equal(renderExchanges([], labels), "");
  assert.equal(
    withAttribution("From the project Agent:", "Second part."),
    "From the project Agent:\n\nSecond part.",
  );
  // Nothing to say means nothing to send, not a bare attribution line.
  assert.equal(withAttribution("From the project Agent:", "  "), "");
  assert.equal(buildSendContent([message("1", "user", "hi")], { kind: "latest" }, labels), "");
});

test("long content is cut at the limit without splitting a surrogate pair", () => {
  const long = [message("1", "assistant", `${"a".repeat(MAX_FORWARD_CHARS - 1)}😀tail`)];
  const out = buildSendContent(long, { kind: "latest" }, labels);
  assert.ok(out.endsWith("…"));
  assert.ok(!/[\uD800-\uDBFF]…$/.test(out));
});

test("a quoted answer is a blockquote followed by its attribution", () => {
  assert.equal(
    buildQuotedAnswer("Line one\n\nLine two", "Quoted from Plan"),
    "> Line one\n>\n> Line two\n\nQuoted from Plan",
  );
});

test("conversation targets cover workstream mains, side conversations and chats, never the Agent", () => {
  const snapshot = {
    projectAgents: [{ projectId: "p1", sessionId: "agent" }],
    workstreams: [
      { id: "w2", projectId: "p1", title: "Second", order: 2, mainSessionId: "main-2" },
      { id: "w1", projectId: "p1", title: "First", order: 1, mainSessionId: "main-1" },
      { id: "w3", projectId: "other", title: "Elsewhere", order: 0, mainSessionId: "main-3" },
    ],
    conversations: [
      { sessionId: "side-a", projectId: "p1", workstreamId: "w1", relation: "branch", purpose: "explore", archived: false, order: 1 },
      { sessionId: "side-old", projectId: "p1", workstreamId: "w1", relation: "branch", purpose: "ask", archived: true, order: 2 },
      { sessionId: "main-1", projectId: "p1", workstreamId: "w1", relation: "main", purpose: "work", archived: false, order: 0 },
    ],
  };
  const sessions = [
    { id: "agent", title: "Agent", projectPath: "/repo" },
    { id: "main-1", title: "First main", projectPath: "/repo" },
    { id: "side-a", title: "Auth exploration", projectPath: "/repo" },
    { id: "chat-1", title: "", projectPath: "/repo/app" },
    { id: "elsewhere", title: "Other", projectPath: "/other" },
  ];
  const targets = listConversationTargets({
    snapshot,
    projectId: "p1",
    sessions,
    inProject: (path) => Boolean(path?.startsWith("/repo")),
    untitled: "Untitled",
  });
  assert.deepEqual(
    targets.map((item) => [item.sessionId, item.kind, item.title]),
    [
      ["main-1", "workstream", "First main"],
      ["main-2", "workstream", "Second"],
      ["side-a", "side", "Auth exploration"],
      ["chat-1", "chat", "Untitled"],
    ],
  );
  assert.equal(targets.find((item) => item.sessionId === "side-a").purpose, "explore");
  assert.deepEqual(listConversationTargets({ snapshot: null, projectId: "p1", sessions, inProject: () => true, untitled: "x" }), []);
});
