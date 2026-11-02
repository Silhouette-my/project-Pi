import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkflowArtifact, WorkflowWorkstream } from "@pi-desktop/shared";
import { Badge, Button, Field, Input, Select, Textarea } from "../../components/ui";
import { IconChevronRight } from "../../components/icons";
import { formatWorkflowTime } from "./workflow-display";
import { useProjectWorkflow } from "./useProjectWorkflow";
import { WorkflowRecord, WorkflowReference, type WorkflowSurfaceProps } from "./WorkflowReference";
import "./context-artifacts-styles.css";

function CandidateFeedback({
  artifact,
  workstream,
}: {
  artifact: WorkflowArtifact;
  workstream?: WorkflowWorkstream;
}) {
  const { t } = useTranslation();
  const workflow = useProjectWorkflow();
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const [environment, setEnvironment] = useState(artifact.environment);
  const [acceptanceId, setAcceptanceId] = useState(workstream?.acceptance[0]?.id ?? "");
  useEffect(() => {
    setEditing(false);
    setComment("");
    setEnvironment(artifact.environment);
    setAcceptanceId(workstream?.acceptance[0]?.id ?? "");
  }, [artifact.id, artifact.revision, artifact.environment, workstream?.id]);
  async function submit() {
    if (!comment.trim() || !acceptanceId) return;
    const result = await workflow.mutate({
      kind: "feedback.add",
      feedback: {
        id: crypto.randomUUID(),
        projectId: artifact.projectId,
        workstreamId: artifact.workstreamId,
        candidateId: artifact.id,
        candidateRevision: artifact.revision,
        environment: environment.trim(),
        acceptanceId,
        comment: comment.trim(),
        source: { kind: "user", ref: "user" },
        createdAt: new Date().toISOString(),
      },
    });
    if (result) {
      setComment("");
      setEditing(false);
    }
  }
  if (!editing)
    return (
      <Button
        variant="secondary"
        disabled={workflow.busy || !workstream?.acceptance.length}
        onClick={() => setEditing(true)}
      >
        {t("workflowArtifacts.giveFeedback")}
      </Button>
    );
  return (
    <form
      className="workflow-feedback-form"
      data-workflow-feedback-editor={artifact.id}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p>
        {t("workflowArtifacts.feedbackPinned", { id: artifact.id, revision: artifact.revision })}
      </p>
      <Field label={t("workflowArtifacts.environment")}>
        <Input value={environment} onChange={(event) => setEnvironment(event.target.value)} />
      </Field>
      <Field label={t("workflowArtifacts.acceptance")}>
        <Select
          required
          value={acceptanceId}
          onChange={(event) => setAcceptanceId(event.target.value)}
        >
          {workstream?.acceptance.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("workflowArtifacts.feedbackComment")}>
        <Textarea required value={comment} onChange={(event) => setComment(event.target.value)} />
      </Field>
      <div className="workflow-record-actions">
        <Button type="submit" disabled={workflow.busy || !comment.trim() || !acceptanceId}>
          {t("workflowArtifacts.submitFeedback")}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
          {t("workflowContext.cancel")}
        </Button>
      </div>
    </form>
  );
}

export function WorkflowArtifacts({
  projectId,
  workstreamId,
  onOpenReference,
}: WorkflowSurfaceProps) {
  const { t, i18n } = useTranslation();
  const workflow = useProjectWorkflow();
  const snapshot = workflow.snapshot;
  if (!snapshot) return null;
  const inScope = (item: { projectId: string; workstreamId: string }) =>
    item.projectId === projectId && (!workstreamId || item.workstreamId === workstreamId);
  const artifacts = snapshot.artifacts.filter(inScope);
  const workstreams = snapshot.workstreams.filter(
    (item) => item.projectId === projectId && (!workstreamId || item.id === workstreamId),
  );
  const currentIds = new Set(
    workstreams.flatMap((item) => (item.currentCandidateId ? [item.currentCandidateId] : [])),
  );
  const current = artifacts.filter((item) => currentIds.has(item.id));
  const history = artifacts.filter((item) => !currentIds.has(item.id));
  const deliveries = snapshot.deliveries.filter(inScope);
  const runs = snapshot.runs.filter(inScope);
  if (!artifacts.length && !deliveries.length && !runs.length) {
    return <p className="project-empty-line">{t("workflow.noArtifacts")}</p>;
  }
  const workstreamLabel = (id: string) => workstreams.find((item) => item.id === id)?.title ?? id;
  function artifactView(item: WorkflowArtifact, isCurrent: boolean) {
    const workstream = workstreams.find((entry) => entry.id === item.workstreamId);
    const evidence = snapshot!.evidence.filter(
      (entry) => inScope(entry) && entry.candidateId === item.id,
    );
    const feedback = snapshot!.feedback.filter(
      (entry) => inScope(entry) && entry.candidateId === item.id,
    );
    return (
      <WorkflowRecord
        key={item.id}
        className="workflow-record"
        data-workflow-artifact={item.id}
        data-current-candidate={isCurrent || undefined}
      >
        <div className="workflow-record-heading">
          <strong>{item.label}</strong>
          {isCurrent ? null : <Badge>{t(`workflowArtifacts.artifactKinds.${item.kind}`)}</Badge>}
        </div>
        <p className="workflow-record-muted">{workstreamLabel(item.workstreamId)}</p>
        <dl className="workflow-record-metadata">
          <dt>{t("workflowArtifacts.candidateId")}</dt>
          <dd>{item.id}</dd>
          <dt>{t("workflowArtifacts.revision")}</dt>
          <dd>{item.revision}</dd>
          <dt>{t("workflowArtifacts.environment")}</dt>
          <dd>{item.environment || t("workflowContext.unspecified")}</dd>
          <dt>{t("workflowArtifacts.source")}</dt>
          <dd>
            {t(`workflowContext.sourceKinds.${item.source.kind}`)} · {item.source.ref}
            {item.source.revision ? ` · ${item.source.revision}` : ""}
          </dd>
          {item.runId ? (
            <>
              <dt>{t("workflowArtifacts.originRun")}</dt>
              <dd>{item.runId}</dd>
            </>
          ) : null}
          {item.supersedesId ? (
            <>
              <dt>{t("workflowArtifacts.supersedes")}</dt>
              <dd>
                {snapshot!.artifacts.find((entry) => entry.id === item.supersedesId)?.label ??
                  item.supersedesId}
              </dd>
            </>
          ) : null}
        </dl>
        <div className="workflow-record-heading">
          <span>{t("workflowArtifacts.entryPoint")}</span>
          <WorkflowReference
            reference={{ kind: "artifact", id: item.id }}
            uri={item.entryPoint}
            onOpenReference={onOpenReference}
          />
        </div>
        <h4>{t("workflowArtifacts.evidence")}</h4>
        {evidence.length === 0 ? (
          <p className="workflow-record-muted">{t("workflowArtifacts.noEvidence")}</p>
        ) : (
          evidence.map((entry) => (
            <div key={entry.id} className="workflow-evidence" data-workflow-evidence={entry.id}>
              <div className="workflow-record-heading">
                <strong>{entry.scenario}</strong>
                <Badge>{t(`workflowArtifacts.outcomes.${entry.outcome}`)}</Badge>
                <Badge>{t(`workflowArtifacts.evidenceKinds.${entry.kind}`)}</Badge>
              </div>
              <dl className="workflow-record-metadata">
                <dt>{t("workflowArtifacts.revision")}</dt>
                <dd>{entry.candidateRevision}</dd>
                <dt>{t("workflowArtifacts.environment")}</dt>
                <dd>{entry.environment || t("workflowContext.unspecified")}</dd>
                <dt>{t("workflowArtifacts.acceptance")}</dt>
                <dd>
                  {workstream?.acceptance.find((condition) => condition.id === entry.acceptanceId)
                    ?.title ?? entry.acceptanceId}
                </dd>
                <dt>{t("workflowArtifacts.limits")}</dt>
                <dd>{entry.limits || t("workflowContext.unspecified")}</dd>
                <dt>{t("workflowArtifacts.source")}</dt>
                <dd>
                  {t(`workflowContext.sourceKinds.${entry.source.kind}`)} · {entry.source.ref}
                </dd>
              </dl>
            </div>
          ))
        )}
        {feedback.length ? <h4>{t("workflowArtifacts.feedback")}</h4> : null}
        {feedback.map((entry) => (
          <div key={entry.id} className="workflow-evidence" data-workflow-feedback={entry.id}>
            <p className="workflow-record-prose">{entry.comment}</p>
            <dl className="workflow-record-metadata">
              <dt>{t("workflowArtifacts.revision")}</dt>
              <dd>{entry.candidateRevision}</dd>
              <dt>{t("workflowArtifacts.environment")}</dt>
              <dd>{entry.environment || t("workflowContext.unspecified")}</dd>
              <dt>{t("workflowArtifacts.acceptance")}</dt>
              <dd>
                {workstream?.acceptance.find((condition) => condition.id === entry.acceptanceId)
                  ?.title ?? entry.acceptanceId}
              </dd>
            </dl>
          </div>
        ))}
        {item.kind === "candidate" || isCurrent ? (
          <CandidateFeedback artifact={item} workstream={workstream} />
        ) : null}
      </WorkflowRecord>
    );
  }
  return (
    <section className="workflow-context-artifacts" aria-label={t("workflowArtifacts.title")}>
      {current.map((item) => artifactView(item, true))}
      {history.length ? (
        <details className="workflow-record-history">
          <summary><IconChevronRight size={12} className="project-disclosure-icon" />{t("workflowArtifacts.otherArtifacts", { count: history.length })}</summary>
          {history.map((item) => artifactView(item, false))}
        </details>
      ) : null}
      {deliveries.length > 0 && <h4 className="workflow-artifacts-subhead">{t("workflowArtifacts.deliveries")}</h4>}
      {!deliveries.length ? null : (
        deliveries.map((item) => (
          <WorkflowRecord
            key={item.id}
            className="workflow-record"
            data-workflow-delivery={item.id}
          >
            <div className="workflow-record-heading">
              <strong>{t(`workflowArtifacts.deliveryKinds.${item.kind}`)}</strong>
              <Badge>{t(`workflowArtifacts.deliveryStates.${item.state}`)}</Badge>
              <Badge>{t(`workflowArtifacts.dispositions.${item.disposition}`)}</Badge>
            </div>
            <p className="workflow-record-prose">{item.summary}</p>
            <dl className="workflow-record-metadata">
              <dt>{t("workflowArtifacts.workstream")}</dt>
              <dd>{workstreamLabel(item.workstreamId)}</dd>
              <dt>{t("workflowArtifacts.originRun")}</dt>
              <dd>{item.sourceRunId}</dd>
              <dt>{t("workflowArtifacts.decisionRevision")}</dt>
              <dd>{item.decisionRevision}</dd>
              {item.consumedAt ? (
                <>
                  <dt>{t("workflowArtifacts.consumedAt")}</dt>
                  <dd>{item.consumedAt}</dd>
                </>
              ) : null}
            </dl>
            {item.artifactIds.map((id) => {
              const artifact = snapshot.artifacts.find(
                (entry) => entry.id === id && inScope(entry),
              );
              return artifact ? (
                <div key={id} className="workflow-record-heading">
                  <span>
                    {artifact.label} · {artifact.revision}
                  </span>
                  <WorkflowReference
                    reference={{ kind: "artifact", id: artifact.id }}
                    uri={artifact.entryPoint}
                    onOpenReference={onOpenReference}
                  />
                </div>
              ) : (
                <p key={id}>{id}</p>
              );
            })}
          </WorkflowRecord>
        ))
      )}
      {runs.length > 0 && <h4 className="workflow-artifacts-subhead">{t("workflowArtifacts.runs")}</h4>}
      {!runs.length ? null : (
        runs.map((item) => (
          <WorkflowRecord key={item.id} className="workflow-record" data-workflow-run={item.id}>
            <div className="workflow-record-heading">
              <strong>{workstreamLabel(item.workstreamId)}</strong>
              <Badge>{t(`workflowArtifacts.runStates.${item.state}`)}</Badge>
            </div>
            <p className="workflow-record-prose">
              {item.outcome || t("workflowArtifacts.noOutcome")}
            </p>
            <dl className="workflow-record-metadata">
              <dt>{t("workflowArtifacts.runId")}</dt>
              <dd>{item.id}</dd>
              <dt>{t("workflowArtifacts.executor")}</dt>
              <dd>{item.executor}</dd>
              <dt>{t("workflowArtifacts.workstreamRevision")}</dt>
              <dd>{item.workstreamRevision}</dd>
              <dt>{t("workflowArtifacts.decisionRevision")}</dt>
              <dd>{item.decisionRevision}</dd>
              {item.authorizationId ? <>
                <dt>{t("workflowArtifacts.authorization")}</dt>
                <dd>{item.authorizationId}</dd>
              </> : null}
              <dt>{t("workflowContext.updatedAt")}</dt>
              <dd><time dateTime={item.updatedAt} title={item.updatedAt}>{formatWorkflowTime(item.updatedAt, i18n.language)}</time></dd>
            </dl>
            {item.effects.length ? (
              <ul className="workflow-effects">
                {item.effects.map((effect) => (
                  <li key={effect.id}>
                    <div className="workflow-record-heading">
                      <strong>{effect.action}</strong>
                      <Badge>{t(`workflowArtifacts.effectStates.${effect.state}`)}</Badge>
                    </div>
                    <p>{effect.resource}</p>
                    <p className="workflow-record-prose">{effect.detail}</p>
                  </li>
                ))}
              </ul>
            ) : null}
          </WorkflowRecord>
        ))
      )}
    </section>
  );
}
