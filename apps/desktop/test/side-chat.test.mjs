import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SIDE_CHAT_RETURN_MODE,
  MAX_SUMMARY_QUOTE_CHARS,
  MAX_TRANSCRIPT_QUOTE_CHARS,
  SideChatReturnError,
  anchorExcerptLine,
  buildSummaryQuote,
  buildTranscriptQuote,
  createSideChatSender,
  newestAssistantAnswer,
  runSideChatSummary,
  sideChatFirstSendBlockReason,
  sideChatReturnBlockReason,
  sideChatTurns,
} from "../src/features/chat/side-chat/side-chat-core.ts";
import {
  appendComposerDraftText,
  readComposerDraft,
  readComposerDraftRevision,
  resetComposerDraftCache,
  writeComposerDraft,
} from "../src/lib/composer-draft-cache.ts";
import {
  closeWorkPanelTabState,
  isKnownWorkPanelTab,
  openWorkPanelTabState,
  patchWorkPanelTabState,
  sanitizeWorkPanelTabsState,
  sideChatTabChildId,
  sideChatWorkPanelTab,
} from "../src/lib/work-panel-tabs.ts";

const anchor = { parentSessionId: "p1", anchorMessageId: "m1", excerpt: "hello" };

const quoteText = {
  label: "Summary",
  attribution: "Quoted from Side",
};

test("a summary quote is a labelled blockquote followed by the attribution line", () => {
  assert.equal(
    buildSummaryQuote("one\r\n\ntwo  ", quoteText),
    "> **Summary**\n>\n> one\n>\n> two\n\nQuoted from Side",
  );
});

test("a summary body is capped at 4000 characters with an ellipsis", () => {
  const out = buildSummaryQuote("x".repeat(MAX_SUMMARY_QUOTE_CHARS + 50), quoteText);
  const body = out.split("\n").at(-3).slice(2);
  assert.equal(body.length, MAX_SUMMARY_QUOTE_CHARS);
  assert.ok(body.endsWith("…"));
  assert.ok(!buildSummaryQuote("x".repeat(MAX_SUMMARY_QUOTE_CHARS), quoteText).includes("…"));
});

test("a summary cut never splits a surrogate pair", () => {
  const out = buildSummaryQuote(`${"a".repeat(MAX_SUMMARY_QUOTE_CHARS - 2)}😀tail`, quoteText);
  assert.ok(!/[\uD800-\uDBFF]…/.test(out));
});

const transcriptText = {
  label: "Side chat transcript",
  attribution: "Quoted from Side",
  roles: { user: "You", assistant: "Assistant" },
  truncated: (count) => `${count} earlier messages omitted`,
};

test("side turns skip the fork prefix, tool rows, thinking-only and empty messages", () => {
  const rows = [
    { role: "user", content: "parent question" },
    { role: "assistant", content: "parent answer" },
    { role: "user", content: " side question " },
    { role: "tool", content: "ls output" },
    { role: "assistant", content: "" },
    { role: "assistant", content: "side answer" },
  ];
  assert.deepEqual(sideChatTurns(rows, 2), [
    { role: "user", text: "side question" },
    { role: "assistant", text: "side answer" },
  ]);
  assert.equal(sideChatTurns(rows, 99).length, 0);
  assert.equal(sideChatTurns(rows, -1).length, 4);
});

test("a transcript quote labels roles in order and ends with the attribution", () => {
  const out = buildTranscriptQuote(
    [
      { role: "user", text: "why?\nbecause" },
      { role: "assistant", text: "so" },
    ],
    transcriptText,
  );
  assert.equal(
    out,
    "> **Side chat transcript**\n>\n> **You:** why?\n> because\n>\n> **Assistant:** so\n\nQuoted from Side",
  );
});

test("a long transcript keeps the newest exchanges and says how many were omitted", () => {
  const turns = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    text: `${index}`.repeat(3000),
  }));
  const out = buildTranscriptQuote(turns, transcriptText);
  assert.ok(out.includes("_7 earlier messages omitted_"));
  assert.ok(out.includes("9".repeat(3000)) && out.includes("7".repeat(3000)));
  assert.ok(!out.includes("6".repeat(10)));
  // Quote markers, role labels, the label, the note and the attribution add well under 300.
  assert.ok(out.length <= MAX_TRANSCRIPT_QUOTE_CHARS + 300);
  assert.ok(!buildTranscriptQuote(turns.slice(0, 2), transcriptText).includes("omitted"));
});

test("one message beyond the cap is cut with an ellipsis, newest first", () => {
  const out = buildTranscriptQuote(
    [
      { role: "user", text: "old" },
      { role: "assistant", text: "y".repeat(20) },
    ],
    transcriptText,
    30,
  );
  assert.ok(out.includes("_1 earlier messages omitted_"));
  assert.ok(out.includes("…"));
  assert.ok(!out.includes("old"));
});

test("anchor excerpt collapses whitespace to one bounded line", () => {
  assert.equal(anchorExcerptLine("a\n\n  b\tc"), "a b c");
  assert.ok(anchorExcerptLine("y ".repeat(200)).length <= 141);
});

test("the newest assistant answer skips empty and non-assistant rows", () => {
  const rows = [
    { role: "assistant", content: "old" },
    { role: "assistant", content: "new" },
    { role: "user", content: "later question" },
    { role: "assistant", content: "  " },
  ];
  assert.equal(newestAssistantAnswer(rows), "new");
  assert.equal(newestAssistantAnswer([{ role: "user", content: "x" }]), undefined);
});

test("first Send is blocked by a running or read-only parent only", () => {
  assert.equal(sideChatFirstSendBlockReason({}, false), undefined);
  assert.equal(sideChatFirstSendBlockReason({}, true), "sideChat.parentBusy");
  assert.equal(sideChatFirstSendBlockReason({ readOnlyReason: "busy" }, false), "sideChat.parentBusy");
  assert.equal(sideChatFirstSendBlockReason({ readOnlyReason: "native" }, false), "sideChat.readOnly");
  assert.equal(
    sideChatFirstSendBlockReason({ capabilities: { canEditMessages: false } }, false),
    "sideChat.readOnly",
  );
  assert.equal(sideChatFirstSendBlockReason(undefined, false), "sideChat.readOnly");
});

function deps(overrides = {}) {
  const log = [];
  return {
    log,
    deps: {
      create: async () => {
        log.push("create");
        return "child-1";
      },
      attach: async (id) => void log.push(`attach:${id}`),
      send: async (id, text) => {
        log.push(`send:${id}:${text}`);
        return true;
      },
      created: (id) => log.push(`created:${id}`),
      ...overrides,
    },
  };
}

test("first Send forks, attaches, then sends to the child", async () => {
  const sender = createSideChatSender();
  const { deps: d, log } = deps();
  const id = await sender.send("tab", "hi", d, { rejected: "no" });
  assert.equal(id, "child-1");
  assert.deepEqual(log, ["create", "created:child-1", "attach:child-1", "send:child-1:hi"]);
  assert.equal(sender.childOf("tab"), "child-1");
});

test("concurrent Sends share one creation", async () => {
  const sender = createSideChatSender();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let creates = 0;
  const { deps: d, log } = deps({
    create: async () => {
      creates += 1;
      await gate;
      return "child-1";
    },
  });
  const a = sender.send("tab", "one", d, { rejected: "no" });
  const b = sender.send("tab", "two", d, { rejected: "no" });
  release();
  await Promise.all([a, b]);
  assert.equal(creates, 1);
  assert.deepEqual(log.filter((entry) => entry.startsWith("send:")).sort(), [
    "send:child-1:one",
    "send:child-1:two",
  ]);
});

test("a rejected prompt keeps the created child for retry", async () => {
  const sender = createSideChatSender();
  let accept = false;
  let creates = 0;
  const { deps: d } = deps({
    create: async () => {
      creates += 1;
      return `child-${creates}`;
    },
    send: async () => accept,
  });
  await assert.rejects(sender.send("tab", "x", d, { rejected: "not sent" }), /not sent/);
  assert.equal(sender.childOf("tab"), "child-1");
  accept = true;
  assert.equal(await sender.send("tab", "x", d, { rejected: "not sent" }), "child-1");
  assert.equal(creates, 1);
});

test("a failed creation leaves nothing behind so the next Send retries", async () => {
  const sender = createSideChatSender();
  let creates = 0;
  const { deps: d } = deps({
    create: async () => {
      creates += 1;
      if (creates === 1) throw new Error("fork failed");
      return "child-2";
    },
  });
  await assert.rejects(sender.send("tab", "x", d, { rejected: "no" }), /fork failed/);
  assert.equal(sender.childOf("tab"), undefined);
  assert.equal(await sender.send("tab", "x", d, { rejected: "no" }), "child-2");
});

test("a known child is reused without forking, even after the sender forgot it", async () => {
  const sender = createSideChatSender();
  const { deps: d, log } = deps();
  await sender.send("tab", "x", d, { known: "existing", rejected: "no" });
  assert.ok(!log.includes("create"));
  sender.forget("tab");
  assert.equal(sender.childOf("tab"), undefined);
});

test("an attach failure never blocks the send", async () => {
  const sender = createSideChatSender();
  const { deps: d, log } = deps({
    attach: async () => {
      throw new Error("detail read failed");
    },
  });
  await sender.send("tab", "x", d, { rejected: "no" });
  assert.ok(log.includes("send:child-1:x"));
});

test("appending to a draft keeps typed text and separates the quote", () => {
  resetComposerDraftCache();
  writeComposerDraft("p1", { text: "my question  ", fileReferences: [{ path: "a", name: "a" }] });
  const before = readComposerDraftRevision("p1");
  const next = appendComposerDraftText("p1", "> quoted\n\nQuoted from Side");
  assert.equal(next.text, "my question\n\n> quoted\n\nQuoted from Side");
  assert.equal(readComposerDraft("p1").text, next.text);
  assert.deepEqual(readComposerDraft("p1").fileReferences, [{ path: "a", name: "a" }]);
  assert.ok(readComposerDraftRevision("p1") > before);
  resetComposerDraftCache();
  assert.equal(appendComposerDraftText("p2", "> q").text, "> q");
  assert.equal(appendComposerDraftText("p2", "   "), undefined);
  resetComposerDraftCache();
});

test("the return mode defaults to None and None blocks the action", () => {
  assert.equal(DEFAULT_SIDE_CHAT_RETURN_MODE, "none");
  const ready = { hasChild: true, childRunning: false, turnCount: 2 };
  assert.equal(sideChatReturnBlockReason({ ...ready, mode: "none" }), "sideChat.returnNone");
  assert.equal(sideChatReturnBlockReason({ ...ready, mode: "summary" }), undefined);
  assert.equal(sideChatReturnBlockReason({ ...ready, mode: "full" }), undefined);
});

test("the return gate reports the first thing the user can fix", () => {
  const base = { mode: "summary", hasChild: true, childRunning: false, turnCount: 1 };
  assert.equal(sideChatReturnBlockReason({ ...base, hasChild: false }), "sideChat.returnNoChild");
  assert.equal(sideChatReturnBlockReason({ ...base, childRunning: true }), "sideChat.returnBusy");
  assert.equal(sideChatReturnBlockReason({ ...base, turnCount: 0 }), "sideChat.returnEmpty");
  assert.equal(
    sideChatReturnBlockReason({ ...base, mode: "none", hasChild: false }),
    "sideChat.returnNone",
    "the mode is explained before a missing child",
  );
});

/** A fake side chat: a transcript, a running flag, listeners and manual timers. */
function summaryHarness(overrides = {}) {
  const state = {
    running: false,
    messages: [{ id: "a1", role: "assistant", content: "earlier answer" }],
    sent: [],
  };
  const listeners = new Set();
  const notify = () => [...listeners].forEach((listener) => listener());
  const timers = [];
  const controller = new AbortController();
  const deps = {
    isRunning: () => state.running,
    messages: () => state.messages,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: async () => {
      state.sent.push("prompt");
      return true;
    },
    timeoutMs: 1000,
    timers: {
      set: (callback, ms) => {
        const timer = { callback, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clear: (timer) => {
        if (timer) timer.cleared = true;
      },
    },
    signal: controller.signal,
    ...overrides,
  };
  return { state, listeners, notify, timers, deps, controller };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("summary: running must go true then false, then the new answer resolves", async () => {
  const h = summaryHarness();
  const pending = runSideChatSummary(h.deps);
  let settled = false;
  pending.then(() => (settled = true), () => (settled = true));
  await tick();
  assert.deepEqual(h.state.sent, ["prompt"]);
  assert.equal(h.listeners.size, 1, "subscribed before the prompt went out");
  h.notify();
  await tick();
  assert.equal(settled, false, "no running turn seen yet");
  h.state.running = true;
  h.notify();
  h.state.messages = [...h.state.messages, { id: "u2", role: "user", content: "summarize" }];
  h.state.messages = [...h.state.messages, { id: "a2", role: "assistant", content: "the summary" }];
  h.notify();
  await tick();
  assert.equal(settled, false, "still running");
  h.state.running = false;
  h.notify();
  assert.equal(await pending, "the summary");
  assert.equal(h.listeners.size, 0, "unsubscribed");
  assert.ok(h.timers[0].cleared, "timeout cleared");
});

test("summary: an already running side chat is refused without sending", async () => {
  const h = summaryHarness();
  h.state.running = true;
  await assert.rejects(runSideChatSummary(h.deps), (error) => error instanceof SideChatReturnError && error.failure === "busy");
  assert.deepEqual(h.state.sent, []);
  assert.equal(h.listeners.size, 0);
});

test("summary: a rejected prompt fails visibly and cleans up", async () => {
  const h = summaryHarness({ send: async () => false });
  await assert.rejects(runSideChatSummary(h.deps), (error) => error.failure === "rejected");
  assert.equal(h.listeners.size, 0);
  assert.ok(h.timers[0].cleared);
});

test("summary: a turn that never finishes times out", async () => {
  const h = summaryHarness();
  const pending = runSideChatSummary(h.deps);
  await tick();
  h.state.running = true;
  h.notify();
  assert.equal(h.timers[0].ms, 1000);
  h.timers[0].callback();
  await assert.rejects(pending, (error) => error.failure === "timeout");
  assert.equal(h.listeners.size, 0);
  h.state.running = false;
  h.notify();
});

test("summary: a finished turn without a new assistant answer is an error", async () => {
  const h = summaryHarness();
  const pending = runSideChatSummary(h.deps);
  await tick();
  h.state.running = true;
  h.notify();
  h.state.running = false;
  h.notify();
  await assert.rejects(pending, (error) => error.failure === "noAnswer");
});

test("summary: closing the tab stops waiting and releases everything", async () => {
  const h = summaryHarness();
  const pending = runSideChatSummary(h.deps);
  let settled = false;
  pending.then(() => (settled = true), () => (settled = true));
  await tick();
  h.controller.abort();
  assert.equal(h.listeners.size, 0);
  assert.ok(h.timers[0].cleared);
  h.state.running = true;
  h.notify();
  h.state.running = false;
  h.notify();
  await tick();
  assert.equal(settled, false, "an aborted wait never inserts a draft");
});

test("a side-chat tab is keyed by its anchor and binds a child in place", () => {
  const draft = sideChatWorkPanelTab(anchor, "Side chat: Parent");
  assert.equal(draft.id, "sidechat:p1:m1");
  assert.equal(draft.kind, "sidechat");
  assert.equal(sideChatTabChildId(draft), undefined);
  assert.ok(isKnownWorkPanelTab(draft));

  const opened = openWorkPanelTabState({ tabs: [{ id: "other", kind: "review" }], activeTabId: "other" }, draft);
  const bound = patchWorkPanelTabState({ ...opened, activeTabId: "other" }, draft.id, { resource: "child-1" });
  assert.equal(bound.activeTabId, "other", "binding must not steal focus");
  assert.deepEqual(bound.tabs.map((tab) => tab.id), ["other", "sidechat:p1:m1"]);
  assert.equal(sideChatTabChildId(bound.tabs[1]), "child-1");
  assert.equal(patchWorkPanelTabState(opened, "missing", { resource: "x" }), opened);

  const closed = closeWorkPanelTabState(bound, draft.id);
  assert.deepEqual(closed.tabs.map((tab) => tab.id), ["other"]);
});

test("a side-chat tab without an anchor is not a known tab", () => {
  assert.equal(isKnownWorkPanelTab({ id: "sidechat:x", kind: "sidechat" }), false);
  const state = sanitizeWorkPanelTabsState({
    tabs: [{ id: "sidechat:x", kind: "sidechat" }, { id: "review", kind: "review" }],
    activeTabId: "sidechat:x",
  });
  assert.deepEqual(state.tabs.map((tab) => tab.id), ["review"]);
});

test("the entry, panel and slice are wired without a renderer-owned projection", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  assert.match(await read("../src/features/chat/transcript/AssistantTurn.tsx"), /<SideChatAction role="assistant"/);
  assert.match(await read("../src/features/chat/transcript/MessageRow.tsx"), /<SideChatAction role="user"/);
  const panel = await read("../src/components/workpanel/WorkPanel.tsx");
  assert.match(panel, /activeTab\?\.kind === "sidechat"/);
  assert.match(panel, /sidechat: IconChat/);
  const tab = await read("../src/features/chat/side-chat/SideChatTab.tsx");
  assert.match(tab, /<DetachedConversation/);
  assert.match(tab, /disabledReason=/);
  assert.match(tab, /<SegmentedControl[\s\S]*role="radiogroup"/);
  assert.match(tab, /data-side-chat-action="return-to-main"/);
  assert.doesNotMatch(tab, /add-to-main/, "Add to main chat is replaced by the mode-aware return");
  const slice = await read("../src/stores/slices/side-chat-slice.ts");
  assert.match(slice, /commitForkedSession\(child, \{ activate: false/);
  // ADR 0268's objections: no transcript map, overlay or annotation state returns.
  const session = await read("../src/features/chat/side-chat/side-chat-session.ts");
  for (const source of [tab, slice, session]) {
    assert.doesNotMatch(source, /sideChatTranscripts|projectSideChatEvent|selection-quote|annotation/i);
  }
});
