import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Select, Textarea } from "../../components/ui";
import { IconArrowUpRight } from "../../components/icons";
import { useAppStore } from "../../stores/app-store";
import { appendComposerDraftText, draftKeyForSession } from "../../lib/composer-draft-cache";
import { ProjectPanelDialog } from "./ProjectPanelDialog";
import {
  buildSendContent,
  withAttribution,
  type ConversationTarget,
  type SendContent,
} from "./project-panel-text";
import { useSessionMessages } from "./use-session-messages";

type ContentChoice = "latest" | "1" | "3" | "all";

function contentOf(choice: ContentChoice): SendContent {
  return choice === "latest"
    ? { kind: "latest" }
    : { kind: "exchanges", count: choice === "all" ? "all" : (Number(choice) as 1 | 3) };
}

/**
 * Hand part of the project Agent's discussion to a project conversation. The
 * user picks the thread, what to carry over and edits the text; nothing is
 * sent until the user presses a button. The Agent itself has no way to reach
 * a thread (ADR project-agent-discussion-boundary).
 *
 * Sending names its target session and leaves the visible page alone, like
 * every other detached conversation. Inserting writes the target's composer
 * draft and never sends.
 */
export function SendToConversationDialog({
  agentSessionId,
  targets,
  onClose,
}: {
  agentSessionId: string | undefined;
  targets: ConversationTarget[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const messages = useSessionMessages(agentSessionId, true);
  const [targetId, setTargetId] = useState(targets[0]?.sessionId ?? "");
  const [choice, setChoice] = useState<ContentChoice>("latest");
  const attribution = t("projectPanel.fromAgent");
  const labels = useMemo(
    () => ({ user: t("projectPanel.youLabel"), agent: t("projectPanel.agentLabel") }),
    [t],
  );
  const generated = useMemo(
    () => withAttribution(attribution, buildSendContent(messages ?? [], contentOf(choice), labels)),
    [attribution, choice, labels, messages],
  );
  // The preview is editable. It follows the chosen content until the user
  // types, and picking other content starts from that content again.
  const [edit, setEdit] = useState<{ base: string; text: string } | null>(null);
  const text = edit && edit.base === generated ? edit.text : generated;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = targets.find((item) => item.sessionId === targetId);

  useEffect(() => {
    if (!targets.some((item) => item.sessionId === targetId)) setTargetId(targets[0]?.sessionId ?? "");
  }, [targetId, targets]);

  const kindLabel = (item: ConversationTarget) =>
    item.kind === "side"
      ? t("projectPanel.kindSide")
      : item.kind === "workstream"
        ? t("projectPanel.kindWorkstream")
        : t("projectPanel.kindChat");

  async function send() {
    const body = text.trim();
    if (!target || !body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const accepted = await useAppStore
        .getState()
        .sendPrompt(body, { text: body, fileReferences: [] }, target.sessionId);
      if (!accepted) throw new Error(t("projectPanel.sendFailed"));
      useAppStore
        .getState()
        .showToast(t("projectPanel.sent", { title: target.title }), { variant: "success" });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function insert() {
    const body = text.trim();
    if (!target || !body) return;
    const snapshot = appendComposerDraftText(draftKeyForSession(target.sessionId), body);
    const state = useAppStore.getState();
    // A mounted Composer adopts the new draft through its ordinary prefill path.
    if (snapshot && state.activeSessionId === target.sessionId) {
      useAppStore.setState({
        composerPrefill: {
          sessionId: target.sessionId,
          text: snapshot.text,
          fileReferences: snapshot.fileReferences,
        },
      });
    }
    state.showToast(t("projectPanel.inserted", { title: target.title }), { variant: "success" });
    onClose();
  }

  const empty = !generated;
  return (
    <ProjectPanelDialog
      title={t("projectPanel.sendTitle")}
      description={t("projectPanel.sendDescription")}
      icon={<IconArrowUpRight size={16} aria-hidden />}
      workflow="project-send-dialog"
      busy={busy}
      onClose={onClose}
    >
      <form
        className="project-panel-dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div>
          <label className="session-rename-dialog-label" htmlFor={`${id}-target`}>
            {t("projectPanel.target")}
          </label>
          <Select
            id={`${id}-target`}
            value={targetId}
            disabled={busy || targets.length === 0}
            onChange={(event) => setTargetId(event.target.value)}
            data-project-send-target
          >
            {targets.map((item) => (
              <option key={item.sessionId} value={item.sessionId}>
                {item.title} · {kindLabel(item)}
              </option>
            ))}
          </Select>
          {targets.length === 0 ? (
            <p className="project-panel-dialog-note" role="status">
              {t("projectPanel.noTargets")}
            </p>
          ) : null}
        </div>
        <div>
          <label className="session-rename-dialog-label" htmlFor={`${id}-content`}>
            {t("projectPanel.content")}
          </label>
          <Select
            id={`${id}-content`}
            value={choice}
            disabled={busy}
            onChange={(event) => setChoice(event.target.value as ContentChoice)}
            data-project-send-content
          >
            <option value="latest">{t("projectPanel.contentLatest")}</option>
            <option value="1">{t("projectPanel.contentLast1")}</option>
            <option value="3">{t("projectPanel.contentLast3")}</option>
            <option value="all">{t("projectPanel.contentAll")}</option>
          </Select>
        </div>
        <div>
          <label className="session-rename-dialog-label" htmlFor={`${id}-preview`}>
            {t("projectPanel.preview")}
          </label>
          <Textarea
            id={`${id}-preview`}
            className="project-panel-dialog-preview"
            rows={8}
            value={text}
            disabled={busy}
            onChange={(event) => setEdit({ base: generated, text: event.target.value })}
            data-project-send-preview
          />
          {empty ? (
            <p className="project-panel-dialog-note" role="status">
              {t("projectPanel.nothingToSend")}
            </p>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="workflow-navigation-error">
            {error}
          </p>
        ) : null}
        <div className="session-rename-dialog-actions">
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || !target || !text.trim()}
            onClick={insert}
            data-project-send-insert
          >
            {t("projectPanel.insertDraft")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !target || !text.trim()}
            data-project-send-submit
          >
            {t("projectPanel.send")}
          </Button>
        </div>
      </form>
    </ProjectPanelDialog>
  );
}
