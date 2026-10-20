import type { TFunction } from "i18next";
import { CHAT_INSTRUCTION_NONE_ID } from "@pi-desktop/shared";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { TooltipButton } from "../../../components/ui";
import { IconChat, IconCheck, IconChevronDown } from "../../../components/icons";
import type { useChatInstructionMenu } from "./hooks/useChatInstructionMenu";

type ChatInstructionMenuController = ReturnType<typeof useChatInstructionMenu>;

/**
 * ChatGPT chat-mode instruction presets as a compact chip that opens one
 * menu (spec 03-runtime/11).
 *
 * The chip names only the committed selection: "Default" (the built-in chat
 * persona), "None" (no system prompt at all), or a discovered preset id.
 * Preset ids are file stems, so the menu lists ids, never file content.
 */
export function ComposerChatInstructionPicker({
  t,
  controller,
  currentPreset,
  controlsBlocked,
  onCloseOtherMenus,
}: {
  t: TFunction;
  controller: ChatInstructionMenuController;
  /** Session value; null/undefined means the built-in chat persona. */
  currentPreset?: string | null;
  controlsBlocked: boolean;
  onCloseOtherMenus: () => void;
}) {
  const { open, setOpen, presets, select } = controller;
  const selected = currentPreset ?? null;
  const labelOf = (id: string | null) =>
    id === null
      ? t("chat.chatInstructionsDefault")
      : id === CHAT_INSTRUCTION_NONE_ID
        ? t("chat.chatInstructionsNone")
        : id;
  const options: Array<string | null> = [
    null,
    CHAT_INSTRUCTION_NONE_ID,
    ...presets.map((preset) => preset.id),
  ];
  return (
    <AnchoredMenu
      className="composer-chat-instructions"
      open={open}
      onClose={() => setOpen(false)}
      menuClassName="composer-chat-instructions-menu"
      label={t("chat.chatInstructions")}
      role="menu"
      align="start"
      side="top"
      trigger={(ref) => (
        <TooltipButton
          ref={ref}
          type="button"
          className={`icon-btn mode-chip composer-chat-instruction-chip ${open ? "active" : ""}`}
          data-preset={selected ?? "default"}
          tooltip={t("chat.chatInstructions")}
          ariaLabel={`${t("chat.chatInstructions")}: ${labelOf(selected)}`}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={controlsBlocked}
          onClick={() => {
            onCloseOtherMenus();
            setOpen((current) => !current);
          }}
        >
          <IconChat size={12} aria-hidden="true" />
          <span className="text-sm">{labelOf(selected)}</span>
          <IconChevronDown
            size={12}
            aria-hidden="true"
            className="composer-mode-chip-caret"
          />
        </TooltipButton>
      )}
    >
      {options.map((option) => (
        <button
          key={option ?? "default"}
          type="button"
          role="menuitemradio"
          aria-checked={selected === option}
          disabled={controlsBlocked}
          className={`composer-plus-item ${selected === option ? "active" : ""}`}
          onClick={() => {
            setOpen(false);
            void select(option);
          }}
        >
          <span className="flex-1 text-left">{labelOf(option)}</span>
          {selected === option ? <IconCheck size={13} /> : null}
        </button>
      ))}
    </AnchoredMenu>
  );
}
