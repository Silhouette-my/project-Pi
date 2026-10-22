import { useTranslation } from "react-i18next";
import type { ProjectWorkflowSnapshot } from "@pi-desktop/shared";
import { Badge, Button } from "../../components/ui";
import { IconChevronRight, IconFileText, IconPlus } from "../../components/icons";
import { useAppStore } from "../../stores/app-store";
import { projectOverview } from "./project-overview-model";
import { WorkflowStatusBadge } from "./WorkflowStatusBadge";
import { workflowOwnerLabel } from "./workflow-display";

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
  const sessions = useAppStore((state) => state.sessions);
  const view = projectOverview(snapshot, projectId);
  // Workstream blockers stay on their own row in Current work; only items that
  // are not a workstream row need a separate list, so nothing appears twice.
  const decisions = view.decisions.length + view.unknownRuns.length;
  const awaiting = view.blockers.length + view.decisions.length + view.unknownRuns.length;
  const summary = [
    t("projectStructure.openWork", { count: view.current.length }),
    view.executing ? t("projectStructure.executingRuns", { count: view.executing }) : null,
    awaiting ? t("projectStructure.awaitingCount", { count: awaiting }) : null,
    t("projectStructure.completedWork", { count: view.completed }),
  ].filter(Boolean);
  return (
    <section className="workflow-overview project-overview" data-project-overview={projectId}>
      <h2 className="sr-only">{t("projectStructure.currentState")}</h2>
      <p className="project-overview-summary">{summary.join(" · ")}</p>
      {decisions ? (
        <section className="project-overview-section" aria-label={t("projectStructure.needsAttention")}>
          <div className="project-section-label">
            <h2>{t("projectStructure.needsAttention")}</h2>
            <span className="project-section-count">{decisions}</span>
          </div>
          <div className="project-overview-cards">
            {view.decisions.map((decision) => (
              <Button
                key={decision.id}
                variant="ghost"
                className="project-overview-card project-attention-item"
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
            {view.unknownRuns.map((run) => (
              <Button
                key={run.id}
                variant="ghost"
                className="project-overview-card project-attention-item"
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
              const candidate = snapshot.artifacts.find((item) => item.id === work.currentCandidateId);
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
                    <span className="project-card-meta-line">
                      {t("projectStructure.ownedBy", {
                        owner: workflowOwnerLabel(work.owner, sessions, t),
                      })}
                      {work.nextAction ? ` · ${t("projectStructure.nextShort", { action: work.nextAction })}` : ""}
                    </span>
                    {work.blocker ? (
                      <span className="project-card-blocker">
                        {work.blocker.reason} · {t("workflow.resumeWhen", { condition: work.blocker.resumeWhen })}
                      </span>
                    ) : null}
                    {candidate ? (
                      <span className="project-card-meta-line">
                        {t("projectStructure.candidateShort", { label: candidate.label })}{" "}
                        <span className="workflow-mono">{candidate.revision}</span>
                      </span>
                    ) : null}
                  </span>
                  {work.acceptance.length ? (
                    <span className="project-card-acceptance">
                      {t("projectStructure.acceptanceShort", { done, total: work.acceptance.length })}
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
                    <span className="workflow-mono">{item.revision}</span> · {item.environment}
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
