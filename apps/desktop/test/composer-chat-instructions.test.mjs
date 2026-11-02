import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { composerToolbar } from "./helpers/composer-toolbar.mjs";
import { readComposerModule, readComposerSource } from "./helpers/source-contracts.mjs";
import { readFileSync } from "node:fs";
import { slotSsr } from "./helpers/slot-ssr.mjs";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { chatInstructionUnavailableKey, selectedChatInstruction } = await import(
  "../src/features/chat/composer/chat-instruction-state.ts"
);

/*
 * Chat instructions (spec 03-runtime/11) appear as one chip next to the model
 * picker for every provider. Remote-host and imported native sessions keep
 * the chip visible but disabled with the reason as its tooltip. The chip
 * names the committed selection (None by default, Default only for legacy
 * ChatGPT sessions, or a preset id) and selection persists through
 * configureActiveSession like the thinking level.
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
  unavailableKey: null,
  selected: "none",
  showDefault: false,
  open: false,
  setOpen: () => {},
  presets: [{ id: "tone" }],
  select: () => Promise.resolve(),
};

test("the chip renders whenever a controller is passed and defaults to none", async (t) => {
  const plain = await toolbar(t);
  assert.doesNotMatch(plain, /composer-chat-instruction-chip/);
  const html = await toolbar(t, { chatInstructionMenu: menuController });
  assert.match(html, /class="icon-btn mode-chip composer-chat-instruction-chip/);
  assert.match(html, /data-preset="none"/);
  assert.match(html, /chat\.chatInstructionsNone/);
});

test("the chip names the committed preset id, none, or the legacy default", async (t) => {
  const tone = await toolbar(t, { chatInstructionMenu: { ...menuController, selected: "tone" } });
  assert.match(tone, /data-preset="tone"/);
  const legacy = await toolbar(t, {
    chatInstructionMenu: { ...menuController, selected: null, showDefault: true },
  });
  assert.match(legacy, /data-preset="default"/);
  assert.match(legacy, /chat\.chatInstructionsDefault/);
});

test("an unavailable session type disables the chip and explains why in the tooltip", async (t) => {
  for (const key of ["chat.chatInstructionsUnavailableRemote", "chat.chatInstructionsUnavailableNative"]) {
    const html = await toolbar(t, {
      chatInstructionMenu: { ...menuController, enabled: false, unavailableKey: key },
    });
    assert.match(html, /composer-chat-instruction-chip/);
    assert.match(html, /disabled=""/);
  }
  assert.match(pickerSource, /unavailableKey \? t\(unavailableKey\) : t\("chat\.chatInstructions"\)/);
  assert.match(pickerSource, /tooltip=\{tooltip\}/);
});

test("the menu offers None, Default only for ChatGPT, and every discovered preset id", () => {
  assert.match(pickerSource, /role="menu"/);
  assert.match(pickerSource, /menuitemradio/);
  assert.match(pickerSource, /aria-checked=\{selected === option\}/);
  assert.match(
    pickerSource,
    /const options: Array<string \| null> = \[\s*\n\s*CHAT_INSTRUCTION_NONE_ID,\s*\n\s*\.\.\.\(showDefault \? \[null\] : \[\]\),\s*\n\s*\.\.\.presets\.map\(\(preset\) => preset\.id\),/,
  );
  assert.match(pickerSource, /menuClassName="composer-chat-instructions-menu"/);
});

test("selection persists through configureActiveSession with promptPreset", () => {
  assert.match(
    hookSource,
    /await configureActiveSession\(\{\s*\n\s*mode,\s*\n\s*providerId,\s*\n\s*modelId,\s*\n\s*thinkingLevel,\s*\n\s*promptPreset: preset,\s*\n\s*\}\);/,
  );
  assert.match(composerSource, /session: activeSession, draft: draftConfiguration/);
});

test("new conversations default to none; only a stored null on a ChatGPT session is the legacy default", () => {
  const chat = { hasSession: true, chatgpt: true };
  assert.equal(selectedChatInstruction(undefined, { hasSession: false, chatgpt: true }), "none");
  assert.equal(selectedChatInstruction(null, { hasSession: false, chatgpt: true }), "none");
  assert.equal(selectedChatInstruction("none", chat), "none");
  assert.equal(selectedChatInstruction("exploration", chat), "exploration");
  assert.equal(selectedChatInstruction(null, chat), null);
  assert.equal(selectedChatInstruction(null, { hasSession: true, chatgpt: false }), "none");
  assert.equal(selectedChatInstruction(undefined, { hasSession: true, chatgpt: false }), "none");
});

test("only remote-host and imported native sessions are unavailable", () => {
  assert.equal(chatInstructionUnavailableKey({ remote: false, native: false }), null);
  assert.equal(
    chatInstructionUnavailableKey({ remote: true, native: false }),
    "chat.chatInstructionsUnavailableRemote",
  );
  assert.equal(
    chatInstructionUnavailableKey({ remote: false, native: true }),
    "chat.chatInstructionsUnavailableNative",
  );
  assert.match(composerSource, /remote: remoteSession, native: nativeSession, apiStyle: provider\?\.apiStyle/);
  assert.doesNotMatch(composerSource, /enabled: !nativeSession/);
});

test("detached conversations bind the same picker to their session or pending configuration", () => {
  const detached = readFileSync(
    new URL("../src/components/conversation/DetachedConversation.tsx", import.meta.url),
    "utf8",
  );
  assert.match(detached, /<ComposerChatInstructionPicker/);
  assert.match(detached, /useChatInstructionMenu\(\{[\s\S]*session,\s*\n\s*draft: pending,[\s\S]*configureActiveSession,/);
  const sideChat = readFileSync(
    new URL("../src/features/chat/side-chat/side-chat-session.ts", import.meta.url),
    "utf8",
  );
  assert.match(sideChat, /promptPreset: CHAT_INSTRUCTION_NONE_ID,\s*\n\s*\.\.\.configuration,/);
});
