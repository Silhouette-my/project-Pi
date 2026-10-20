import assert from "node:assert/strict";
import test from "node:test";
import { composerToolbar } from "./helpers/composer-toolbar.mjs";
import { readComposerModule, readComposerSource } from "./helpers/source-contracts.mjs";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * ChatGPT chat-mode instruction presets (spec 03-runtime/11) appear as one
 * chip next to the model picker, and only for ChatGPT conversation models on
 * local sessions. The chip names the committed selection — Default (the
 * built-in chat persona), None (no system prompt), or a discovered preset id —
 * and selection persists through configureActiveSession like the thinking
 * level.
 */

const pickerSource = await readComposerModule("ComposerChatInstructionPicker.tsx");
const hookSource = await readComposerModule("hooks/useChatInstructionMenu.ts");
const composerSource = await readComposerSource();

async function toolbar(t, overrides = {}) {
  const ssr = await slotSsr(t);
  return (await composerToolbar(t, ssr, overrides))();
}

const menuController = {
  enabled: true,
  open: false,
  setOpen: () => {},
  presets: [{ id: "tone" }],
  select: () => Promise.resolve(),
};

test("the chip renders only when the menu controller is enabled", async (t) => {
  const plain = await toolbar(t);
  assert.doesNotMatch(plain, /composer-chat-instruction-chip/);
  const html = await toolbar(t, { chatInstructionMenu: menuController });
  assert.match(html, /class="icon-btn mode-chip composer-chat-instruction-chip/);
  assert.match(html, /data-preset="default"/);
  // The default selection is named, not left blank.
  assert.match(html, /chat\.chatInstructionsDefault/);
});

test("the chip names the committed preset id or the none sentinel", async (t) => {
  const html = await toolbar(t, {
    chatInstructionMenu: menuController,
    chatInstructionPreset: "tone",
  });
  assert.match(html, /data-preset="tone"/);
  const none = await toolbar(t, {
    chatInstructionMenu: menuController,
    chatInstructionPreset: "none",
  });
  assert.match(none, /data-preset="none"/);
  assert.match(none, /chat\.chatInstructionsNone/);
});

test("the menu offers Default, None, and every discovered preset id", () => {
  assert.match(pickerSource, /role="menu"/);
  assert.match(pickerSource, /menuitemradio/);
  assert.match(pickerSource, /aria-checked=\{selected === option\}/);
  // Default (null) and the reserved none id are always present; presets come
  // from the list channel by id, never as file content.
  assert.match(pickerSource, /const options: Array<string \| null> = \[\s*\n\s*null,\s*\n\s*CHAT_INSTRUCTION_NONE_ID,\s*\n\s*\.\.\.presets\.map\(\(preset\) => preset\.id\),/);
  assert.match(pickerSource, /menuClassName="composer-chat-instructions-menu"/);
});

test("selection persists through configureActiveSession with promptPreset", () => {
  assert.match(
    hookSource,
    /await configureActiveSession\(\{\s*\n\s*mode,\s*\n\s*providerId,\s*\n\s*modelId,\s*\n\s*thinkingLevel,\s*\n\s*promptPreset: preset,\s*\n\s*\}\);/,
  );
  assert.match(composerSource, /chatInstructionPreset=\{\(activeSession \?\? draftConfiguration\)\?\.promptPreset \?\? null\}/);
});

test("the chip displays the draft selection before first send and session selection afterward", async (t) => {
  const expression = composerSource.match(/chatInstructionPreset=\{([^\n]+)\}/)?.[1];
  assert.ok(expression);
  const selection = new Function("activeSession", "draftConfiguration", `return ${expression};`);
  for (const preset of [undefined, null, "none", "exploration"]) {
    const selected = selection(undefined, { promptPreset: preset });
    const html = await toolbar(t, { chatInstructionMenu: menuController, chatInstructionPreset: selected });
    assert.ok(html.includes(`data-preset="${preset ?? "default"}"`));
  }
  assert.equal(selection({}, { promptPreset: "exploration" }), null);
  assert.equal(selection({ promptPreset: "none" }, { promptPreset: "exploration" }), "none");
});

test("the chip is available on desktop ChatGPT sessions, not imported native or remote sessions", async (t) => {
  const expression = composerSource.match(
    /useChatInstructionMenu\(\{\s*enabled: ([^\n]+),/,
  )?.[1];
  assert.ok(expression);
  const enabled = new Function("nativeSession", "remoteSession", "provider", `return ${expression};`);
  const chat = { apiStyle: "chatgpt_conversation" };
  for (const [native, remote, provider, expected] of [
    [false, false, chat, true],
    [true, false, chat, false],
    [false, true, chat, false],
    [false, false, { apiStyle: "responses" }, false],
    [false, false, undefined, false],
  ]) {
    const actual = enabled(native, remote, provider);
    assert.equal(actual, expected);
    const html = await toolbar(t, {
      chatInstructionMenu: { ...menuController, enabled: actual },
    });
    assert.equal(html.includes("composer-chat-instruction-chip"), expected);
  }
  const right = composerSource.slice(
    composerSource.indexOf('<div className="composer-right">'),
    composerSource.indexOf("<ComposerModelPicker"),
  );
  assert.match(right, /chatInstructionMenu\?\.enabled/);
});
