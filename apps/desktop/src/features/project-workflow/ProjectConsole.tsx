import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectGroupRecord, ProjectWorkflowSearchHit } from "@pi-desktop/shared";
import { Button, Field, Select, TooltipButton } from "../../components/ui";
import { IconChevronLeft, IconFolder, IconMore, IconPanelOpen, IconPlus, IconSearch } from "../../components/icons";
import { ProjectInstructionsDialog } from "../../components/ProjectInstructionsDialog";
import { ProjectMemoryDialog } from "../../components/ProjectMemoryDialog";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { normalizeAccentPresetId } from "@pi-desktop/shared";
import { projectAccentStyle } from "../../lib/project-accent";
import { projectMetaFor } from "../../lib/sidebar-preferences";
import { useProjectWorkflow } from "./useProjectWorkflow";
import { WorkstreamEditor } from "./WorkstreamEditor";
import { WorkflowControls } from "./WorkflowControls";
import { WorkflowSearch } from "./WorkflowSearch";
import { WorkflowArtifacts } from "./WorkflowArtifacts";
import { WorkstreamEditorDialog } from "./WorkstreamEditorDialog";
import { ProjectOverview } from "./ProjectOverview";
import { ProjectStructureView } from "./ProjectStructureView";
import { ProjectAgentDock } from "./ProjectAgentDock";
import { WorkflowContext } from "./WorkflowContext";
import { WorkflowStatusBadge } from "./WorkflowStatusBadge";
import { useProjectAgentDockState } from "./project-agent-dock-state";
import "./workflow.css";
import "./project-console-styles.css";
import "./project-structure-styles.css";
import "./project-home-styles.css";

/** Below this console width the Agent dock overlays the page instead of docking. */
const DOCKED_AGENT_MIN_WIDTH = 960;
const AGENT_DOCK_WIDTH = 340;
/** Page width from which the workstream list and detail sit side by side. */
const SPLIT_WORK_MIN_WIDTH = 720;

export function ProjectConsole({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { snapshot, loading, error, refresh, busy } = useProjectWorkflow();
  const [group, setGroup] = useState<ProjectGroupRecord | null>(null);
  const [groupLoaded, setGroupLoaded] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [tab, setTab] = useState<"overview" | "work" | "context" | "structure">("overview");
  const root = useRef<HTMLDivElement>(null);
  const [consoleWidth, setConsoleWidth] = useState(DOCKED_AGENT_MIN_WIDTH);
  const wide = consoleWidth >= DOCKED_AGENT_MIN_WIDTH;
  const [dockedOpen, setDockedOpen] = useProjectAgentDockState(projectId, wide);
  // An overlay covers the page, so it opens only on request and never persists.
  const [overlayOpen, setOverlayOpen] = useState(false);
  useEffect(() => {
    if (wide) setOverlayOpen(false);
  }, [wide]);
  const dockOpen = wide ? dockedOpen : overlayOpen;
  const setDockOpen = (open: boolean) => (wide ? setDockedOpen(open) : setOverlayOpen(open));
  const [editing, setEditing] = useState<"new" | "edit" | null>(null);
  const [contextEditor, setContextEditor] = useState<"instructions" | "memory" | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTarget, setSearchTarget] = useState<ProjectWorkflowSearchHit | null>(null);
  const mounted = useRef(true);
  // Measure before first paint so the dock mode (docked vs overlay) is never
  // decided from the placeholder width.
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
  const pageWidth = consoleWidth - (dockOpen && wide ? AGENT_DOCK_WIDTH : 0);
  const splitWork = pageWidth >= SPLIT_WORK_MIN_WIDTH;
  // A split view shows list and detail together, so it never shows an empty
  // detail; a stacked one shows the list until a workstream is chosen.
  const shown = selected ?? (splitWork ? workstreams[0] : undefined);
  const candidate = snapshot?.artifacts.find((item) => item.id === shown?.currentCandidateId);
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
  const projectColor = useAppStore((s) => group ? normalizeAccentPresetId(projectMetaFor(group.primaryPath, s.projectMeta).color) : undefined);
  const project = group ? { name: group.name, path: group.primaryPath, groupId: group.id } : null;
  const dockVisible = dockOpen && Boolean(snapshot);
  return (
    <div className="workflow-console" ref={root} data-workflow="console" data-project-id={projectId}
      data-project-color={projectColor} style={projectAccentStyle(projectColor)}
      data-agent-dock={dockVisible ? (wide ? "docked" : "overlay") : "closed"}>
      <div className="workflow-page">
        <header className="workflow-header">
          <div className="workflow-project-identity">
            <div className="workflow-project-mark"><IconFolder size={14} /></div>
            <div><h1>{group?.name ?? projectId}</h1>
              <p className="workflow-muted workflow-project-path">{group?.primaryPath}</p>
            </div>
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
            <TooltipButton className={`ct-icon-btn workflow-agent-dock-toggle${dockVisible ? " is-active" : ""}`}
              tooltip={t(dockVisible ? "workflow.agentDockClose" : "workflow.agentDockOpen")}
              ariaLabel={t(dockVisible ? "workflow.agentDockClose" : "workflow.agentDockOpen")}
              aria-pressed={dockVisible} data-project-agent-dock-toggle={projectId} disabled={!snapshot}
              onClick={() => setDockOpen(!dockVisible)}><IconPanelOpen size={16} /></TooltipButton>
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
              <Button variant="ghost" aria-current={tab === "work" ? "page" : undefined} onClick={() => selectTab("work")}>
                {t("workflow.workstreams")}
                {workstreams.length ? <span className="workflow-tab-count">{workstreams.length}</span> : null}
              </Button>
              <Button variant="ghost" aria-current={tab === "context" ? "page" : undefined} onClick={() => selectTab("context")}>{t("workflow.context")}</Button>
              <Button variant="ghost" aria-current={tab === "structure" ? "page" : undefined} onClick={() => selectTab("structure")}>{t("projectStructure.structure")}</Button>
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
                  <Field label={t("workflow.chooseWorkstream")}>
                    <Select value={selectedId} onChange={(event) => selectWorkstream(event.target.value, false)}>
                      <option value="">{t("workflow.allWorkstreams")}</option>
                      {workstreams.map((item) => (
                        <option key={item.id} value={item.id}>{item.title}</option>
                      ))}
                    </Select>
                  </Field>
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
                    <TooltipButton className="ct-icon-btn" tooltip={t("workflow.newWorkstream")} ariaLabel={t("workflow.newWorkstream")}
                      onClick={createWorkstream}><IconPlus size={14} /></TooltipButton>
                  </div>
                  {workstreams.length ? workstreamRows(workstreams) : (
                    <div className="workflow-empty"><strong>{t("workflow.noCurrentWork")}</strong><p>{t("workflow.startWithAgent")}</p>
                      <Button variant="ghost" onClick={() => setDockOpen(true)}>{t("workflow.agentDockOpen")}</Button></div>
                  )}
                </nav>
                {shown ? (
                  <div className="workflow-work-detail">
                    <Button variant="ghost" className="workflow-back" onClick={() => selectWorkstream("")}><IconChevronLeft size={14} />{t("workflow.allWorkstreams")}</Button>
                    <section className="workflow-detail" data-workstream-id={shown.id} data-workflow-workstream={shown.id}>
                      <div className="workflow-detail-head">
                        <div>
                          <h2>{shown.title} <WorkflowStatusBadge status={shown.status} /></h2>
                          <p className="workflow-muted">
                            {t("workflow.revision", { revision: shown.revision })} · {shown.owner.ref}
                          </p>
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
                      {shown.blocker && (
                        <div className="workflow-blocker">
                          <strong>{shown.blocker.reason}</strong>
                          <span>{t("workflow.blockerOwner", { owner: shown.blocker.owner })}</span>
                          <span>{t("workflow.resumeWhen", { condition: shown.blocker.resumeWhen })}</span>
                        </div>
                      )}
                      {candidate && (
                        <div className="workflow-candidate-summary">
                          <div>
                            <h3>{t("workflow.currentCandidate")}</h3>
                            <strong>{candidate.label}</strong>
                            <p className="workflow-muted">{candidate.revision} · {candidate.environment}</p>
                          </div>
                          <Button onClick={() => void openReference({ kind: "artifact", id: candidate.id }).catch(fail)}>
                            {candidate.entryPoint}
                          </Button>
                        </div>
                      )}
                      <dl className="workflow-detail-facts">
                        {shown.nextAction ? (<><dt>{t("workflow.nextAction")}</dt><dd>{shown.nextAction}</dd></>) : null}
                        {shown.dependencyIds.length > 0 ? (<><dt>{t("workflow.dependencies")}</dt>
                          <dd>{shown.dependencyIds.map((id) => workstreams.find((item) => item.id === id)?.title ?? id).join(", ")}</dd></>) : null}
                      </dl>
                      <WorkflowControls
                        key={shown.id}
                        workstream={shown}
                        projectPaths={group?.roots.map((root) => root.path) ?? []}
                        onOpenSession={openSession}
                        onCreateSession={async () => {
                          if (!group) return;
                          try {
                            await useAppStore.getState().newSession({ projectPath: group.primaryPath });
                          } catch (cause) {
                            fail(cause);
                          }
                        }}
                      />
                      <section className="workflow-detail-outputs" aria-label={t("workflow.artifacts")}>
                        <div className="project-section-label"><h2>{t("workflow.artifacts")}</h2></div>
                        <WorkflowArtifacts projectId={projectId} workstreamId={shown.id} onOpenReference={openReference} />
                      </section>
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
      {dockVisible ? (
        <ProjectAgentDock projectId={projectId} projectName={group?.name} onClose={() => setDockOpen(false)} />
      ) : null}
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
          onClose={() => setContextEditor(null)}
          onSaved={() => void refresh()}
          onError={fail}
        />
      )}
    </div>
  );
}
