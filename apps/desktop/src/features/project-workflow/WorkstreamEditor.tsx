import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkflowWorkstream } from "@pi-desktop/shared";
import { Button, Checkbox, Field, Input, Select, Textarea } from "../../components/ui";
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
  const [title, setTitle] = useState(workstream?.title ?? "");
  const [goal, setGoal] = useState(workstream?.goal ?? "");
  const [acceptance, setAcceptance] = useState(
    workstream?.acceptance.map((item) => item.title).join("\n") ?? "",
  );
  const [ownerKind, setOwnerKind] = useState<WorkflowWorkstream["owner"]["kind"]>(
    workstream?.owner.kind ?? "user",
  );
  const [ownerRef, setOwnerRef] = useState(workstream?.owner.ref ?? "user");
  const [priority, setPriority] = useState(workstream?.priority ?? 0);
  const [nextAction, setNextAction] = useState(workstream?.nextAction ?? "");
  const [dependencyIds, setDependencyIds] = useState(workstream?.dependencyIds ?? []);
  const baseline = useRef(workstream);
  const [conflict, setConflict] = useState(false);
  const reload = () => {
    baseline.current = workstream;
    setTitle(workstream?.title ?? "");
    setGoal(workstream?.goal ?? "");
    setAcceptance(workstream?.acceptance.map((item) => item.title).join("\n") ?? "");
    setOwnerKind(workstream?.owner.kind ?? "user");
    setOwnerRef(workstream?.owner.ref ?? "user");
    setPriority(workstream?.priority ?? 0);
    setNextAction(workstream?.nextAction ?? "");
    setDependencyIds(workstream?.dependencyIds ?? []);
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
      title: title.trim(),
      goal: goal.trim(),
      acceptance: items,
      owner: { kind: ownerKind, ref: ownerRef.trim() },
      priority,
      nextAction: nextAction.trim(),
      dependencyIds,
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
      <Field label={t("workflow.title")}>
        <Input
          autoFocus
          required
          maxLength={512}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </Field>
      <Field label={t("workflow.goal")}>
        <Textarea
          required
          rows={3}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
        />
      </Field>
      <Field label={t("workflow.acceptance")} hint={t("workflow.acceptanceHint")}>
        <Textarea
          required
          rows={3}
          value={acceptance}
          onChange={(event) => setAcceptance(event.target.value)}
        />
      </Field>
      <div className="workflow-form-grid">
        <Field label={t("workflow.ownerKind")}>
          <Select
            value={ownerKind}
            onChange={(event) => setOwnerKind(event.target.value as typeof ownerKind)}
          >
            {(["user", "session", "agent"] as const).map((kind) => (
              <option key={kind} value={kind}>
                {t(`workflow.ownerKinds.${kind}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("workflow.owner")}>
          <Input required value={ownerRef} onChange={(event) => setOwnerRef(event.target.value)} />
        </Field>
        <Field label={t("workflow.priority")}>
          <Input
            type="number"
            step={1}
            value={priority}
            onChange={(event) => setPriority(Number(event.target.value))}
          />
        </Field>
      </div>
      <Field label={t("workflow.nextAction")}>
        <Textarea
          rows={2}
          value={nextAction}
          onChange={(event) => setNextAction(event.target.value)}
        />
      </Field>
      <fieldset>
        <legend>{t("workflow.dependencies")}</legend>
        {snapshot?.workstreams
          .filter((item) => item.projectId === projectId && item.id !== workstream?.id)
          .map((item) => (
            <Checkbox
              key={item.id}
              checked={dependencyIds.includes(item.id)}
              onChange={(event) =>
                setDependencyIds((ids) =>
                  event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id),
                )
              }
              label={item.title}
            />
          ))}
      </fieldset>
      <div className="workflow-actions">
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !title.trim() || !goal.trim() || !acceptance.trim() || !ownerRef.trim()}
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
