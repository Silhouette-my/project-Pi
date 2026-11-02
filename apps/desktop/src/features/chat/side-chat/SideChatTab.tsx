import { useTranslation } from "react-i18next";
import { TooltipButton } from "../../../components/ui";
import { IconNewSession } from "../../../components/icons";
import { DetachedConversation } from "../../../components/conversation/DetachedConversation";
import { FloatingReturnBar } from "../../../components/workpanel/FloatingReturnBar";
import { useAppStore } from "../../../stores/app-store";
import type { WorkPanelTab } from "../../../lib/work-panel-tabs";
import {
  DEFAULT_SIDE_CHAT_RETURN_MODE,
  SIDE_CHAT_RETURN_MODES,
  sideChatFirstSendBlockReason,
  sideChatReturnBlockReason,
} from "./side-chat-core";
import {
  installSideChatLifecycle,
  openSideChatAsConversation,
  returnSideChatToMain,
  sendSideChatMessage,
  sideChatDiscussion,
  useSideChatDraft,
} from "./side-chat-session";
import "./side-chat.css";

installSideChatLifecycle();

/**
 * The work-panel surface of one side chat (ADR side-chats-on-detached-transcripts).
 *
 * The shared detached conversation with the floating return control over it:
 * a pill for the return mode (changeable at any time) and, while a mode other
 * than "none" is chosen, "Return to conversation". What used to be a header
 * (title, anchored excerpt) lives in the tab tooltip. Before the first Send
 * there is no session: the panel is only a draft anchored at a message.
 */
export function SideChatTab({ tab }: { tab: WorkPanelTab }) {
  const { t } = useTranslation();
  const anchor = tab.sideChat;
  const childId = tab.resource || undefined;
  const [draft, setDraft] = useSideChatDraft(tab.id);
  const parent = useAppStore((state) =>
    state.sessions.find((session) => session.id === anchor?.parentSessionId),
  );
  const parentRunning = useAppStore((state) =>
    anchor ? state.runningSessions[anchor.parentSessionId] === true : false,
  );
  const returnState = useAppStore((state) => state.sideChatReturn[tab.id]);
  const setReturnMode = useAppStore((state) => state.setSideChatReturnMode);
  const childRunning = useAppStore((state) =>
    childId ? state.runningSessions[childId] === true : false,
  );
  // Count only: the selector returns a number so a streaming token that adds no
  // new exchange does not re-render the tab.
  const turnCount = useAppStore((state) => sideChatDiscussion(state, tab).length);
  if (!anchor) return null;

  const blocked = childId ? undefined : sideChatFirstSendBlockReason(parent, parentRunning);
  const mode = returnState?.mode ?? DEFAULT_SIDE_CHAT_RETURN_MODE;
  const returning = returnState?.status === "running";
  const returnBlock = sideChatReturnBlockReason({
    mode,
    hasChild: Boolean(childId),
    childRunning,
    turnCount,
  });

  return (
    <div className="side-chat" data-side-chat={tab.id} data-side-chat-session={childId ?? ""}>
      <DetachedConversation
        key={tab.id}
        sessionId={childId}
        draft={draft}
        onDraftChange={setDraft}
        onSend={(text, configuration) => sendSideChatMessage(tab, text, configuration)}
        emptyText={t("sideChat.empty")}
        placeholder={t("sideChat.placeholder")}
        inputLabel={t("sideChat.placeholder")}
        sendLabel={t("chat.send")}
        disabledReason={blocked ? t(blocked) : undefined}
        formProps={{ "data-side-chat-form": tab.id }}
        floating={
          <FloatingReturnBar
            workflow="side-chat"
            label={t("workPanel.return.pill", { mode: t(`sideChat.returnMode.${mode}`) })}
            menuLabel={t("workPanel.return.menuLabel")}
            sections={[
              {
                id: "mode",
                options: SIDE_CHAT_RETURN_MODES.map((value) => ({
                  id: value,
                  label: t(`sideChat.returnMode.${value}`),
                  checked: value === mode,
                  disabled: returning,
                })),
                onSelect: (value) => setReturnMode(tab.id, value as typeof mode),
              },
            ]}
            actionLabel={t("workPanel.return.action")}
            showAction={mode !== "none"}
            actionDisabled={Boolean(returnBlock) || returning}
            actionBusy={returning}
            actionTitle={
              returning ? t("sideChat.returning") : returnBlock ? t(returnBlock) : undefined
            }
            onAction={() => void returnSideChatToMain(tab)}
            trailing={
              <TooltipButton
                type="button"
                className="ct-icon-btn"
                tooltip={t("sideChat.openAsSession")}
                ariaLabel={t("sideChat.openAsSession")}
                data-side-chat-action="open-as-session"
                disabled={!childId}
                onClick={() => void openSideChatAsConversation(tab)}
              >
                <IconNewSession size={14} />
              </TooltipButton>
            }
          />
        }
      />
    </div>
  );
}
