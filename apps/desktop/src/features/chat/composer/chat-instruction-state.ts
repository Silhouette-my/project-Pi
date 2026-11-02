import { CHAT_INSTRUCTION_NONE_ID } from "@pi-desktop/shared";

/** i18n key explaining why a session cannot take a chat instruction, or null. */
export type ChatInstructionUnavailableKey =
  | "chat.chatInstructionsUnavailableRemote"
  | "chat.chatInstructionsUnavailableNative";

/**
 * Chat instructions apply to every session this app's runtime launches
 * (spec 03-runtime/11). Remote-host sessions run on the other machine and
 * their configure protocol carries no instruction; imported pi-native
 * sessions are read-only. Both keep the picker visible but disabled.
 */
export function chatInstructionUnavailableKey(session: {
  remote: boolean;
  native: boolean;
}): ChatInstructionUnavailableKey | null {
  if (session.remote) return "chat.chatInstructionsUnavailableRemote";
  if (session.native) return "chat.chatInstructionsUnavailableNative";
  return null;
}

/**
 * The preset id the picker shows. A new conversation (no session yet, or a
 * session created after the default changed) holds `none`. Only a stored NULL
 * on an existing ChatGPT conversation means the legacy built-in persona; for
 * every other provider NULL adds no instruction, which is `none`.
 */
export function selectedChatInstruction(
  stored: string | null | undefined,
  options: { hasSession: boolean; chatgpt: boolean },
): string | null {
  if (stored) return stored;
  if (stored === null && options.hasSession && options.chatgpt) return null;
  return CHAT_INSTRUCTION_NONE_ID;
}
