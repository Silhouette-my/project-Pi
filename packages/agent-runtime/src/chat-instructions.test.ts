import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CHAT_INSTRUCTION_NONE_ID } from "@pi-desktop/shared";
import { DEFAULT_CHAT_SYSTEM_PROMPT } from "./mode-prompts.js";
import { BUILTIN_CHAT_INSTRUCTIONS } from "./builtin-chat-instructions.js";
import {
  chatInstructionDirs,
  chatSystemPromptContent,
  listChatInstructionPresets,
  resolveChatInstructions,
} from "./chat-instructions.js";

let root: string | undefined;
let projectDir: string | undefined;
let globalDir: string | undefined;
const builtinIds = [...BUILTIN_CHAT_INSTRUCTIONS.keys()];
const builtinRows = builtinIds.map((id) => ({ id }));

afterEach(async () => {
  for (const dir of [root, projectDir, globalDir]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  root = undefined;
  projectDir = undefined;
  globalDir = undefined;
});

/** Creates workspace + isolated preset dirs; files use a "project/"/"global/" prefix. */
async function fixture(files: Record<string, string>) {
  root = await mkdtemp(join(tmpdir(), "pi-desktop-chat-instr-"));
  projectDir = await mkdtemp(join(tmpdir(), "pi-desktop-chat-instr-proj-"));
  globalDir = await mkdtemp(join(tmpdir(), "pi-desktop-chat-instr-global-"));
  for (const [name, content] of Object.entries(files)) {
    const dir = name.startsWith("global/") ? globalDir! : projectDir!;
    const relative = name.startsWith("global/")
      ? name.slice("global/".length)
      : name;
    const target = join(dir, relative);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  return { project: projectDir!, global: globalDir! };
}

describe("chatInstructionDirs", () => {
  it("points at <workspace>/.pi/chat-instructions and the global dir", () => {
    const dirs = chatInstructionDirs("/w");
    expect(dirs.project).toBe(join("/w", ".pi", "chat-instructions"));
    expect(dirs.global).toContain(join(".pi", "agent", "chat-instructions"));
  });

  it("omits the project dir without a workspace root", () => {
    expect(chatInstructionDirs(null).project).toBeUndefined();
    expect(chatInstructionDirs("  ").project).toBeUndefined();
  });
});

describe("listChatInstructionPresets", () => {
  it("returns ids from file stems, sorted, .md only", async () => {
    const dirs = await fixture({
      "b.md": "second",
      "a-c.md": "first",
      "notes.txt": "ignored",
      "UPPER.MD": "case-insensitive suffix",
    });
    expect(await listChatInstructionPresets(root, dirs)).toEqual([
      { id: "UPPER" },
      { id: "a-c" },
      { id: "b" },
      ...builtinRows,
    ]);
  });

  it("lists workspace presets before global ones and dedupes shadowed ids", async () => {
    const dirs = await fixture({
      "shared.md": "workspace",
      "global/shared.md": "global",
      "global/only-global.md": "global",
    });
    expect(await listChatInstructionPresets(root, dirs)).toEqual([
      { id: "shared" },
      { id: "only-global" },
      ...builtinRows,
    ]);
  });

  it("never lists the reserved none id", async () => {
    const dirs = await fixture({
      "none.md": "ignored",
      "global/none.md": "ignored",
      "real.md": "kept",
    });
    const presets = await listChatInstructionPresets(root, dirs);
    expect(presets.map((preset) => preset.id)).toEqual(["real", ...builtinIds]);
    expect(presets.map((preset) => preset.id)).not.toContain(
      CHAT_INSTRUCTION_NONE_ID,
    );
  });

  it("offers bundled modes when no preset directory exists", async () => {
    const dirs = await fixture({});
    await expect(
      listChatInstructionPresets(root, {
        project: join(projectDir!, "missing"),
        global: join(globalDir!, "missing"),
      }),
    ).resolves.toEqual(builtinRows);
  });
});

describe("resolveChatInstructions", () => {
  it("resolves bundled modes without files and lets a project override them", async () => {
    const dirs = await fixture({ "exploration.md": "Project-specific exploration." });
    expect(await resolveChatInstructions(root, "exploration", dirs)).toBe("Project-specific exploration.");
    expect(await resolveChatInstructions(root, "casual-chat", dirs)).toBe(BUILTIN_CHAT_INSTRUCTIONS.get("casual-chat"));
    expect(await resolveChatInstructions(root, "toString", dirs)).toBeUndefined();
  });
  it("maps absent, null, and empty ids to the built-in persona encoding", async () => {
    const dirs = await fixture({});
    for (const presetId of [undefined, null, ""]) {
      await expect(resolveChatInstructions(root, presetId, dirs)).resolves.toBeUndefined();
    }
  });

  it("maps the reserved none id to the empty-string (no system prompt) encoding", async () => {
    const dirs = await fixture({});
    await expect(
      resolveChatInstructions(root, CHAT_INSTRUCTION_NONE_ID, dirs),
    ).resolves.toBe("");
  });

  it("reads preset content trimmed, workspace file winning over global", async () => {
    const dirs = await fixture({
      "tone.md": "  Workspace tone.\n",
      "global/tone.md": "Global tone.",
      "global/only.md": "Global only.",
    });
    await expect(resolveChatInstructions(root, "tone", dirs)).resolves.toBe(
      "Workspace tone.",
    );
    await expect(resolveChatInstructions(root, "only", dirs)).resolves.toBe(
      "Global only.",
    );
  });

  it("falls back to the built-in persona for stale or malformed ids", async () => {
    const dirs = await fixture({ "gone.md": "   " });
    // Whitespace-only file counts as absent.
    await expect(resolveChatInstructions(root, "gone", dirs)).resolves.toBeUndefined();
    await expect(resolveChatInstructions(root, "deleted", dirs)).resolves.toBeUndefined();
    for (const bad of ["a/b", "a\\b", ".", ".."]) {
      await expect(resolveChatInstructions(root, bad, dirs)).resolves.toBeUndefined();
    }
  });

  it("rejects ids the host would reject", async () => {
    const dirs = await fixture({});
    await expect(resolveChatInstructions(root, "x".repeat(201), dirs)).resolves.toBeUndefined();
  });
});

describe("chatSystemPromptContent", () => {
  it("undefined selects the built-in chat persona", () => {
    expect(chatSystemPromptContent(undefined)).toBe(DEFAULT_CHAT_SYSTEM_PROMPT);
    expect(DEFAULT_CHAT_SYSTEM_PROMPT).not.toMatch(/coding agent/i);
  });

  it("empty string means no system prompt at all", () => {
    expect(chatSystemPromptContent("")).toBe("");
  });

  it("passes preset content through verbatim", () => {
    expect(chatSystemPromptContent("Terse pirate answers.")).toBe(
      "Terse pirate answers.",
    );
  });
});

describe("bundled chat instruction examples", () => {
  it("discovers and resolves the four standalone presets", async () => {
    const examples = fileURLToPath(
      new URL("../../../examples/chat-instructions/", import.meta.url),
    );
    const dirs = { global: examples };
    const ids = ["casual-chat", "exploration", "q-and-a", "technical-discussion"];
    expect(await listChatInstructionPresets(null, dirs)).toEqual(
      ids.map((id) => ({ id })),
    );
    for (const id of ids) {
      const content = (await readFile(join(examples, `${id}.md`), "utf8")).trim();
      expect(BUILTIN_CHAT_INSTRUCTIONS.get(id)).toBe(content);
      expect(content.length).toBeGreaterThan(0);
      expect(await resolveChatInstructions(null, id, {
        global: join(examples, "missing-presets"),
      })).toBe(content);
      expect(await resolveChatInstructions(null, id, dirs)).toBe(content);
      expect(chatSystemPromptContent(content)).toBe(content);
    }
  });
});
