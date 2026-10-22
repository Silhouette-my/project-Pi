import { useTranslation } from "react-i18next";
import { Button, SegmentedControl } from "../../../components/ui";
import { DetachedConversation } from "../../../components/conversation/DetachedConversation";
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
  const returnState = useAppStore((state) => state.sideChatReturn[tab.id]);
  const setReturnMode = useAppStore((state) => state.setSideChatReturnMode);
  const childRunning = useAppStore((state) =>
    childId ? state.runningSessions[childId] === true : false,
  );
  // Count only: the selector returns a number so a streaming token that adds no
  // new exchange does not re-render the header.
  const turnCount = useAppStore((state) => sideChatDiscussion(state, tab).length);
  if (!anchor) return null;

  const blocked = childId ? undefined : sideChatFirstSendBlockReason(parent, parentRunning);
  const title = childTitle || tab.label || t("sideChat.title");
  const mode = returnState?.mode ?? DEFAULT_SIDE_CHAT_RETURN_MODE;
  const returning = returnState?.status === "running";
  const returnBlock = sideChatReturnBlockReason({
    mode,
    hasChild: Boolean(childId),
    childRunning,
    turnCount,
  });
  // Only a reason the user did not just cause is spelled out under the actions;
  // "no mode chosen" and "nothing sent yet" are explained by the button tooltip.
  const returnHint = returnState?.error
    ? returnState.error
    : returnBlock === "sideChat.returnBusy" && !returning
      ? t(returnBlock)
      : undefined;

  return (
    <div className="side-chat" data-side-chat={tab.id} data-side-chat-session={childId ?? ""}>
      <header className="side-chat-header">
        <h3 className="side-chat-title" title={title}>{title}</h3>
        {anchor.excerpt ? (
          <p className="side-chat-excerpt" title={anchor.excerpt}>
            {t("sideChat.parentExcerpt", { excerpt: anchor.excerpt })}
          </p>
        ) : null}
        <div className="side-chat-return" data-side-chat-return-mode={mode}>
          <span className="side-chat-return-label">{t("sideChat.returnLabel")}</span>
          <SegmentedControl
            label={t("sideChat.returnLabel")}
            role="radiogroup"
            value={mode}
            onChange={(next) => setReturnMode(tab.id, next)}
            disabled={returning}
            className="side-chat-return-modes"
            itemClassName="side-chat-return-mode"
            options={SIDE_CHAT_RETURN_MODES.map((value) => ({
              value,
              label: t(`sideChat.returnMode.${value}`),
            }))}
          />
        </div>
        <div className="side-chat-actions">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-side-chat-action="return-to-main"
            disabled={Boolean(returnBlock) || returning}
            aria-busy={returning || undefined}
            title={returnBlock && !returning ? t(returnBlock) : undefined}
            onClick={() => void returnSideChatToMain(tab)}
          >
            {returning ? t("sideChat.returning") : t("sideChat.returnToMain")}
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
        {returnHint ? (
          <p
            className={`side-chat-return-hint${returnState?.error ? " is-error" : ""}`}
            role={returnState?.error ? "alert" : "status"}
            data-side-chat-return-hint
          >
            {returnHint}
          </p>
        ) : null}
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
