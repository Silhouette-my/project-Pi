import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_QUOTE_CHARS,
  anchorExcerptLine,
  buildQuoteText,
  createSideChatSender,
  newestAssistantAnswer,
  quoteExcerpt,
  sideChatFirstSendBlockReason,
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

test("quote text is a blockquote followed by the attribution line", () => {
  assert.equal(
    buildQuoteText("one\n\ntwo", "Quoted from Side"),
    "> one\n>\n> two\n\nQuoted from Side",
  );
});

test("quote excerpt is capped at 2000 characters with an ellipsis", () => {
  const out = quoteExcerpt("x".repeat(MAX_QUOTE_CHARS + 50));
  assert.equal(out.length, MAX_QUOTE_CHARS + 1);
  assert.ok(out.endsWith("…"));
  assert.equal(quoteExcerpt("short  "), "short");
});

test("quote excerpt never cuts a surrogate pair", () => {
  const text = `${"a".repeat(MAX_QUOTE_CHARS - 1)}😀tail`;
  const out = quoteExcerpt(text);
  assert.ok(!/[\uD800-\uDBFF]…$/.test(out));
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
  const slice = await read("../src/stores/slices/side-chat-slice.ts");
  assert.match(slice, /commitForkedSession\(child, \{ activate: false/);
  // ADR 0268's objections: no transcript map, overlay or annotation state returns.
  const session = await read("../src/features/chat/side-chat/side-chat-session.ts");
  for (const source of [tab, slice, session]) {
    assert.doesNotMatch(source, /sideChatTranscripts|projectSideChatEvent|selection-quote|annotation/i);
  }
});
