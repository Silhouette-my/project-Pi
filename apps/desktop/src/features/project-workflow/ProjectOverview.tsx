import { useTranslation } from "react-i18next";
import type { ProjectWorkflowSnapshot } from "@pi-desktop/shared";
import { Badge, Button } from "../../components/ui";
import { IconChevronRight, IconFileText, IconPlus } from "../../components/icons";
import { projectOverview } from "./project-overview-model";
import { WorkflowStatusBadge } from "./WorkflowStatusBadge";

type Props = {
  projectId: string;
  snapshot: ProjectWorkflowSnapshot;
  onSelectWorkstream: (id: string) => void;
  onCreateWorkstream: () => void;
  onOpenContext: (workstreamId?: string) => void;
  onOpenArtifacts: () => void;
  onOpenArtifact: (id: string) => Promise<void>;
  onError: (cause: unknown) => void;
};

/** Acceptance as discrete conditions, never a percentage (PRODUCT P2). */
function AcceptanceMeter({ done, total }: { done: number; total: number }) {
  if (!total) return null;
  return (
    <span className="project-acceptance-meter" aria-hidden="true">
      {total <= 8
        ? Array.from({ length: total }, (_, index) => (
            <i key={index} className={index < done ? "is-done" : undefined} />
          ))
        : null}
    </span>
  );
}

export function ProjectOverview({
  projectId,
  snapshot,
  onSelectWorkstream,
  onCreateWorkstream,
  onOpenContext,
  onOpenArtifacts,
  onOpenArtifact,
  onError,
}: Props) {
  const { t } = useTranslation();
  const view = projectOverview(snapshot, projectId);
  const attention = view.blockers.length + view.decisions.length + view.unknownRuns.length;
  const stats = [
    { key: "open", value: view.current.length, label: t("projectStructure.statOpen"), tone: "accent" },
    { key: "running", value: view.executing, label: t("projectStructure.statRunning"), tone: "" },
    { key: "attention", value: attention, label: t("projectStructure.statAttention"), tone: attention ? "decision" : "" },
    { key: "accepted", value: view.completed, label: t("projectStructure.statAccepted"), tone: "" },
  ];
  return (
    <section className="workflow-overview project-overview" data-project-overview={projectId}>
      <h2 className="sr-only">{t("projectStructure.currentState")}</h2>
      <dl className="project-overview-stats">
        {stats.map((stat) => (
          <div key={stat.key} className={`project-overview-stat${stat.tone ? ` is-${stat.tone}` : ""}`}>
            <dt>{stat.label}</dt>
            <dd>{stat.value}</dd>
          </div>
        ))}
      </dl>
      {attention ? (
        <section className="project-overview-section" aria-label={t("projectStructure.needsAttention")}>
          <div className="project-section-label">
            <h2>{t("projectStructure.needsAttention")}</h2>
            <span className="project-section-count">{attention}</span>
          </div>
          <div className="project-overview-cards">
            {view.blockers.map((work) => (
              <Button
                key={work.id}
                variant="ghost"
                className="project-overview-card project-attention-item is-blocked"
                onClick={() => onSelectWorkstream(work.id)}
              >
                <span className="project-card-copy">
                  <span className="project-card-title">
                    <strong>{work.title}</strong>
                    <WorkflowStatusBadge status={work.status} />
                  </span>
                  <span>{work.blocker?.reason ?? t(`workflow.status.${work.status}`)}</span>
                  {work.blocker ? (
                    <small>
                      {t("workflow.blockerOwner", { owner: work.blocker.owner })} ·{" "}
                      {t("workflow.resumeWhen", { condition: work.blocker.resumeWhen })}
                    </small>
                  ) : null}
                </span>
                <IconChevronRight size={14} />
              </Button>
            ))}
            {view.unknownRuns.map((run) => (
              <Button
                key={run.id}
                variant="ghost"
                className="project-overview-card project-attention-item is-unknown"
                onClick={() => onSelectWorkstream(run.workstreamId)}
              >
                <span className="project-card-copy">
                  <span className="project-card-title">
                    <strong>{run.outcome || t("workflowArtifacts.noOutcome")}</strong>
                    <Badge tone="warning">{t("workflowArtifacts.runStates.unknown")}</Badge>
                  </span>
                </span>
                <IconChevronRight size={14} />
              </Button>
            ))}
            {view.decisions.map((decision) => (
              <Button
                key={decision.id}
                variant="ghost"
                className="project-overview-card project-attention-item is-decision"
                onClick={() => onOpenContext(decision.workstreamId)}
              >
                <span className="project-card-copy">
                  <span className="project-card-title">
                    <strong>{decision.title}</strong>
                    <Badge className="workflow-status-badge is-decision">
                      {t("projectStructure.pendingDecision")}
                    </Badge>
                  </span>
                  <span>{decision.statement}</span>
                </span>
                <IconChevronRight size={14} />
              </Button>
            ))}
          </div>
        </section>
      ) : null}
      <section className="project-overview-section project-overview-work">
        <div className="project-section-label">
          <h2>{t("workflow.stage")}</h2>
          <span className="project-section-count">{view.current.length}</span>
          <Button variant="ghost" onClick={onCreateWorkstream}>
            <IconPlus size={14} />
            {t("workflow.newWorkstream")}
          </Button>
        </div>
        {view.current.length ? (
          <div className="project-overview-cards project-overview-work-list">
            {view.current.map((work) => {
              const done = work.acceptance.filter((item) => item.status === "satisfied").length;
              return (
                <Button
                  key={work.id}
                  variant="ghost"
                  className="project-overview-card workflow-workstream project-overview-work-item"
                  data-workflow-workstream={work.id}
                  onClick={() => onSelectWorkstream(work.id)}
                >
                  <span className="project-card-copy">
                    <span className="project-card-title">
                      <strong>{work.title}</strong>
                      <WorkflowStatusBadge status={work.status} />
                    </span>
                    {work.goal ? <span className="project-card-goal">{work.goal}</span> : null}
                    {work.nextAction ? (
                      <span className="project-overview-next">
                        <IconChevronRight size={12} />
                        <span>{work.nextAction}</span>
                      </span>
                    ) : null}
                  </span>
                  {work.acceptance.length ? (
                    <span className="project-card-meta">
                      <AcceptanceMeter done={done} total={work.acceptance.length} />
                      <small>
                        {t("projectStructure.acceptanceCount", {
                          done,
                          total: work.acceptance.length,
                        })}
                      </small>
                    </span>
                  ) : null}
                  <IconChevronRight size={14} />
                </Button>
              );
            })}
          </div>
        ) : (
          <div className="workflow-empty">
            <strong>{t("workflow.noCurrentWork")}</strong>
            <p>{t("workflow.startWithAgent")}</p>
          </div>
        )}
      </section>
      {view.recentArtifacts.length ? (
        <section className="project-overview-section project-overview-artifacts">
          <div className="project-section-label">
            <h2>{t("workflow.recentArtifacts")}</h2>
            <span className="project-section-count">{view.recentArtifacts.length}</span>
            <Button variant="ghost" onClick={onOpenArtifacts}>
              {t("workflow.viewAll")}
              <IconChevronRight size={14} />
            </Button>
          </div>
          <div className="project-overview-cards">
            {view.recentArtifacts.map((item) => (
              <div className="workflow-artifact-row project-overview-output" key={item.id}>
                <IconFileText size={15} />
                <div>
                  <strong>{item.label}</strong>
                  <p>
                    {item.revision} · {item.environment}
                  </p>
                </div>
                <Button onClick={() => void onOpenArtifact(item.id).catch(onError)}>
                  {t("workflow.openArtifact")}
                </Button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </section>
  );
}
