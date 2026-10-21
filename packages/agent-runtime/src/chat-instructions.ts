/**
 * ChatGPT chat-mode instruction presets (spec 03-runtime/11).
 *
 * Chat mode (`apiStyle: "chatgpt_conversation"`) has no local tools, so the
 * desktop agent system prompt is replaced by a small, user-selectable chat
 * instruction. Four modes ship with the runtime. Markdown files can override
 * them with project-before-global precedence:
 *
 * - `<workspace>/.pi/chat-instructions/<id>.md` (project)
 * - `~/.pi/agent/chat-instructions/<id>.md` (global)
 *
 * The preset id is the file stem; a workspace file shadows a global file with
 * the same id. The reserved id `none` (`CHAT_INSTRUCTION_NONE_ID`) is never
 * offered as a file id — a `none.md` file is ignored — and means "send no
 * system prompt at all".
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CHAT_INSTRUCTION_NONE_ID } from "@pi-desktop/shared";
import { DEFAULT_CHAT_SYSTEM_PROMPT } from "./mode-prompts.js";
import { BUILTIN_CHAT_INSTRUCTIONS } from "./builtin-chat-instructions.js";
import {
  MAX_PROMPT_BYTES,
  customSystemPromptDirs,
  limitUtf8,
} from "./custom-system-prompt.js";

export const CHAT_INSTRUCTIONS_DIR_NAME = "chat-instructions";

export type ChatInstructionDirs = { project?: string; global: string };

/** The two preset directories, mirroring `customSystemPromptDirs` precedence. */
export function chatInstructionDirs(
  workspaceRoot: string | null | undefined,
): ChatInstructionDirs {
  const base = customSystemPromptDirs(workspaceRoot);
  return {
    ...(base.project ? { project: join(base.project, CHAT_INSTRUCTIONS_DIR_NAME) } : {}),
    global: join(base.global, CHAT_INSTRUCTIONS_DIR_NAME),
  };
}

/** Same shape rules the host enforces on `session.configure` (`promptPreset`). */
function isUsablePresetId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= 200 &&
    !id.includes("/") &&
    !id.includes("\\") &&
    id !== "." &&
    id !== ".." &&
    id !== CHAT_INSTRUCTION_NONE_ID
  );
}

/** Preset ids, workspace then global then bundled, deduplicated; no reserved id. */
export async function listChatInstructionPresets(
  workspaceRoot: string | null | undefined,
  dirs: ChatInstructionDirs = chatInstructionDirs(workspaceRoot),
): Promise<{ id: string }[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const dir of [dirs.project, dirs.global]) {
    if (!dir) continue;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      // A missing preset directory is an expected state.
      continue;
    }
    for (const entry of entries.sort()) {
      if (!entry.toLowerCase().endsWith(".md")) continue;
      const id = entry.slice(0, -3);
      if (!isUsablePresetId(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  for (const id of BUILTIN_CHAT_INSTRUCTIONS.keys()) {
    if (!seen.has(id)) ids.push(id);
  }
  return ids.map((id) => ({ id }));
}

/** Project wins over global; a whitespace-only file counts as absent. */
async function readPresetContent(
  dirs: ChatInstructionDirs,
  id: string,
): Promise<string | undefined> {
  for (const dir of [dirs.project, dirs.global]) {
    if (!dir) continue;
    try {
      const content = (await readFile(join(dir, `${id}.md`), "utf8")).trim();
      if (content) return limitUtf8(content, MAX_PROMPT_BYTES);
    } catch {
      // Missing or unreadable files are an expected state; fall through.
    }
  }
  return undefined;
}

/**
 * Resolve the `chatInstructions` sidecar encoding to the chat system prompt
 * content (spec 03-runtime/11). `undefined` selects the built-in chat
 * persona; `""` (the "None" choice) produces no system prompt at all.
 */
export function chatSystemPromptContent(chatInstructions: string | undefined): string {
  if (chatInstructions === undefined) return DEFAULT_CHAT_SYSTEM_PROMPT;
  return chatInstructions;
}

/**
 * Resolve a session's `promptPreset` id to the chat system prompt content.
 *
 * The sidecar `chatInstructions` encoding (documented in sidecar.ts):
 * - `undefined` → built-in chat persona (also the fallback for a stale id)
 * - `""`        → no system prompt at all
 * - other       → the preset content verbatim
 */
export async function resolveChatInstructions(
  workspaceRoot: string | null | undefined,
  presetId: string | null | undefined,
  dirs: ChatInstructionDirs = chatInstructionDirs(workspaceRoot),
): Promise<string | undefined> {
  if (presetId === undefined || presetId === null || presetId === "") return undefined;
  if (presetId === CHAT_INSTRUCTION_NONE_ID) return "";
  if (!isUsablePresetId(presetId)) return undefined;
  // A preset id that no longer resolves falls back to the built-in default.
  return (await readPresetContent(dirs, presetId)) ?? BUILTIN_CHAT_INSTRUCTIONS.get(presetId);
}
