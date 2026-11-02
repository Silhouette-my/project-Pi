import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectGroupRecord, ProjectWorkflowSearchHit } from "@pi-desktop/shared";
import { Button, Select, TooltipButton } from "../../components/ui";
import { IconChat, IconChevronRight, IconCube, IconMore, IconPanelOpen, IconSearch } from "../../components/icons";
import { ProjectInstructionsDialog } from "../../components/ProjectInstructionsDialog";
import { ProjectMemoryDialog } from "../../components/ProjectMemoryDialog";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { useProjectWorkflow } from "./useProjectWorkflow";
import { WorkstreamEditor } from "./WorkstreamEditor";
import { WorkflowControls } from "./WorkflowControls";
import { WorkflowAcceptance } from "./WorkflowAcceptance";
import { WorkflowSearch } from "./WorkflowSearch";
import { WorkflowArtifacts } from "./WorkflowArtifacts";
import { WorkstreamEditorDialog } from "./WorkstreamEditorDialog";
import { ProjectOverview } from "./ProjectOverview";
import { ProjectStructureView } from "./ProjectStructureView";
import {
  openProjectAgentPanel,
  openProjectSidePanel,
  subscribeProjectContextView,
  takeProjectContextView,
} from "../project-panel/project-panel-actions";
import { WorkflowContext } from "./WorkflowContext";
import { WorkflowStatusBadge } from "./WorkflowStatusBadge";
import { workflowOwnerLabel } from "./workflow-display";
import "./workflow.css";
import "./project-console-styles.css";
import "./project-structure-styles.css";
import "./project-home-styles.css";
import "./project-settings-look.css";

/** Page width from which the workstream list and detail sit side by side. */
const SPLIT_WORK_MIN_WIDTH = 720;

export function ProjectConsole({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { snapshot, loading, error, refresh, busy } = useProjectWorkflow();
  const sessions = useAppStore((state) => state.sessions);
  const [group, setGroup] = useState<ProjectGroupRecord | null>(null);
  const [groupLoaded, setGroupLoaded] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [tab, setTab] = useState<"overview" | "work" | "context" | "structure">("overview");
  const root = useRef<HTMLDivElement>(null);
  const memorySourceNavigation = useRef(0);
  const [consoleWidth, setConsoleWidth] = useState(SPLIT_WORK_MIN_WIDTH);
  // The project Agent and side conversations live in the right work panel
  // (the project's own context); the console only asks for them to be shown.
  const openSide = (sessionId: string) => {
    const title = useAppStore.getState().sessions.find((item) => item.id === sessionId)?.title?.trim();
    openProjectSidePanel(projectId, sessionId, title || undefined);
  };

  const openMemorySource = async (sessionId: string, messageId: string) => {
    const request = ++memorySourceNavigation.current;
    try {
      const current = useAppStore.getState();
      if (current.activeSessionId === sessionId && !current.selectingSessionId)
        current.setPage("chat");
      else
        await current.selectSession(sessionId);
      let selected = useAppStore.getState();
      if (request !== memorySourceNavigation.current || selected.activeSessionId !== sessionId) return;
      if (selected.sessionMeta[sessionId]?.archived === true) {
        selected.restoreSession(sessionId);
        selected = useAppStore.getState();
      }
      if (request !== memorySourceNavigation.current || selected.page !== "chat") return;
      await selected.navigateTranscript({ sessionId, messageId, query: "" });
      if (request === memorySourceNavigation.current) setContextEditor(null);
    } catch (cause) {
      if (request === memorySourceNavigation.current)
        setLocalError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const [editing, setEditing] = useState<"new" | "edit" | null>(null);
  const [contextEditor, setContextEditor] = useState<"instructions" | "memory" | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTarget, setSearchTarget] = useState<ProjectWorkflowSearchHit | null>(null);
  const mounted = useRef(true);
  // Measure before first paint so the split/stacked layout is never decided
  // from the placeholder width.
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    setConsoleWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setConsoleWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const consoleNavigation = useRef(0);
  const renderNavigation = consoleNavigation.current;
  const selectWorkstream = (id: string, showDetail = true) => {
    consoleNavigation.current += 1;
    setSelectedId(id);
    if (showDetail) setTab("work");
    setSearchTarget(null);
  };
  const selectTab = (next: typeof tab) => {
    consoleNavigation.current += 1;
    setTab(next);
    setSearchTarget(null);
  };
  // An Explore side conversation in the work panel asks for the Shared
  // context tab ("review proposals"); the console owns its tab state.
  useEffect(() => {
    const consume = () => {
      const request = takeProjectContextView(projectId);
      if (!request) return;
      selectWorkstream(request.workstreamId ?? "", false);
      selectTab("context");
    };
    consume();
    return subscribeProjectContextView(consume);
    // The handlers only touch state setters and a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void api
      .listProjectGroups()
      .then(({ groups }) => {
        if (!cancelled) setGroup(groups.find((item) => item.id === projectId) ?? null);
      })
      .catch((cause) => {
        if (!cancelled) setLocalError(String(cause));
      })
      .finally(() => {
        if (!cancelled) setGroupLoaded(true);
      });
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [projectId]);
  const workstreams =
    snapshot?.workstreams
      .filter((item) => item.projectId === projectId)
      .sort((left, right) => left.order - right.order) ?? [];
  const selected = workstreams.find((item) => item.id === selectedId);
  const splitWork = consoleWidth >= SPLIT_WORK_MIN_WIDTH;
  // A split view shows list and detail together, so it never shows an empty
  // detail; a stacked one shows the list until a workstream is chosen.
  const shown = selected ?? (splitWork ? workstreams[0] : undefined);
  const candidate = snapshot?.artifacts.find((item) => item.id === shown?.currentCandidateId);
  const hasTaskRecords = shown && snapshot &&
    [snapshot.artifacts, snapshot.deliveries, snapshot.runs].some((items) =>
      items.some((item) => item.projectId === projectId && item.workstreamId === shown.id));
  useEffect(() => {
    if (!searchTarget) return;
    const attribute =
      searchTarget.kind === "artifact"
        ? "data-workflow-artifact"
        : searchTarget.kind === "decision"
          ? "data-workflow-decision"
          : "data-workflow-workstream";
    const targetId = searchTarget.artifactId ?? searchTarget.id;
    const frame = requestAnimationFrame(() => {
      const target = [...document.querySelectorAll<HTMLElement>(`[${attribute}]`)].find(
        (item) => item.getAttribute(attribute) === targetId,
      );
      if (target) {
        for (let parent = target.parentElement; parent; parent = parent.parentElement) {
          if (parent instanceof HTMLDetailsElement) parent.open = true;
        }
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "center" });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [searchTarget, tab]);
  const fail = (cause: unknown) => {
    if (mounted.current) setLocalError(cause instanceof Error ? cause.message : String(cause));
  };
  const openSession = async (id: string) => {
    try {
      await useAppStore.getState().refreshSessions();
      const state = useAppStore.getState();
      if (
        !mounted.current ||
        renderNavigation !== consoleNavigation.current ||
        state.page !== "project" ||
        state.projectConsoleId !== projectId
      )
        return;
      await state.selectSession(id);
    } catch (cause) {
      fail(cause);
    }
  };
  const openReference = async (reference: { kind: "artifact" | "resource"; id: string }) => {
    await api.projectWorkflow.openReference({ projectId, ...reference });
  };
  const createWorkstream = () => {
    consoleNavigation.current += 1;
    setEditing("new");
  };
  const workstreamRows = (items: typeof workstreams) => (
    <div className="workflow-workstream-list">
      {items.map((item) => {
        const done = item.acceptance.filter((entry) => entry.status === "satisfied").length;
        return (
          <Button key={item.id} variant="ghost"
            className={shown?.id === item.id ? "workflow-workstream is-selected" : "workflow-workstream"}
            data-workflow-workstream={item.id} aria-pressed={shown?.id === item.id}
            onClick={() => { selectWorkstream(item.id); setEditing(null); }}>
            <span className={`workflow-status-dot is-${item.status}`} aria-hidden="true" />
            <span className="workflow-row-copy"><strong>{item.title}</strong></span>
            {item.acceptance.length ? <small className="workflow-row-count">{done}/{item.acceptance.length}</small> : null}
          </Button>
        );
      })}
    </div>
  );
  const project = group ? { name: group.name, path: group.primaryPath, groupId: group.id } : null;
  return (
    <div className="workflow-console" ref={root} data-workflow="console" data-project-id={projectId}>
      <div className="workflow-page">
        <header className="workflow-header">
          <div className="workflow-project-identity">
            <div className="workflow-project-mark"><IconCube size={18} /></div>
            {/* The path is the title's tooltip, like the sidebar project row (08 §3.9). */}
            <h1 title={group?.primaryPath}>{group?.name ?? projectId}</h1>
          </div>
          <div className="workflow-header-tools">
            <div className="workflow-header-actions">
              <TooltipButton className="ct-icon-btn" tooltip={t("workflow.search")} ariaLabel={t("workflow.search")}
                aria-expanded={searchOpen} onClick={() => setSearchOpen(!searchOpen)}><IconSearch size={16} /></TooltipButton>
              <details className="workflow-project-menu">
                <summary className="ct-icon-btn" aria-label={t("workflow.projectMenu")}><IconMore size={16} /></summary>
                <div className="workflow-project-menu-content">
                  <Button variant="ghost" disabled={!group} onClick={(event) => { setContextEditor("instructions"); event.currentTarget.closest("details")?.removeAttribute("open"); }}>{t("workflow.instructions")}</Button>
                  <Button variant="ghost" disabled={!group} onClick={(event) => { setContextEditor("memory"); event.currentTarget.closest("details")?.removeAttribute("open"); }}>{t("workflow.memory")}</Button>
                  <Button variant="ghost" disabled={loading || busy} onClick={(event) => { void refresh(); event.currentTarget.closest("details")?.removeAttribute("open"); }}>{t("workflow.retry")}</Button>
                </div>
              </details>
            </div>
            <TooltipButton className="ct-icon-btn workflow-agent-dock-toggle"
              tooltip={t("workflow.agentDockOpen")} ariaLabel={t("workflow.agentDockOpen")}
              data-project-agent-dock-toggle={projectId} disabled={!snapshot}
              onClick={() => openProjectAgentPanel(projectId)}><IconPanelOpen size={16} /></TooltipButton>
          </div>
        </header>
        {(error || localError) && (
          <p className="workflow-error" role="alert">
            {error ?? localError}
          </p>
        )}
        {loading ? (
          <p role="status">{t("workflow.loading")}</p>
        ) : !snapshot ? (
          <p role="status">{t("workflow.unavailable")}</p>
        ) : (
          <>
            <div className="workflow-project-search" hidden={!searchOpen}><WorkflowSearch
              key={projectId}
              projectId={projectId}
              onResult={(hit) => {
                if (hit.kind === "decision") {
                  selectWorkstream(hit.workstreamId ?? "", false);
                  selectTab("context");
                } else {
                  selectWorkstream(hit.workstreamId ?? "");
                }
                setSearchTarget(hit);
              }}
            /></div>
            <nav className="workflow-tabs" aria-label={t("workflow.console")}>
              <Button variant="ghost" aria-current={tab === "overview" ? "page" : undefined} onClick={() => selectTab("overview")}>{t("workflow.overview")}</Button>
              <Button variant="ghost" aria-current={tab === "structure" ? "page" : undefined} onClick={() => selectTab("structure")}>{t("projectStructure.structure")}</Button>
              <Button variant="ghost" aria-current={tab === "context" ? "page" : undefined} onClick={() => selectTab("context")}>{t("workflow.context")}</Button>
              <Button variant="ghost" aria-current={tab === "work" ? "page" : undefined} onClick={() => selectTab("work")}>
                {t("workflow.workstreams")}
              </Button>
            </nav>
            <div className="workflow-content">
            {tab === "overview" ? (
              <ProjectOverview projectId={projectId} snapshot={snapshot}
                onSelectWorkstream={selectWorkstream} onCreateWorkstream={createWorkstream}
                onOpenContext={(id) => { selectWorkstream(id ?? "", false); selectTab("context"); }}
                onOpenArtifacts={() => selectTab("work")}
                onOpenArtifact={(id) => openReference({ kind: "artifact", id })} onError={fail} />
            ) : tab === "context" ? (
              <section className="workflow-context-page" data-workflow-context-page={projectId}>
                <div className="project-structure-filters">
                  <Select aria-label={t("workflow.chooseWorkstream")} value={selectedId} onChange={(event) => selectWorkstream(event.target.value, false)}>
                    <option value="">{t("workflow.allWorkstreams")}</option>
                    {workstreams.map((item) => (
                      <option key={item.id} value={item.id}>{item.title}</option>
                    ))}
                  </Select>
                </div>
                <WorkflowContext projectId={projectId} workstreamId={selectedId || undefined} onOpenReference={openReference} />
              </section>
            ) : tab === "structure" ? (
              <ProjectStructureView key={projectId} projectId={projectId} snapshot={snapshot}
                projectPaths={group?.roots.map(root => root.path) ?? []}
                onOpenSession={openSession} onOpenWorkstream={selectWorkstream} />
            ) : (
              <div className={`workflow-work ${splitWork ? "is-split" : "is-stacked"}${shown ? " has-detail" : ""}`}>
                <nav className="workflow-work-list" aria-label={t("workflow.workstreams")}>
                  <div className="project-section-label">
                    <h2>{t("workflow.workstreams")}</h2>
                    <span className="project-section-count">{workstreams.length}</span>
                    <Button variant="ghost" onClick={createWorkstream}>{t("workflow.newWorkstream")}</Button>
                  </div>
                  {workstreams.length ? workstreamRows(workstreams) : (
                    <p className="project-empty-line">{t("workflow.noWorkstreams")}</p>
                  )}
                </nav>
                {shown ? (
                  <div className="workflow-work-detail">
                    <Button variant="ghost" className="workflow-back" onClick={() => selectWorkstream("")}>{t("workflow.allWorkstreams")}</Button>
                    <section className="workflow-detail" data-workstream-id={shown.id} data-workflow-workstream={shown.id}>
                      <div className="workflow-detail-head">
                        <div>
                          <h2>{shown.title} <WorkflowStatusBadge status={shown.status} executionMode={shown.executionMode} /></h2>
                          {shown.executionMode !== "session" && <p className="workflow-muted">
                            {t("projectStructure.ownedBy", { owner: workflowOwnerLabel(shown.owner, sessions, t) })} · {t("workflow.revision", { revision: shown.revision })}
                          </p>}
                        </div>
                        <div className="workflow-detail-actions">
                          {shown.mainSessionId && (
                            <Button onClick={() => void openSession(shown.mainSessionId!)}>
                              {t("workflow.openMain")}
                            </Button>
                          )}
                          <Button variant="ghost" onClick={() => { consoleNavigation.current += 1; setSelectedId(shown.id); setEditing("edit"); }}>
                            {t("workflow.editWorkstream")}
                          </Button>
                        </div>
                      </div>
                      {shown.goal ? <p className="workflow-detail-goal">{shown.goal}</p> : null}
                      {shown.executionMode === "session" && shown.status === "completed" ? (
                        <p className="workflow-muted">{t("workflow.agentFinishedHint")}</p>
                      ) : null}
                      {shown.blocker && (
                        <div className="workflow-blocker">
                          <strong>{shown.blocker.reason}</strong>
                          <span>{t("workflow.blockerOwner", { owner: shown.blocker.owner })}</span>
                          <span>{t("workflow.resumeWhen", { condition: shown.blocker.resumeWhen })}</span>
                        </div>
                      )}
                      {!candidate ? (shown.executionMode !== "session" ? (
                        <div className="workflow-candidate-summary">
                          <span className="workflow-muted">{t("workflow.noCandidate")}</span>
                        </div>
                      ) : null) : (
                        <div className="workflow-candidate-summary">
                          <div>
                            <h3>{t("workflow.currentCandidate")}</h3>
                            <strong>{candidate.label}</strong>
                            <p className="workflow-muted"><span className="workflow-mono">{candidate.revision}</span> · {candidate.environment}</p>
                            <p className="workflow-path" title={candidate.entryPoint}>{candidate.entryPoint}</p>
                          </div>
                          <Button title={candidate.entryPoint} onClick={() => void openReference({ kind: "artifact", id: candidate.id }).catch(fail)}>
                            {t("workflow.openArtifact")}
                          </Button>
                        </div>
                      )}
                      <dl className="workflow-detail-facts">
                        {shown.nextAction ? (<><dt>{t("workflow.nextAction")}</dt><dd>{shown.nextAction}</dd></>) : null}
                        {shown.dependencyIds.length > 0 ? (<><dt>{t("workflow.dependencies")}</dt>
                          <dd>{shown.dependencyIds.map((id) => workstreams.find((item) => item.id === id)?.title ?? id).join(", ")}</dd></>) : null}
                      </dl>
                      <WorkflowAcceptance workstream={shown} />
                      <section className="workflow-detail-block" aria-label={t("workflow.controls")}>
                        <div className="project-section-label"><h3>{t("workflow.controls")}</h3></div>
                      <WorkflowControls
                        key={shown.id}
                        workstream={shown}
                        projectPaths={group?.roots.map((root) => root.path) ?? []}
                        onOpenSession={openSession}
                        onOpenSide={openSide}
                        onCreateSession={async () => {
                          if (!group) return;
                          try {
                            await useAppStore.getState().newSession({ projectPath: group.primaryPath });
                          } catch (cause) {
                            fail(cause);
                          }
                        }}
                      />
                      </section>
                      {(() => {
                        const sides = snapshot.conversations
                          .filter((item) => item.workstreamId === shown.id && item.relation !== "main")
                          .sort((left, right) => left.order - right.order);
                        if (shown.executionMode === "session" && !sides.length) return null;
                        return (
                          <section className="workflow-detail-sides" aria-label={t("workflow.sideConversations")}>
                            <div className="project-section-label">
                              <h3>{t("workflow.sideConversations")}</h3>
                              <span className="project-section-count">{sides.length}</span>
                            </div>
                            {sides.length ? sides.map((item) => (
                              <Button key={item.sessionId} variant="ghost" className="workflow-side-row"
                                data-workflow-side-row={item.sessionId} onClick={() => openSide(item.sessionId)}>
                                <IconChat size={15} />
                                <span className="workflow-side-copy">
                                  <span className="workflow-side-title">
                                    {sessions.find((session) => session.id === item.sessionId)?.title || t(`workflow.purposes.${item.purpose}`)}
                                  </span>
                                  <small>
                                    {t(`workflow.purposes.${item.purpose}`)}
                                    {item.archived ? ` · ${t("projectStructure.archived")}` : ""}
                                  </small>
                                </span>
                                <IconChevronRight size={14} />
                              </Button>
                            )) : <p className="project-empty-line">{t("workflow.noSides")}</p>}
                          </section>
                        );
                      })()}
                      {(shown.executionMode !== "session" || hasTaskRecords) && <section className="workflow-detail-outputs" aria-label={t(shown.executionMode === "session" ? "workflow.taskRecords" : "workflow.artifacts")}>
                        <div className="project-section-label"><h3>{t(shown.executionMode === "session" ? "workflow.taskRecords" : "workflow.artifacts")}</h3></div>
                        <WorkflowArtifacts projectId={projectId} workstreamId={shown.id} onOpenReference={openReference} />
                      </section>}
                    </section>
                  </div>
                ) : null}
              </div>
            )}
            </div>
          </>
        )}
        {groupLoaded && !group && <p role="status">{t("workflow.projectMissing")}</p>}
      </div>
      {editing && <WorkstreamEditorDialog onClose={() => setEditing(null)}>
        <WorkstreamEditor key={editing === "edit" ? shown?.id : "new"} projectId={projectId}
          workstream={editing === "edit" ? shown : undefined} onClose={() => setEditing(null)}
          onSaved={(id) => { if (renderNavigation !== consoleNavigation.current) return; setEditing(null); selectWorkstream(id); }} />
      </WorkstreamEditorDialog>}
      {project && contextEditor === "instructions" && (
        <ProjectInstructionsDialog
          project={project}
          onClose={() => setContextEditor(null)}
          onSaved={() => void refresh()}
          onError={fail}
        />
      )}
      {project && contextEditor === "memory" && (
        <ProjectMemoryDialog
          project={project}
          onClose={() => {
            memorySourceNavigation.current += 1;
            setContextEditor(null);
          }}
          onOpenSource={(sessionId, messageId) => void openMemorySource(sessionId, messageId)}
          onSaved={() => void refresh()}
          onError={fail}
        />
      )}
    </div>
  );
}
