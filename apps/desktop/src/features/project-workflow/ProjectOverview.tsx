import { useTranslation } from "react-i18next";
import type { ProjectWorkflowSnapshot } from "@pi-desktop/shared";
import { Badge, Button, Textarea, TooltipButton } from "../../components/ui";
import {
  IconArrowUp,
  IconChat,
  IconChevronRight,
  IconFileText,
  IconPlus,
} from "../../components/icons";
import { projectOverview } from "./project-overview-model";
import { useProjectAgent } from "./useProjectAgent";
import { useProjectAgentDraft } from "./project-agent-draft";

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
  const view = projectOverview(snapshot, projectId);
  const agent = useProjectAgent(projectId);
  const [intent, setIntent] = useProjectAgentDraft(projectId);
  async function discuss() {
    if (!intent.trim() || agent.busy) return;
    try {
      await agent.open(intent.trim());
      setIntent("");
    } catch (cause) {
      onError(cause);
    }
  }
  const attention = view.blockers.length + view.decisions.length + view.unknownRuns.length;
  return (
    <section
      className="workflow-overview workflow-overview-current"
      data-project-overview={projectId}
    >
      <div className="project-overview-heading">
        <h2>{t("projectStructure.currentState")}</h2>
        <div className="project-overview-counts">
          <span>{t("projectStructure.openWork", { count: view.current.length })}</span>
          {view.executing ? (
            <span>{t("projectStructure.executingRuns", { count: view.executing })}</span>
          ) : null}
          {view.completed ? (
            <span>{t("projectStructure.completedWork", { count: view.completed })}</span>
          ) : null}
        </div>
      </div>
      <form
        className="project-agent-action"
        data-workflow="project-intent"
        onSubmit={(event) => {
          event.preventDefault();
          void discuss();
        }}
      >
        <IconChat size={18} />
        <Textarea
          aria-label={t("workflow.intentText")}
          placeholder={t("workflow.agentPlaceholder")}
          rows={1}
          value={intent}
          disabled={agent.busy}
          onChange={(event) => setIntent(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              (event.metaKey || event.ctrlKey)
            ) {
              event.preventDefault();
              void discuss();
            }
          }}
        />
        <TooltipButton
          type="submit"
          className="send-btn"
          tooltip={t("workflow.sendAgent")}
          ariaLabel={t("workflow.sendAgent")}
          disabled={agent.busy || !intent.trim()}
        >
          <IconArrowUp size={16} />
        </TooltipButton>
      </form>
      {agent.error ? (
        <p role="alert" className="workflow-error">
          {agent.error}
        </p>
      ) : null}
      <div className={`project-overview-grid${attention ? " has-attention" : ""}`}>
        <section className="project-overview-work">
          <div className="workflow-section-heading">
            <h2>{t("workflow.stage")}</h2>
            <Button variant="ghost" onClick={onCreateWorkstream}>
              <IconPlus size={14} />
              {t("workflow.newWorkstream")}
            </Button>
          </div>
          {view.current.length ? (
            <div className="project-overview-work-list">
              {view.current.map((work) => (
                <Button
                  key={work.id}
                  variant="ghost"
                  className="workflow-workstream project-overview-work-item"
                  data-workflow-workstream={work.id}
                  onClick={() => onSelectWorkstream(work.id)}
                >
                  <span className="project-overview-work-title">
                    <strong>{work.title}</strong>
                    <Badge>{t(`workflow.status.${work.status}`)}</Badge>
                  </span>
                  {work.goal ? <span>{work.goal}</span> : null}
                  {work.acceptance.length ? (
                    <small>
                      {t("projectStructure.acceptanceCount", {
                        done: work.acceptance.filter((item) => item.status === "satisfied").length,
                        total: work.acceptance.length,
                      })}
                    </small>
                  ) : null}
                  {work.nextAction ? (
                    <span className="project-overview-next">
                      <IconChevronRight size={13} />
                      <span>{work.nextAction}</span>
                    </span>
                  ) : null}
                </Button>
              ))}
            </div>
          ) : (
            <div className="workflow-empty">
              <strong>{t("workflow.noCurrentWork")}</strong>
              <p>{t("workflow.startWithAgent")}</p>
            </div>
          )}
        </section>
        {attention ? (
          <aside
            className="project-overview-attention"
            aria-label={t("projectStructure.needsAttention")}
          >
            <h2>{t("projectStructure.needsAttention")}</h2>
            {view.blockers.map((work) => (
              <Button
                key={work.id}
                variant="ghost"
                className="project-attention-item"
                onClick={() => onSelectWorkstream(work.id)}
              >
                <strong>{work.title}</strong>
                <span>{work.blocker?.reason ?? t(`workflow.status.${work.status}`)}</span>
                {work.blocker ? (
                  <small>
                    {t("workflow.blockerOwner", { owner: work.blocker.owner })}
                    <br />
                    {t("workflow.resumeWhen", { condition: work.blocker.resumeWhen })}
                  </small>
                ) : null}
              </Button>
            ))}
            {view.unknownRuns.map((run) => (
              <Button
                key={run.id}
                variant="ghost"
                className="project-attention-item"
                onClick={() => onSelectWorkstream(run.workstreamId)}
              >
                <Badge>{t("workflowArtifacts.runStates.unknown")}</Badge>
                <span>{run.outcome || t("workflowArtifacts.noOutcome")}</span>
              </Button>
            ))}
            {view.decisions.map((decision) => (
              <Button
                key={decision.id}
                variant="ghost"
                className="project-attention-item"
                onClick={() => onOpenContext(decision.workstreamId)}
              >
                <small>{t("projectStructure.pendingDecision")}</small>
                <strong>{decision.title}</strong>
                <span>{decision.statement}</span>
              </Button>
            ))}
          </aside>
        ) : null}
      </div>
      {view.recentArtifacts.length ? (
        <section className="project-overview-artifacts">
          <div className="workflow-section-heading">
            <h2>{t("workflow.recentArtifacts")}</h2>
            <Button variant="ghost" onClick={onOpenArtifacts}>
              {t("workflow.viewAll")}
              <IconChevronRight size={14} />
            </Button>
          </div>
          {view.recentArtifacts.map((item) => (
            <div className="workflow-artifact-row" key={item.id}>
              <IconFileText size={17} />
              <div>
                <strong>{item.label}</strong>
                <p>
                  {item.revision} · {item.environment}
                </p>
              </div>
              <Button variant="ghost" onClick={() => void onOpenArtifact(item.id).catch(onError)}>
                {t("workflow.openArtifact")}
              </Button>
            </div>
          ))}
        </section>
      ) : null}
    </section>
  );
}
