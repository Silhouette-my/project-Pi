import { type Mode, type SessionThinkingLevel } from "@pi-desktop/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../../../lib/api";
import { useAppStore } from "../../../../stores/app-store";
import type { AppState } from "../../../../stores/app-store";
import { chatInstructionUnavailableKey, selectedChatInstruction } from "../chat-instruction-state";

type UseChatInstructionMenuOptions = {
  /** Session types that cannot take an instruction (picker disabled). */
  remote: boolean;
  native: boolean;
  apiStyle?: string;
  /** The session being configured, or the draft before one exists. */
  session?: { promptPreset?: string | null } | null;
  draft?: { promptPreset?: string | null } | null;
  mode: Mode;
  providerId?: string;
  modelId?: string;
  thinkingLevel: SessionThinkingLevel;
  controlsBlocked: boolean;
  configureActiveSession: AppState["configureActiveSession"];
};

/**
 * Per-session chat-instruction preset selection, available for every
 * provider (spec 03-runtime/11).
 *
 * The persisted value is the session's `promptPreset` id (the reserved "none"
 * id = no instruction; null on a legacy ChatGPT session = built-in persona). Preset ids are
 * bundled or discovered from `<workspace>/.pi/chat-instructions` and
 * `~/.pi/agent/chat-instructions` through the promptPresetList IPC; content
 * never reaches the renderer. Selection persists through
 * `configureActiveSession` exactly like the thinking level.
 */
export function useChatInstructionMenu({
  remote,
  native,
  apiStyle,
  session,
  draft,
  mode,
  providerId,
  modelId,
  thinkingLevel,
  controlsBlocked,
  configureActiveSession,
}: UseChatInstructionMenuOptions) {
  const projectPath = useAppStore((s) => s.workspace?.path);
  const showToast = useAppStore((s) => s.showToast);
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<Array<{ id: string }>>([]);
  const unavailableKey = chatInstructionUnavailableKey({ remote, native });
  const enabled = unavailableKey === null;
  // ChatGPT conversation models replace the agent prompt; others append.
  const chatgpt = apiStyle === "chatgpt_conversation";

  // Listing is a local directory read; refresh it whenever the menu opens so
  // files added while the app runs show up without a restart.
  useEffect(() => {
    if (!enabled || !open) return;
    let cancelled = false;
    void api
      .listPromptPresets(projectPath)
      .then((result) => {
        if (!cancelled) setPresets(result.presets);
      })
      .catch(() => {
        if (!cancelled) setPresets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, open, projectPath]);

  useEffect(() => {
    if (enabled && !controlsBlocked) return;
    setOpen(false);
  }, [controlsBlocked, enabled]);

  /** "none" removes the instruction; null (ChatGPT only) is the built-in persona. */
  const select = useCallback(
    async (preset: string | null) => {
      try {
        await configureActiveSession({
          mode,
          providerId,
          modelId,
          thinkingLevel,
          promptPreset: preset,
        });
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), {
          variant: "error",
        });
      }
    },
    [configureActiveSession, mode, modelId, providerId, showToast, thinkingLevel],
  );

  return {
    enabled,
    unavailableKey,
    selected: selectedChatInstruction((session ?? draft)?.promptPreset, { hasSession: Boolean(session), chatgpt }),
    showDefault: chatgpt,
    open,
    setOpen,
    presets,
    select,
  };
}
