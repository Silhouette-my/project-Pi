import { useTranslation } from "react-i18next";
import { Button } from "../../../components/ui";
import { DetachedConversation } from "../../../components/conversation/DetachedConversation";
import { useAppStore } from "../../../stores/app-store";
import type { WorkPanelTab } from "../../../lib/work-panel-tabs";
import { sideChatFirstSendBlockReason, newestAssistantAnswer } from "./side-chat-core";
import {
  addSideChatAnswerToMain,
  installSideChatLifecycle,
  openSideChatAsConversation,
  sendSideChatMessage,
  useSideChatDraft,
} from "./side-chat-session";
import "./side-chat.css";

installSideChatLifecycle();

/**
 * The work-panel surface of one side chat (ADR side-chats-on-detached-transcripts).
 *
 * A compact header, then the shared detached conversation. Before the first
 * Send there is no session: the panel is only a draft anchored at a message.
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
  const childTitle = useAppStore((state) =>
    childId ? state.sessions.find((session) => session.id === childId)?.title.trim() : undefined,
  );
  const hasAnswer = useAppStore((state) => {
    if (!childId) return false;
    const messages =
      state.activeSessionId === childId ? state.messages : state.retainedTranscripts[childId];
    return Boolean(newestAssistantAnswer(messages ?? []));
  });
  if (!anchor) return null;

  const blocked = childId ? undefined : sideChatFirstSendBlockReason(parent, parentRunning);
  const title = childTitle || tab.label || t("sideChat.title");

  return (
    <div className="side-chat" data-side-chat={tab.id} data-side-chat-session={childId ?? ""}>
      <header className="side-chat-header">
        <h3 className="side-chat-title" title={title}>{title}</h3>
        {anchor.excerpt ? (
          <p className="side-chat-excerpt" title={anchor.excerpt}>
            {t("sideChat.parentExcerpt", { excerpt: anchor.excerpt })}
          </p>
        ) : null}
        <div className="side-chat-actions">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-side-chat-action="add-to-main"
            disabled={!hasAnswer}
            onClick={() => addSideChatAnswerToMain(tab)}
          >
            {t("sideChat.addToMain")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-side-chat-action="open-as-session"
            disabled={!childId}
            onClick={() => void openSideChatAsConversation(tab)}
          >
            {t("sideChat.openAsSession")}
          </Button>
        </div>
      </header>
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
      />
    </div>
  );
}
