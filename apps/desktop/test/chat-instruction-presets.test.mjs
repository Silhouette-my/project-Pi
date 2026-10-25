import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  CHAT_INSTRUCTION_NONE_ID,
} = await import("../../../packages/shared/src/index.ts");
const {
  chatInstructionDirs,
  listChatInstructionPresets,
  resolveChatInstructions,
} = await import("../../../packages/agent-runtime/src/chat-instructions.ts");

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-instructions-"));
  const dirs = { project: join(root, "project"), global: join(root, "global") };
  for (const [name, content] of Object.entries(files)) {
    const dir = name.startsWith("global/") ? dirs.global : dirs.project;
    const relative = name.startsWith("global/") ? name.slice("global/".length) : name;
    const target = join(dir, relative);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  return { root, dirs };
}

test("preset discovery uses file stems, workspace first, and never the reserved id", async () => {
  const { root, dirs } = await fixture({
    "tone.md": "Workspace tone.",
    "global/tone.md": "Global tone.",
    "global/terse.md": "Global terse.",
    "none.md": "reserved, ignored",
    "notes.txt": "not markdown",
  });
  try {
    assert.deepEqual(await listChatInstructionPresets(root, dirs), [
      { id: "tone" },
      { id: "terse" },
      { id: "casual-chat" },
      { id: "exploration" },
      { id: "q-and-a" },
      { id: "technical-discussion" },
    ]);
    // The session-launch resolution the sidecar consumes: workspace content
    // wins, the reserved id encodes "no system prompt", stale ids fall back.
    assert.equal(await resolveChatInstructions(root, "tone", dirs), "Workspace tone.");
    assert.equal(await resolveChatInstructions(root, CHAT_INSTRUCTION_NONE_ID, dirs), "");
    assert.equal(await resolveChatInstructions(root, "deleted", dirs), undefined);
    assert.equal(await resolveChatInstructions(root, null, dirs), undefined);
    // Directory layout mirrors the custom-system-prompt precedence.
    assert.equal(
      chatInstructionDirs("/w").project,
      join("/w", ".pi", "chat-instructions"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("main resolves chat instructions for every launch, not only chatgpt_conversation", () => {
  const launch = readFileSync(
    new URL("../electron/main/runtime/session-launch.ts", import.meta.url),
    "utf8",
  );
  assert.match(launch, /const chatInstructions = await resolveChatInstructions\(/);
  assert.doesNotMatch(
    launch,
    /apiStyle === "chatgpt_conversation"\s*\?\s*await resolveChatInstructions/,
  );
  assert.match(launch, /chatInstructions !== undefined \? \{ chatInstructions \}/);
});

test("main exposes the preset list channel with ids only", () => {
  const appIpc = readFileSync(
    new URL("../electron/main/ipc/app-ipc.ts", import.meta.url),
    "utf8",
  );
  assert.match(appIpc, /IPC\.invoke\.promptPresetList/);
  assert.match(appIpc, /listChatInstructionPresets\(/);
});
