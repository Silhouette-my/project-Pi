import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Select, Textarea } from "../../components/ui";
import { IconArrowUp } from "../../components/icons";
import { ProjectPanelDialog } from "./ProjectPanelDialog";
import { buildQuotedAnswer, latestAnswer, type ConversationTarget } from "./project-panel-text";
import { useSessionMessages } from "./use-session-messages";

/**
 * Quote a thread's newest answer into the project Agent's draft so the user
 * can discuss it. It only writes the draft; the user still sends it.
 */
export function BringInDialog({
  targets,
  onInsert,
  onClose,
}: {
  targets: ConversationTarget[];
  onInsert: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [targetId, setTargetId] = useState(targets[0]?.sessionId ?? "");
  const target = targets.find((item) => item.sessionId === targetId);
  const messages = useSessionMessages(target?.sessionId, true);
  const answer = useMemo(() => latestAnswer(messages ?? []), [messages]);
  const generated = useMemo(
    () =>
      answer && target
        ? buildQuotedAnswer(answer, t("projectPanel.quotedFrom", { title: target.title }))
        : "",
    [answer, t, target],
  );
  const [edit, setEdit] = useState<{ base: string; text: string } | null>(null);
  const text = edit && edit.base === generated ? edit.text : generated;

  useEffect(() => {
    if (!targets.some((item) => item.sessionId === targetId)) setTargetId(targets[0]?.sessionId ?? "");
  }, [targetId, targets]);

  const loading = Boolean(target) && messages === undefined;
  return (
    <ProjectPanelDialog
      title={t("projectPanel.bringTitle")}
      description={t("projectPanel.bringDescription")}
      icon={<IconArrowUp size={16} aria-hidden />}
      workflow="project-bring-dialog"
      onClose={onClose}
    >
      <form
        className="project-panel-dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim()) return;
          onInsert(text.trim());
          onClose();
        }}
      >
        <div>
          <label className="session-rename-dialog-label" htmlFor={`${id}-source`}>
            {t("projectPanel.source")}
          </label>
          <Select
            id={`${id}-source`}
            value={targetId}
            disabled={targets.length === 0}
            onChange={(event) => setTargetId(event.target.value)}
            data-project-bring-source
          >
            {targets.map((item) => (
              <option key={item.sessionId} value={item.sessionId}>
                {item.title}
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
          <label className="session-rename-dialog-label" htmlFor={`${id}-preview`}>
            {t("projectPanel.preview")}
          </label>
          <Textarea
            id={`${id}-preview`}
            className="project-panel-dialog-preview"
            rows={8}
            value={text}
            onChange={(event) => setEdit({ base: generated, text: event.target.value })}
            data-project-bring-preview
          />
          {target && !loading && !answer ? (
            <p className="project-panel-dialog-note" role="status">
              {t("projectPanel.noAnswer")}
            </p>
          ) : null}
        </div>
        <div className="session-rename-dialog-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!text.trim()} data-project-bring-submit>
            {t("projectPanel.insertAgentDraft")}
          </Button>
        </div>
      </form>
    </ProjectPanelDialog>
  );
}
