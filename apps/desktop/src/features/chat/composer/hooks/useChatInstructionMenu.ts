import { type Mode, type SessionThinkingLevel } from "@pi-desktop/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../../../lib/api";
import { useAppStore } from "../../../../stores/app-store";
import type { AppState } from "../../../../stores/app-store";

type UseChatInstructionMenuOptions = {
  /**
   * Chat instruction presets exist only for ChatGPT conversation models on
   * local sessions (spec 03-runtime/11); the picker stays hidden otherwise.
   */
  enabled: boolean;
  mode: Mode;
  providerId?: string;
  modelId?: string;
  thinkingLevel: SessionThinkingLevel;
  controlsBlocked: boolean;
  configureActiveSession: AppState["configureActiveSession"];
};

/**
 * Per-session ChatGPT chat-instruction preset selection.
 *
 * The persisted value is the session's `promptPreset` id (null = built-in
 * chat persona, the reserved "none" id = no system prompt). Preset ids are
 * discovered from `<workspace>/.pi/chat-instructions` and
 * `~/.pi/agent/chat-instructions` through the promptPresetList IPC; content
 * never reaches the renderer. Selection persists through
 * `configureActiveSession` exactly like the thinking level.
 */
export function useChatInstructionMenu({
  enabled,
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

  /** null resets to the built-in chat persona; "none" sends no system prompt. */
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

  return { enabled, open, setOpen, presets, select };
}
