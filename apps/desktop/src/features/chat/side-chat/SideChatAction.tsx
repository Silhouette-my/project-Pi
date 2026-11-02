import { useTranslation } from "react-i18next";
import { IconPanelOpen } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { sessionAllows } from "../../../lib/remote-session-safety";
import { useAppStore } from "../../../stores/app-store";

/**
 * "Ask in side chat" in a message's hover action row.
 *
 * Opens a draft tab anchored at the message (no session is created). Offered
 * only for the visible conversation: a transcript shown by a detached surface
 * (including a side chat itself) is not a place to start another side chat.
 */
export function SideChatAction({
  messageId,
  paneSessionId,
  role,
}: {
  role: "user" | "assistant";
  messageId: string;
  paneSessionId: string;
}) {
  const { t } = useTranslation();
  const openSideChat = useAppStore((state) => state.openSideChat);
  const available = useAppStore((state) => {
    if (state.activeSessionId !== paneSessionId || paneSessionId.startsWith("remote:")) return false;
    return sessionAllows(
      state.sessions.find((session) => session.id === paneSessionId),
      "canEditMessages",
    );
  });
  if (!available) return null;
  return (
    <TooltipButton
      className="copy-btn icon"
      tooltip={t("chat.askInSideChat")}
      ariaLabel={t("chat.askInSideChat")}
      data-side-chat-entry={messageId}
      data-side-chat-role={role}
      onClick={() => openSideChat(messageId)}
    >
      <IconPanelOpen size={13} />
    </TooltipButton>
  );
}
