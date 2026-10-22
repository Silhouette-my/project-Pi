import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkflowDecision, WorkflowResource, WorkflowSource } from "@pi-desktop/shared";
import { Badge, Button, Field, Input, Select, Textarea } from "../../components/ui";
import { formatWorkflowTime } from "./workflow-display";
import { useProjectWorkflow } from "./useProjectWorkflow";
import { WorkflowRecord, WorkflowReference, type WorkflowSurfaceProps } from "./WorkflowReference";
import "./context-artifacts-styles.css";

const userSource: WorkflowSource = { kind: "user", ref: "user" };
type ResourceDraft = {
  id?: string;
  baseline?: WorkflowResource;
  label: string;
  uri: string;
  kind: WorkflowResource["kind"];
  revision: string;
  workstreamId: string;
  sourceKind: WorkflowSource["kind"];
  sourceRef: string;
  sourceRevision: string;
};
const newResource = (workstreamId = ""): ResourceDraft => ({
  label: "",
  uri: "",
  kind: "doc",
  revision: "",
  workstreamId,
  sourceKind: "user",
  sourceRef: "user",
  sourceRevision: "",
});
function sameResource(left: WorkflowResource, right: WorkflowResource): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.workstreamId === right.workstreamId &&
    left.label === right.label &&
    left.uri === right.uri &&
    left.kind === right.kind &&
    left.revision === right.revision &&
    left.updatedAt === right.updatedAt &&
    left.state === right.state &&
    left.source.kind === right.source.kind &&
    left.source.ref === right.source.ref &&
    left.source.revision === right.source.revision
  );
}

export function WorkflowContext({
  projectId,
  workstreamId,
  onOpenReference,
}: WorkflowSurfaceProps) {
  const { t, i18n } = useTranslation();
  const workflow = useProjectWorkflow();
  const [resource, setResource] = useState<ResourceDraft | null>(null);
  const [proposal, setProposal] = useState<{
    title: string;
    statement: string;
    workstreamId: string;
    supersedesId: string;
  } | null>(null);
  useEffect(() => {
    setResource(null);
    setProposal(null);
  }, [projectId, workstreamId]);
  const snapshot = workflow.snapshot;
  if (!snapshot) return null;
  const workstreams = snapshot.workstreams.filter((item) => item.projectId === projectId);
  const resources = snapshot.resources.filter(
    (item) =>
      item.projectId === projectId &&
      (!workstreamId || !item.workstreamId || item.workstreamId === workstreamId),
  );
  const decisions = snapshot.decisions.filter(
    (item) => item.projectId === projectId && (!workstreamId || item.workstreamId === workstreamId),
  );
  const currentResource = resource?.id
    ? snapshot.resources.find((item) => item.id === resource.id)
    : undefined;
  const resourceConflict = Boolean(
    resource?.baseline && (!currentResource || !sameResource(resource.baseline, currentResource)),
  );
  const scopeLabel = (id?: string) =>
    id
      ? (workstreams.find((item) => item.id === id)?.title ?? id)
      : t("workflowContext.projectScope");
  const sourceLabel = (source: WorkflowSource) =>
    t("workflowContext.sourceValue", {
      kind: t(`workflowContext.sourceKinds.${source.kind}`),
      ref: source.ref,
      revision: source.revision || t("workflowContext.unspecified"),
    });
  function editResource(item: WorkflowResource) {
    setResource({
      ...item,
      baseline: structuredClone(item),
      workstreamId: item.workstreamId ?? "",
      sourceKind: item.source.kind,
      sourceRef: item.source.ref,
      sourceRevision: item.source.revision ?? "",
    });
  }
  async function saveResource() {
    if (
      !resource ||
      resourceConflict ||
      !resource.label.trim() ||
      !resource.uri.trim() ||
      !resource.sourceRef.trim()
    )
      return;
    const result = await workflow.mutate({
      kind: "resource.put",
      resource: {
        id: resource.id ?? crypto.randomUUID(),
        projectId,
        workstreamId: resource.workstreamId || undefined,
        label: resource.label.trim(),
        uri: resource.uri.trim(),
        kind: resource.kind,
        revision: resource.revision.trim(),
        updatedAt: new Date().toISOString(),
        state: resource.baseline?.state ?? "effective",
        source: {
          kind: resource.sourceKind,
          ref: resource.sourceRef.trim(),
          revision: resource.sourceRevision.trim() || undefined,
        },
      },
    });
    if (result) setResource(null);
  }
  async function saveProposal() {
    if (!proposal?.workstreamId || !proposal.title.trim() || !proposal.statement.trim()) return;
    const decision: WorkflowDecision = {
      id: crypto.randomUUID(),
      projectId,
      workstreamId: proposal.workstreamId,
      title: proposal.title.trim(),
      statement: proposal.statement.trim(),
      state: "proposed",
      sources: [userSource],
      supersedesId: proposal.supersedesId || undefined,
      createdAt: new Date().toISOString(),
    };
    if (await workflow.mutate({ kind: "decision.propose", decision })) setProposal(null);
  }
  return (
    <section className="workflow-context-artifacts" aria-label={t("workflowContext.title")}>
      <div className="workflow-record-heading">
        <h3>{t("workflowContext.resources")}</h3>
        <Button
          variant="secondary"
          disabled={workflow.busy}
          onClick={() => setResource(newResource(workstreamId))}
        >
          {t("workflowContext.addResource")}
        </Button>
      </div>
      {resources.length === 0 ? (
        <p className="workflow-record-muted">{t("workflowContext.noResources")}</p>
      ) : (
        resources.map((item) => (
          <WorkflowRecord
            key={item.id}
            className="workflow-record"
            data-workflow-resource={item.id}
          >
            <div className="workflow-record-heading">
              <strong>{item.label}</strong>
              <Badge>{t(`workflowContext.resourceStates.${item.state}`)}</Badge>
            </div>
            <p className="workflow-record-muted">
              {t(`workflowContext.resourceKinds.${item.kind}`)} · {scopeLabel(item.workstreamId)}
            </p>
            <WorkflowReference
              reference={{ kind: "resource", id: item.id }}
              uri={item.uri}
              onOpenReference={onOpenReference}
            />
            <dl className="workflow-record-metadata">
              <dt>{t("workflowContext.revision")}</dt>
              <dd>{item.revision || t("workflowContext.unspecified")}</dd>
              <dt>{t("workflowContext.updatedAt")}</dt>
              <dd><time dateTime={item.updatedAt} title={item.updatedAt}>{formatWorkflowTime(item.updatedAt, i18n.language)}</time></dd>
              <dt>{t("workflowContext.source")}</dt>
              <dd>{sourceLabel(item.source)}</dd>
            </dl>
            {item.state === "effective" ? (
              <div className="workflow-record-actions">
                <Button variant="ghost" disabled={workflow.busy} onClick={() => editResource(item)}>
                  {t("workflowContext.editReference")}
                </Button>
                <Button
                  variant="ghost"
                  disabled={workflow.busy}
                  onClick={() =>
                    void workflow.mutate({
                      kind: "resource.put",
                      resource: {
                        ...item,
                        state: "superseded",
                        updatedAt: new Date().toISOString(),
                      },
                    })
                  }
                >
                  {t("workflowContext.supersedeReference")}
                </Button>
              </div>
            ) : null}
          </WorkflowRecord>
        ))
      )}
      {resource ? (
        <WorkflowRecord className="workflow-record" data-workflow-resource-editor="">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveResource();
            }}
          >
            <h4>
              {t(resource.id ? "workflowContext.editReference" : "workflowContext.addResource")}
            </h4>
            {resourceConflict ? (
              <div role="alert">
                <p>{t("workflowContext.resourceConflict")}</p>
                {currentResource ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => editResource(currentResource)}
                  >
                    {t("workflowContext.reloadReference")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            <Field label={t("workflowContext.label")}>
              <Input
                required
                value={resource.label}
                onChange={(event) => setResource({ ...resource, label: event.target.value })}
              />
            </Field>
            <Field label={t("workflowContext.uri")} hint={t("workflowContext.referenceHint")}>
              <Input
                required
                value={resource.uri}
                onChange={(event) => setResource({ ...resource, uri: event.target.value })}
              />
            </Field>
            <div className="workflow-record-grid">
              <Field label={t("workflowContext.kind")}>
                <Select
                  value={resource.kind}
                  onChange={(event) =>
                    setResource({
                      ...resource,
                      kind: event.target.value as WorkflowResource["kind"],
                    })
                  }
                >
                  {(["doc", "constraint", "skill", "source"] as const).map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`workflowContext.resourceKinds.${kind}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("workflowContext.scope")}>
                <Select
                  value={resource.workstreamId}
                  onChange={(event) =>
                    setResource({ ...resource, workstreamId: event.target.value })
                  }
                >
                  <option value="">{t("workflowContext.projectScope")}</option>
                  {workstreams.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label={t("workflowContext.revision")}>
              <Input
                value={resource.revision}
                onChange={(event) => setResource({ ...resource, revision: event.target.value })}
              />
            </Field>
            <div className="workflow-record-grid">
              <Field label={t("workflowContext.sourceKind")}>
                <Select
                  value={resource.sourceKind}
                  onChange={(event) =>
                    setResource({
                      ...resource,
                      sourceKind: event.target.value as WorkflowSource["kind"],
                    })
                  }
                >
                  {(["user", "session", "message", "file", "run"] as const).map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`workflowContext.sourceKinds.${kind}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("workflowContext.sourceRef")}>
                <Input
                  required
                  value={resource.sourceRef}
                  onChange={(event) => setResource({ ...resource, sourceRef: event.target.value })}
                />
              </Field>
            </div>
            <Field label={t("workflowContext.sourceRevision")}>
              <Input
                value={resource.sourceRevision}
                onChange={(event) =>
                  setResource({ ...resource, sourceRevision: event.target.value })
                }
              />
            </Field>
            <div className="workflow-record-actions">
              <Button
                type="submit"
                disabled={
                  workflow.busy ||
                  resourceConflict ||
                  !resource.label.trim() ||
                  !resource.uri.trim() ||
                  !resource.sourceRef.trim()
                }
              >
                {t("workflowContext.saveReference")}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setResource(null)}>
                {t("workflowContext.cancel")}
              </Button>
            </div>
          </form>
        </WorkflowRecord>
      ) : null}
      <div className="workflow-record-heading">
        <h3>{t("workflowContext.decisions")}</h3>
        <Button
          variant="secondary"
          disabled={workflow.busy || !workstreams.length}
          onClick={() =>
            setProposal({
              title: "",
              statement: "",
              workstreamId: workstreamId ?? workstreams[0]?.id ?? "",
              supersedesId: "",
            })
          }
        >
          {t("workflowContext.propose")}
        </Button>
      </div>
      {proposal ? (
        <WorkflowRecord className="workflow-record" data-workflow-decision-editor="">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveProposal();
            }}
          >
            <Field label={t("workflowContext.scope")}>
              <Select
                value={proposal.workstreamId}
                required
                onChange={(event) =>
                  setProposal({ ...proposal, workstreamId: event.target.value, supersedesId: "" })
                }
              >
                {workstreams.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("workflowContext.decisionTitle")}>
              <Input
                required
                value={proposal.title}
                onChange={(event) => setProposal({ ...proposal, title: event.target.value })}
              />
            </Field>
            <Field label={t("workflowContext.statement")}>
              <Textarea
                required
                value={proposal.statement}
                onChange={(event) => setProposal({ ...proposal, statement: event.target.value })}
              />
            </Field>
            <Field label={t("workflowContext.supersedes")}>
              <Select
                value={proposal.supersedesId}
                onChange={(event) => setProposal({ ...proposal, supersedesId: event.target.value })}
              >
                <option value="">{t("workflowContext.noSupersededDecision")}</option>
                {decisions
                  .filter(
                    (item) =>
                      item.workstreamId === proposal.workstreamId && item.state === "effective",
                  )
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
              </Select>
            </Field>
            <div className="workflow-record-actions">
              <Button
                type="submit"
                disabled={workflow.busy || !proposal.title.trim() || !proposal.statement.trim()}
              >
                {t("workflowContext.saveProposal")}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setProposal(null)}>
                {t("workflowContext.cancel")}
              </Button>
            </div>
          </form>
        </WorkflowRecord>
      ) : null}
      {decisions.length === 0 ? (
        <p className="workflow-record-muted">{t("workflowContext.noDecisions")}</p>
      ) : (
        decisions.map((item) => (
          <WorkflowRecord
            key={item.id}
            className="workflow-record"
            data-workflow-decision={item.id}
          >
            <div className="workflow-record-heading">
              <strong>{item.title}</strong>
              <Badge>{t(`workflowContext.decisionStates.${item.state}`)}</Badge>
            </div>
            <p className="workflow-record-prose">{item.statement}</p>
            <p className="workflow-record-muted">{scopeLabel(item.workstreamId)}</p>
            <dl className="workflow-record-metadata">
              <dt>{t("workflowContext.source")}</dt>
              <dd>{item.sources.map(sourceLabel).join("; ")}</dd>
              <dt>{t("workflowContext.createdAt")}</dt>
              <dd><time dateTime={item.createdAt} title={item.createdAt}>{formatWorkflowTime(item.createdAt, i18n.language)}</time></dd>
              {item.adoptedRevision !== undefined ? (
                <>
                  <dt>{t("workflowContext.adoptedRevision")}</dt>
                  <dd>{item.adoptedRevision}</dd>
                </>
              ) : null}
              {item.supersedesId ? (
                <>
                  <dt>{t("workflowContext.supersedes")}</dt>
                  <dd>
                    {snapshot.decisions.find((entry) => entry.id === item.supersedesId)?.title ??
                      item.supersedesId}
                  </dd>
                </>
              ) : null}
              {item.adoptedBy ? (
                <>
                  <dt>{t("workflowContext.adoptedBy")}</dt>
                  <dd>{sourceLabel(item.adoptedBy)}</dd>
                </>
              ) : null}
            </dl>
            {item.state === "proposed" || item.state === "alternative" ? (
              <div className="workflow-record-actions">
                <Button
                  disabled={workflow.busy}
                  onClick={() =>
                    void workflow.action({
                      kind: "adopt",
                      projectId,
                      workstreamId: item.workstreamId,
                      decisionId: item.id,
                      source: userSource,
                    })
                  }
                >
                  {t("workflowContext.adopt")}
                </Button>
                {item.state === "proposed" ? (
                  <Button
                    variant="secondary"
                    disabled={workflow.busy}
                    onClick={() =>
                      void workflow.mutate({
                        kind: "decision.resolve",
                        projectId,
                        workstreamId: item.workstreamId,
                        decisionId: item.id,
                        resolution: "alternative",
                        source: userSource,
                      })
                    }
                  >
                    {t("workflowContext.retainAlternative")}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  disabled={workflow.busy}
                  onClick={() =>
                    void workflow.mutate({
                      kind: "decision.resolve",
                      projectId,
                      workstreamId: item.workstreamId,
                      decisionId: item.id,
                      resolution: "dismiss",
                      source: userSource,
                    })
                  }
                >
                  {t("workflowContext.dismiss")}
                </Button>
              </div>
            ) : null}
          </WorkflowRecord>
        ))
      )}
    </section>
  );
}
