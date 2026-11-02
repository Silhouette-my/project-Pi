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
 * The chip names only the committed selection: "None" (no instruction),
 * "Default" (the built-in chat persona; ChatGPT conversations only), or a
 * preset id. A session type that cannot take an instruction shows the chip
 * disabled with the reason as its tooltip.
 * Preset ids are file stems, so the menu lists ids, never file content.
 */
export function ComposerChatInstructionPicker({
  t,
  controller,
  controlsBlocked,
  onCloseOtherMenus,
}: {
  t: TFunction;
  controller: ChatInstructionMenuController;
  controlsBlocked: boolean;
  onCloseOtherMenus: () => void;
}) {
  const { open, setOpen, presets, select, selected, showDefault, unavailableKey } = controller;
  const blocked = controlsBlocked || unavailableKey !== null;
  const tooltip = unavailableKey ? t(unavailableKey) : t("chat.chatInstructions");
  const builtinLabels: Record<string, string> = {
    "casual-chat": t("chat.chatModeCasual"),
    exploration: t("chat.chatModeExploration"),
    "q-and-a": t("chat.chatModeQA"),
    "technical-discussion": t("chat.chatModeTechnical"),
  };
  const labelOf = (id: string | null) =>
    id === null
      ? t("chat.chatInstructionsDefault")
      : id === CHAT_INSTRUCTION_NONE_ID
        ? t("chat.chatInstructionsNone")
        : Object.hasOwn(builtinLabels, id) ? builtinLabels[id] : id;
  const options: Array<string | null> = [
    CHAT_INSTRUCTION_NONE_ID,
    ...(showDefault ? [null] : []),
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
          tooltip={tooltip}
          ariaLabel={`${t("chat.chatInstructions")}: ${labelOf(selected)}`}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={blocked}
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
          data-chat-instruction-option={option ?? "default"}
          disabled={blocked}
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
