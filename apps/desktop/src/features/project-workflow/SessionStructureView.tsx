import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectWorkflowSnapshot } from "@pi-desktop/shared";
import { Badge, Button, Field, Select, TooltipButton } from "../../components/ui";
import { IconChat, IconChevronDown, IconChevronRight } from "../../components/icons";
import { sessionArchived } from "../../lib/sidebar-session-groups";
import { useAppStore } from "../../stores/app-store";
import {
  projectSessionStructure,
  sessionTreeRoots,
  sessionTreeSelection,
  type StructureSession,
} from "./session-structure-model";

type Props = {
  projectId: string;
  snapshot: ProjectWorkflowSnapshot;
  projectPaths: string[];
  onOpenSession: (id: string) => Promise<void>;
  onOpenWorkstream: (id: string) => void;
};
export function SessionStructureView({
  projectId,
  snapshot,
  projectPaths,
  onOpenSession,
  onOpenWorkstream,
}: Props) {
  const { t } = useTranslation();
  const sessions = useAppStore((state) => state.sessions);
  const meta = useAppStore((state) => state.sessionMeta);
  const running = useAppStore((state) => state.runningSessions);
  const activeId = useAppStore((state) => state.activeSessionId);
  const [selectedId, setSelectedId] = useState(activeId ?? "");
  const [workstreamId, setWorkstreamId] = useState("");
  const [filter, setFilter] = useState("all");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const model = projectSessionStructure(snapshot, sessions, projectId, projectPaths);
  const archived = (node: StructureSession) =>
    !!node.link?.archived || !!(node.session && sessionArchived(node.session, meta[node.id]));
  const visible = sessionTreeSelection(
    model.nodes,
    workstreamId,
    (node) => filter === "all" || (filter === "archived" ? archived(node) : !archived(node)),
  );
  const linked = visible.filter((node) => !node.unlinked);
  const history = visible.filter((node) => node.unlinked);
  const selected = visible.find((node) => node.id === selectedId) ?? linked[0] ?? history[0];
  const title = (node: StructureSession) =>
    node.agent
      ? t("workflow.agentTitle")
      : node.session?.title || t("projectStructure.unavailableSession");
  const role = (node: StructureSession) =>
    node.agent
      ? t("workflow.discussion")
      : node.link
        ? t(`projectStructure.relation.${node.link.relation}`)
        : node.mainFor.length
          ? t("projectStructure.relation.main")
          : node.source
            ? t("projectStructure.sourceSession")
            : node.runs.length
              ? t("projectStructure.executionSession")
              : t("projectStructure.unlinked");
  const unknown = (node: StructureSession) =>
    node.runs.some(
      (run) => run.state === "unknown" || run.effects.some((effect) => effect.state === "unknown"),
    );
  function badges(node: StructureSession) {
    return (
      <>
        {running[node.id] ? <Badge>{t("projectStructure.running")}</Badge> : null}
        {unknown(node) ? <Badge>{t("workflowArtifacts.runStates.unknown")}</Badge> : null}
        {archived(node) ? <Badge>{t("projectStructure.archived")}</Badge> : null}
      </>
    );
  }
  function branch(node: StructureSession): ReactNode {
    const children = visible.filter((item) => item.parentId === node.id);
    const open = !collapsed.includes(node.id);
    return (
      <li key={node.id} data-project-session-node={node.id}>
        <div className="project-session-tree-row">
          {children.length ? (
            <TooltipButton
              className="project-session-disclosure"
              tooltip={t("projectStructure.toggleBranch")}
              ariaLabel={t("projectStructure.toggleBranch")}
              aria-expanded={open}
              onClick={() =>
                setCollapsed((ids) =>
                  open ? [...ids, node.id] : ids.filter((id) => id !== node.id),
                )
              }
            >
              <IconChevronDown size={12} className={open ? "" : "workflow-navigation-folded"} />
            </TooltipButton>
          ) : (
            <span className="project-session-disclosure" />
          )}
          <Button
            variant="ghost"
            className="project-session-node"
            aria-pressed={selected?.id === node.id}
            onClick={() => setSelectedId(node.id)}
          >
            <span>
              <strong>{title(node)}</strong>
              <small>
                {role(node)}
                {node.link ? ` · ${t(`workflow.purposes.${node.link.purpose}`)}` : ""}
              </small>
            </span>
            <span className="project-session-badges">{badges(node)}</span>
          </Button>
        </div>
        {open && children.length ? (
          <ul className="project-session-children">{children.map(branch)}</ul>
        ) : null}
      </li>
    );
  }
  async function openSession(id: string) {
    setOpening(true);
    setError(null);
    try {
      await onOpenSession(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpening(false);
    }
  }
  return (
    <section className="project-session-structure" data-project-structure="sessions">
      <div className="project-structure-filters">
        <Field label={t("workflow.chooseWorkstream")}>
          <Select value={workstreamId} onChange={(event) => setWorkstreamId(event.target.value)}>
            <option value="">{t("workflow.allWorkstreams")}</option>
            {snapshot.workstreams
              .filter((item) => item.projectId === projectId)
              .map((work) => (
                <option key={work.id} value={work.id}>
                  {work.title}
                </option>
              ))}
          </Select>
        </Field>
        <Field label={t("projectStructure.visibility")}>
          <Select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">{t("projectStructure.allSessions")}</option>
            <option value="active">{t("projectStructure.notArchived")}</option>
            <option value="archived">{t("projectStructure.archived")}</option>
          </Select>
        </Field>
      </div>
      {model.nodes.length ? (
        <div className="project-session-layout">
          <nav className="project-session-tree" aria-label={t("projectStructure.sessions")}>
            {linked.length ? <ul>{sessionTreeRoots(linked).map(branch)}</ul> : null}
            {history.length ? (
              <>
                <h3>{t("projectStructure.unlinkedHistory")}</h3>
                <ul>{history.map(branch)}</ul>
              </>
            ) : null}
            {!visible.length ? (
              <p className="workflow-muted">{t("projectStructure.noMatchingSessions")}</p>
            ) : null}
          </nav>
          {selected ? (
            <section className="project-session-detail" data-project-session-detail={selected.id}>
              <div className="workflow-section-heading">
                <div>
                  <small>{role(selected)}</small>
                  <h2>{title(selected)}</h2>
                </div>
                <Button
                  disabled={opening || !selected.session}
                  onClick={() => void openSession(selected.id)}
                >
                  <IconChat size={14} />
                  {t("projectStructure.openSession")}
                </Button>
              </div>
              <div className="project-session-badges">
                {badges(selected)}
                {selected.link ? (
                  <Badge>{t(`workflow.purposes.${selected.link.purpose}`)}</Badge>
                ) : null}
              </div>
              {selected.session?.projectPath ? (
                <p className="workflow-muted project-structure-path">
                  {selected.session.projectPath}
                </p>
              ) : null}
              {!selected.session ? (
                <p className="workflow-muted">{t("projectStructure.transcriptUnavailable")}</p>
              ) : null}
              {selected.parentId ? (
                <div className="project-session-parent">
                  <span>{t("projectStructure.sourceSession")}</span>
                  <Button variant="ghost" onClick={() => setSelectedId(selected.parentId!)}>
                    {title(model.byId.get(selected.parentId)!)}
                    <IconChevronRight size={12} />
                  </Button>
                </div>
              ) : null}
              {selected.link ? (
                <dl className="project-session-context">
                  <dt>{t("projectStructure.returnPolicy")}</dt>
                  <dd>{t(`projectStructure.returnPolicies.${selected.link.returnPolicy}`)}</dd>
                  <dt>{t("workflow.visibility")}</dt>
                  <dd>
                    {t(
                      selected.link.visibility === "project"
                        ? "workflow.projectVisible"
                        : "workflow.sideOnly",
                    )}
                  </dd>
                  <dt>{t("workflow.selection")}</dt>
                  <dd>{selected.link.readContext.selection || t("workflowContext.unspecified")}</dd>
                  <dt>{t("workflowContext.resources")}</dt>
                  <dd>
                    {selected.link.readContext.resourceIds
                      .map((id) => snapshot.resources.find((item) => item.id === id)?.label ?? id)
                      .join(", ") || t("workflowContext.unspecified")}
                  </dd>
                  <dt>{t("workflow.includeDecisions")}</dt>
                  <dd>
                    {t(
                      selected.link.readContext.includeDecisions
                        ? "projectStructure.included"
                        : "projectStructure.excluded",
                    )}
                  </dd>
                  <dt>{t("workflow.includeArtifacts")}</dt>
                  <dd>
                    {t(
                      selected.link.readContext.includeArtifacts
                        ? "projectStructure.included"
                        : "projectStructure.excluded",
                    )}
                  </dd>
                </dl>
              ) : null}
              {selected.workstreams.length ? (
                <section>
                  <h3>{t("workflow.workstreams")}</h3>
                  {selected.workstreams.map((work) => (
                    <Button
                      key={work.id}
                      variant="ghost"
                      className="project-session-work-link"
                      onClick={() => onOpenWorkstream(work.id)}
                    >
                      {work.title}
                      <Badge>{t(`workflow.status.${work.status}`)}</Badge>
                      <IconChevronRight size={12} />
                    </Button>
                  ))}
                </section>
              ) : null}
              {selected.runs.length ? (
                <section className="project-session-runs">
                  <h3>{t("workflowArtifacts.runs")}</h3>
                  {selected.runs.map((run) => (
                    <div key={run.id} className="project-session-run">
                      <div>
                        <Badge>{t(`workflowArtifacts.runStates.${run.state}`)}</Badge>
                        <time>{run.updatedAt}</time>
                      </div>
                      <p>{run.outcome || t("workflowArtifacts.noOutcome")}</p>
                      <small>
                        {t("workflowArtifacts.executor")}: {run.executor}
                      </small>
                      {run.effects
                        .filter((effect) => effect.state === "unknown")
                        .map((effect) => (
                          <p key={effect.id}>
                            {effect.action} · {effect.resource}: {effect.detail}
                          </p>
                        ))}
                    </div>
                  ))}
                </section>
              ) : null}
              {error ? (
                <p role="alert" className="workflow-error">
                  {error}
                </p>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : (
        <div className="workflow-empty">
          <strong>{t("projectStructure.noSessions")}</strong>
        </div>
      )}
    </section>
  );
}
