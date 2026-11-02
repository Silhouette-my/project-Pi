import { useTranslation } from "react-i18next";
import type { ProjectWorkflowSnapshot } from "@pi-desktop/shared";
import { Badge, Button } from "../../components/ui";
import { IconChevronRight, IconFileText } from "../../components/icons";
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
  const attention = view.decisions.length + view.attentionWork.length;
  const summary = [
    t("projectStructure.openWork", { count: view.current.length }),
    view.executing ? t("projectStructure.executingRuns", { count: view.executing }) : null,
    attention ? t("projectStructure.awaitingCount", { count: attention }) : null,
    t("projectStructure.completedWork", { count: view.completed - view.agentFinished }),
    view.agentFinished ? t("workflow.agentFinishedCount", { count: view.agentFinished }) : null,
  ].filter(Boolean);
  return (
    <section className="workflow-overview project-overview" data-project-overview={projectId}>
      <h2 className="sr-only">{t("projectStructure.currentState")}</h2>
      <p className="project-overview-summary">{summary.join(" · ")}</p>
      {attention ? (
        <section className="project-overview-section" aria-label={t("projectStructure.needsAttention")}>
          <div className="project-section-label">
            <h2>{t("projectStructure.needsAttention")}</h2>
            <span className="project-section-count">{attention}</span>
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
            {view.attentionWork.map(({ work, reason }) => {
              // The second line is the way forward, never the badge text.
              const next = work.nextAction
                ? work.nextAction
                : work.blocker
                  ? t("workflow.resumeWhen", { condition: work.blocker.resumeWhen })
                  : "";
              return (
                <Button
                  key={work.id}
                  variant="ghost"
                  className="project-overview-card project-attention-item"
                  data-workflow-workstream={work.id}
                  onClick={() => onSelectWorkstream(work.id)}
                >
                  <span className="project-card-copy">
                    <span className="project-card-title">
                      <strong>{work.title}</strong>
                      {reason === "unknown" ? (
                        <Badge tone="warning">{t("workflowArtifacts.runStates.unknown")}</Badge>
                      ) : (
                        <Badge className="workflow-status-badge is-decision">
                          {t("projectStructure.pendingDecision")}
                        </Badge>
                      )}
                    </span>
                    {next ? <span>{next}</span> : null}
                  </span>
                  <IconChevronRight size={14} />
                </Button>
              );
            })}
          </div>
        </section>
      ) : null}
      <section className="project-overview-section project-overview-work">
        <div className="project-section-label">
          <h2>{t("workflow.stage")}</h2>
          <span className="project-section-count">{view.activeWork.length}</span>
          <Button variant="ghost" onClick={onCreateWorkstream}>
            {t("workflow.newWorkstream")}
          </Button>
        </div>
        {view.activeWork.length ? (
          <div className="project-overview-cards project-overview-work-list">
            {view.activeWork.map((work) => {
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
                      <WorkflowStatusBadge status={work.status} executionMode={work.executionMode} />
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
          <p className="project-empty-line">{t("workflow.noCurrentWork")}</p>
        )}
      </section>
      <section className="project-overview-section project-overview-artifacts">
          <div className="project-section-label">
            <h2>{t("workflow.recentArtifacts")}</h2>
            <span className="project-section-count">{view.recentArtifacts.length}</span>
            <Button variant="ghost" onClick={onOpenArtifacts}>
              {t("workflow.viewAll")}
            </Button>
          </div>
          {view.recentArtifacts.length ? (
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
          ) : (
            <p className="project-empty-line">{t("workflow.noArtifacts")}</p>
          )}
      </section>
    </section>
  );
}
