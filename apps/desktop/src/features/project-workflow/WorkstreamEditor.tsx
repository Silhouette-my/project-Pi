import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkflowWorkstream } from "@pi-desktop/shared";
import { Button, Field, Input, Textarea } from "../../components/ui";
import { IconChevronRight } from "../../components/icons";
import { useProjectWorkflow } from "./useProjectWorkflow";

export function WorkstreamEditor({
  projectId,
  workstream,
  onSaved,
  onClose,
}: {
  projectId: string;
  workstream?: WorkflowWorkstream;
  onSaved: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { snapshot, mutate, busy } = useProjectWorkflow();
  const sessionTask = !workstream || workstream.executionMode === "session";
  const [title, setTitle] = useState(workstream?.title ?? "");
  const [goal, setGoal] = useState(workstream?.goal ?? "");
  const [acceptance, setAcceptance] = useState(
    workstream?.acceptance.map((item) => item.title).join("\n") ?? "",
  );
  const baseline = useRef(workstream);
  const [conflict, setConflict] = useState(false);
  const reload = () => {
    baseline.current = workstream;
    setTitle(workstream?.title ?? "");
    setGoal(workstream?.goal ?? "");
    setAcceptance(workstream?.acceptance.map((item) => item.title).join("\n") ?? "");
    setConflict(false);
  };
  const save = async () => {
    const items = acceptance
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean)
      .map(
        (name) =>
          workstream?.acceptance.find((item) => item.title === name) ?? {
            id: crypto.randomUUID(),
            title: name,
            status: "pending" as const,
            evidenceIds: [],
          },
      );
    const fields = {
      title: title.trim() || Array.from(goal.trim().split(/\r?\n/, 1)[0]).slice(0, 80).join(""),
      goal: goal.trim(),
      acceptance: items,
    };
    const patch: Partial<typeof fields> = {};
    if (baseline.current && workstream) {
      for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
        const unchanged =
          key === "acceptance"
            ? acceptance === baseline.current.acceptance.map((item) => item.title).join("\n")
            : JSON.stringify(fields[key]) === JSON.stringify(baseline.current[key]);
        if (unchanged) continue;
        if (JSON.stringify(workstream[key]) !== JSON.stringify(baseline.current[key])) {
          setConflict(true);
          return;
        }
        Object.assign(patch, { [key]: fields[key] });
      }
    }
    const now = new Date().toISOString();
    const id = workstream?.id ?? crypto.randomUUID();
    const result = workstream
      ? await mutate({ kind: "workstream.update", projectId, workstreamId: id, patch })
      : await mutate({
          kind: "workstream.create",
          workstream: {
            ...fields,
            owner: { kind: "user", ref: "user" },
            priority: 0,
            nextAction: "",
            dependencyIds: [],
            executionMode: "session",
            id,
            projectId,
            status: "draft",
            order: snapshot?.workstreams.filter((item) => item.projectId === projectId).length ?? 0,
            revision: 0,
            decisionRevision: 0,
            createdAt: now,
            updatedAt: now,
          },
        });
    if (result) onSaved(id);
  };
  return (
    <form
      className="workflow-form"
      data-workflow="workstream-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3 id="workflow-workstream-editor-title">{t(workstream ? "workflow.editWorkstream" : "workflow.newWorkstream")}</h3>
      {conflict && (
        <div role="alert">
          <p>{t("workflow.conflict")}</p>
          <Button type="button" onClick={reload}>
            {t("workflow.retry")}
          </Button>
        </div>
      )}
      <Field label={t("workflow.goal")}>
        <Textarea
          autoFocus
          required
          rows={5}
          placeholder={t("workflow.taskPlaceholder")}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
        />
      </Field>
      <details className="workflow-authority-details" open={workstream ? true : undefined}>
        <summary tabIndex={0}><IconChevronRight size={12} className="project-disclosure-icon" />{t(sessionTask ? "workflow.taskDetails" : "workflow.editWorkstream")}</summary>
        <div className="workflow-task-fields">
          <Field label={t("workflow.title")} hint={t("workflow.titleAutoHint")}>
            <Input
              maxLength={512}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label={t("workflow.acceptance")} hint={t(sessionTask ? "workflow.acceptanceOptionalHint" : "workflow.acceptanceHint")}>
            <Textarea
              required={!sessionTask}
              rows={3}
              value={acceptance}
              onChange={(event) => setAcceptance(event.target.value)}
            />
          </Field>
        </div>
      </details>
      <div className="workflow-actions">
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !goal.trim() || (!sessionTask && !acceptance.trim())}
        >
          {t("workflow.save")}
        </Button>
        <Button type="button" onClick={onClose}>
          {t("workflow.close")}
        </Button>
      </div>
    </form>
  );
}
