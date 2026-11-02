import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const core = await import("../src/features/chat/mention/mention-core.ts");
const { formatSessionLink, parseSessionLinks } = await import("@pi-desktop/shared");

const s = (id, title, projectPath, updatedAt = "2026-01-01T00:00:00Z", extra = {}) => ({
  id, title, projectPath, updatedAt, ...extra,
});
const sideLabel = (p) => `side · ${p}`;

test("trigger opens at start or after whitespace only", () => {
  assert.deepEqual(core.detectMentionTrigger("@pl", 3), { tokenStart: 0, query: "pl" });
  assert.deepEqual(core.detectMentionTrigger("see @", 5), { tokenStart: 4, query: "" });
  assert.deepEqual(core.detectMentionTrigger("a\n@x", 4), { tokenStart: 2, query: "x" });
  assert.equal(core.detectMentionTrigger("me@example", 10), null);
  assert.equal(core.detectMentionTrigger("@a b", 4), null);
  assert.equal(core.detectMentionTrigger("@a@b", 4), null);
  assert.equal(core.detectMentionTrigger("hi", 2), null);
});

test("candidates group, exclude and filter", () => {
  const sessions = [
    s("cur", "Current", "/p/a"),
    s("a1", "Alpha plan", "/p/a", "2026-03-01T00:00:00Z"),
    s("a2", "Alpha older", "/p/a", "2026-02-01T00:00:00Z"),
    s("r1", "Alpha chat"),
    s("o1", "Alpha other", "/p/b"),
    s("rem", "Alpha remote", undefined, undefined, { source: "remote" }),
    s("auto", "Alpha auto", undefined, undefined, { scheduledRun: true }),
    s("side", "Alpha side", "/p/a", "2026-01-01T00:00:00Z"),
    s("par", "Parent", "/p/a"),
  ];
  const groups = core.buildMentionCandidates({
    sessions, currentSessionId: "cur", currentProjectPath: "/p/a/", query: "alpha",
    sideChatParents: { side: "par" }, sideLabel,
  });
  assert.deepEqual(groups.map((g) => g.id), ["project", "recent", "other"]);
  const flat = core.flattenMentionGroups(groups);
  assert.deepEqual(flat.map((r) => r.id), ["a1", "a2", "side", "r1", "o1"]);
  const secondary = Object.fromEntries(flat.map((r) => [r.id, r.secondary]));
  assert.equal(secondary.side, "side · Parent");
  assert.equal(secondary.o1, "b");
  assert.equal(secondary.r1, "");
});

test("empty groups are dropped and rows are capped", () => {
  const many = Array.from({ length: 60 }, (_, i) => s(`x${i}`, `T${i}`, "/p/b"));
  const groups = core.buildMentionCandidates({ sessions: many, query: "", sideLabel });
  assert.deepEqual(groups.map((g) => g.id), ["other"]);
  assert.equal(core.flattenMentionGroups(groups).length, core.MENTION_ROW_LIMIT);
  assert.deepEqual(core.buildMentionCandidates({ sessions: [], query: "", sideLabel }), []);
});

test("insert, reconcile and atomic backspace", () => {
  const ref = { id: "c5", title: "Plan UI" };
  const trig = core.detectMentionTrigger("compare @Pl", 11);
  const edit = core.insertMention("compare @Pl", trig, 11, ref, []);
  assert.equal(edit.text, "compare @Plan UI ");
  assert.equal(edit.caret, edit.text.length);
  assert.deepEqual(edit.mentions, [ref]);
  const back = core.backspaceMention(edit.text, edit.caret, edit.mentions);
  assert.equal(back.text, "compare ");
  assert.deepEqual(back.mentions, []);
  assert.equal(core.backspaceMention("compare @Plan UIx", 17, [ref]), null);
  assert.deepEqual(core.reconcileMentions("gone", [ref]), []);
  assert.equal(core.insertMention(edit.text, trig, 11, ref, [ref]).mentions.length, 1);
});

test("serialize turns tokens into session links the main process parses", () => {
  const a = { id: "a", title: "Plan" };
  const b = { id: "b", title: "Plan B" };
  const text = core.serializeMentions("x @Plan B and @Plan, mail me@Plan", [a, b]);
  assert.equal(text, `x ${formatSessionLink("b")} and ${formatSessionLink("a")} , mail me@Plan`);
  assert.deepEqual(parseSessionLinks(text), ["b", "a"]);
  assert.equal(core.serializeMentions("plain", [a]), "plain");
});
