import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectGroupRecord, ProjectWorkflowSearchHit } from "@pi-desktop/shared";
import { Badge, Button, Field, Select, Textarea, TooltipButton } from "../../components/ui";
import { IconArrowUp, IconChat, IconChevronLeft, IconChevronRight, IconFileText, IconFolder, IconMore, IconPlus, IconSearch, IconShield, IconTarget } from "../../components/icons";
import { ProjectInstructionsDialog } from "../../components/ProjectInstructionsDialog";
import { ProjectMemoryDialog } from "../../components/ProjectMemoryDialog";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { useProjectWorkflow } from "./useProjectWorkflow";
import { WorkstreamEditor } from "./WorkstreamEditor";
import { WorkflowControls } from "./WorkflowControls";
import { WorkflowSearch } from "./WorkflowSearch";
import { WorkflowContext } from "./WorkflowContext";
import { WorkflowArtifacts } from "./WorkflowArtifacts";
import { WorkstreamEditorDialog } from "./WorkstreamEditorDialog";
import { useProjectAgent } from "./useProjectAgent";
import { useProjectAgentDraft } from "./project-agent-draft";
import "./workflow.css";
import "./project-console-styles.css";

export function ProjectConsole({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { snapshot, loading, error, refresh, busy } = useProjectWorkflow();
  const projectAgent = useProjectAgent(projectId);
  const [group, setGroup] = useState<ProjectGroupRecord | null>(null);
  const [groupLoaded, setGroupLoaded] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [tab, setTab] = useState<"overview" | "work" | "context" | "artifacts">("overview");
  const [editing, setEditing] = useState<"new" | "edit" | null>(null);
  const [contextEditor, setContextEditor] = useState<"instructions" | "memory" | null>(null);
  const [intent, setIntent] = useProjectAgentDraft(projectId);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTarget, setSearchTarget] = useState<ProjectWorkflowSearchHit | null>(null);
  const mounted = useRef(true);
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
  const current = workstreams.filter((item) => !["completed", "cancelled"].includes(item.status));
  const recentArtifacts = snapshot?.artifacts.filter((item) => item.projectId === projectId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 3) ?? [];
  const candidate = snapshot?.artifacts.find((item) => item.id === selected?.currentCandidateId);
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
  const discussIntent = async () => {
    if (!intent.trim() || projectAgent.busy) return;
    try { await projectAgent.open(intent.trim()); setIntent(""); } catch (cause) { fail(cause); }
  };
  const openAgent = () => { void projectAgent.open().catch(fail); };
  const createWorkstream = () => {
    consoleNavigation.current += 1;
    setEditing("new");
  };
  const workstreamRows = (items: typeof workstreams) => (
    <div className="workflow-workstream-list">
      {items.map((item) => (
        <Button key={item.id} variant="ghost"
          className={selected?.id === item.id ? "workflow-workstream is-selected" : "workflow-workstream"}
          data-workflow-workstream={item.id} aria-pressed={selected?.id === item.id}
          onClick={() => { selectWorkstream(item.id); setEditing(null); }}>
          <IconTarget size={17} />
          <span className="workflow-row-copy"><strong>{item.title}</strong><small>{item.nextAction || item.goal}</small></span>
          <Badge>{t(`workflow.status.${item.status}`)}</Badge>
          <IconChevronRight size={14} />
        </Button>
      ))}
    </div>
  );
  const project = group ? { name: group.name, path: group.primaryPath, groupId: group.id } : null;
  return (
    <div className="workflow-console" data-workflow="console" data-project-id={projectId}>
      <div className="workflow-page">
        <header className="workflow-header">
          <div className="workflow-project-identity">
            <div className="workflow-project-mark"><IconFolder size={21} /></div>
            <div><h1>{group?.name ?? projectId}</h1>
              <p className="workflow-muted workflow-project-path">{group?.primaryPath}</p>
            </div>
          </div>
          <div className="workflow-actions">
            <TooltipButton tooltip={t("workflow.search")} ariaLabel={t("workflow.search")}
              aria-expanded={searchOpen} onClick={() => setSearchOpen(!searchOpen)}><IconSearch size={16} /></TooltipButton>
            <Button variant="ghost" className="workflow-context-shortcut" onClick={() => selectTab("context")}>
              <IconFileText size={15} />{t("workflow.context")}</Button>
            <details className="workflow-project-menu">
              <summary aria-label={t("workflow.projectMenu")}><IconMore size={18} /></summary>
              <div className="workflow-project-menu-content">
                <Button variant="ghost" disabled={!group} onClick={(event) => { setContextEditor("instructions"); event.currentTarget.closest("details")?.removeAttribute("open"); }}>{t("workflow.instructions")}</Button>
                <Button variant="ghost" disabled={!group} onClick={(event) => { setContextEditor("memory"); event.currentTarget.closest("details")?.removeAttribute("open"); }}>{t("workflow.memory")}</Button>
                <Button variant="ghost" disabled={loading || busy} onClick={(event) => { void refresh(); event.currentTarget.closest("details")?.removeAttribute("open"); }}>{t("workflow.retry")}</Button>
              </div>
            </details>
          </div>
        </header>
        {(error || localError || projectAgent.error) && (
          <p className="workflow-error" role="alert">
            {error ?? localError ?? projectAgent.error}
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
                selectWorkstream(hit.workstreamId ?? "");
                selectTab(
                  hit.kind === "artifact"
                    ? "artifacts"
                    : hit.kind === "decision"
                      ? "context"
                      : "work",
                );
                setSearchTarget(hit);
              }}
            /></div>
            <nav className="workflow-tabs" aria-label={t("workflow.console")}>
              <Button variant="ghost" aria-current={tab === "overview" ? "page" : undefined} onClick={() => selectTab("overview")}>{t("workflow.overview")}</Button>
              <Button variant="ghost" className="workflow-agent-tab" disabled={projectAgent.busy} onClick={openAgent}><IconChat size={15} />{t("workflow.agentTitle")}</Button>
              <Button variant="ghost" aria-current={tab === "work" ? "page" : undefined} onClick={() => selectTab("work")}>{t("workflow.workstreams")}</Button>
              <Button variant="ghost" aria-current={tab === "artifacts" ? "page" : undefined} onClick={() => selectTab("artifacts")}>{t("workflow.artifacts")}</Button>
              <Button variant="ghost" aria-current={tab === "context" ? "page" : undefined} onClick={() => selectTab("context")}>{t("workflow.context")}</Button>
            </nav>
            <div className="workflow-content">
            {tab === "overview" ? (
              <section className="workflow-overview">
                <div className="workflow-home-intro"><h2>{t("workflow.homeTitle")}</h2><p>{t("workflow.homeSubtitle")}</p></div>
                <form className="composer-shell workflow-agent-composer" data-workflow="project-intent" onSubmit={(event) => { event.preventDefault(); void discussIntent(); }}>
                  <Textarea aria-label={t("workflow.intentText")} placeholder={t("workflow.agentPlaceholder")} rows={2}
                    value={intent} disabled={projectAgent.busy} onChange={(event) => setIntent(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault(); void discussIntent();
                      }
                    }} />
                  <div className="composer-toolbar">
                    <div className="composer-left"><TooltipButton tooltip={t("workflow.context")} ariaLabel={t("workflow.context")} className="icon-btn icon-btn-square" type="button" onClick={() => selectTab("context")}><IconPlus size={16} /></TooltipButton><span className="workflow-composer-mode"><IconChat size={14} />{t("workflow.discussion")}</span></div>
                    <div className="composer-right"><Button type="button" variant="ghost" className="workflow-composer-model" disabled={projectAgent.busy} onClick={openAgent}>{t("workflow.configureAgent")}</Button><TooltipButton type="submit" className="send-btn" tooltip={t("workflow.sendAgent")} ariaLabel={t("workflow.sendAgent")} disabled={projectAgent.busy || !intent.trim()}><IconArrowUp size={16} /></TooltipButton></div>
                  </div>
                </form>
                <p className="workflow-composer-note"><IconShield size={12} />{t("workflow.agentDiscussionHint")}</p>
                <div className="workflow-suggestions">{(["status", "idea", "decisions"] as const).map((kind) => <Button variant="ghost" key={kind} disabled={projectAgent.busy} onClick={() => setIntent(t(`workflow.agentPrompts.${kind}`))}>{t(`workflow.agentSuggestions.${kind}`)}</Button>)}</div>
                <div className="workflow-section-heading">
                  <h2>{t("workflow.stage")}</h2><Button variant="ghost" onClick={createWorkstream}><IconPlus size={14} />{t("workflow.newWorkstream")}</Button>
                </div>
                {current.length ? workstreamRows(current.slice(0, 5)) : <div className="workflow-empty"><strong>{t("workflow.noCurrentWork")}</strong><p>{t("workflow.startWithAgent")}</p></div>}
                {workstreams.length > 5 || workstreams.some((item) => ["completed", "cancelled"].includes(item.status)) ? <Button variant="ghost" className="workflow-view-all" onClick={() => { setSelectedId(""); selectTab("work"); }}>{t("workflow.allWorkstreams")}<IconChevronRight size={14} /></Button> : null}
                {recentArtifacts.length ? <><div className="workflow-section-heading"><h2>{t("workflow.recentArtifacts")}</h2><Button variant="ghost" onClick={() => { setSelectedId(""); selectTab("artifacts"); }}>{t("workflow.viewAll")}<IconChevronRight size={14} /></Button></div><div className="workflow-recent-artifacts">{recentArtifacts.map((item) => <div className="workflow-artifact-row" key={item.id}><IconFileText size={18} /><div><strong>{item.label}</strong><p>{workstreams.find((work) => work.id === item.workstreamId)?.title}</p></div><Button onClick={() => void openReference({ kind: "artifact", id: item.id }).catch(fail)}>{t("workflow.openArtifact")}</Button></div>)}</div></> : null}
              </section>
            ) : tab === "work" ? (
              <>
                <div className="workflow-section-heading"><h2>{t("workflow.workstreams")}</h2><Button variant="ghost" onClick={createWorkstream}><IconPlus size={14} />{t("workflow.newWorkstream")}</Button></div>
                {selected ? <Button variant="ghost" className="workflow-back" onClick={() => selectWorkstream("")}><IconChevronLeft size={14} />{t("workflow.allWorkstreams")}</Button> : null}
                {!selected ? (workstreams.length ? workstreamRows(workstreams) : <div className="workflow-empty"><strong>{t("workflow.noCurrentWork")}</strong><p>{t("workflow.startWithAgent")}</p><Button variant="ghost" onClick={openAgent} disabled={projectAgent.busy}><IconChat size={14} />{t("workflow.agentTitle")}</Button></div>) : (
                  selected && (
                    <section className="workflow-detail" data-workstream-id={selected.id} data-workflow-workstream={selected.id}>
                      <div className="workflow-section-heading">
                        <div>
                          <h2>{selected.title}</h2>
                          <Badge>{t(`workflow.status.${selected.status}`)}</Badge>
                          <p className="workflow-muted">
                            {t("workflow.revision", { revision: selected.revision })} ·{" "}
                            {selected.owner.ref}
                          </p>
                        </div>
                        <Button
                          onClick={() => {
                            consoleNavigation.current += 1;
                            setEditing("edit");
                          }}
                        >
                          {t("workflow.editWorkstream")}
                        </Button>
                      </div>
                      <p>{selected.goal}</p>
                      {selected.blocker && (
                        <div className="workflow-blocker">
                          <strong>{selected.blocker.reason}</strong>
                          <span>
                            {t("workflow.blockerOwner", { owner: selected.blocker.owner })}
                          </span>
                          <span>
                            {t("workflow.resumeWhen", { condition: selected.blocker.resumeWhen })}
                          </span>
                        </div>
                      )}
                      {selected.dependencyIds.length > 0 && (
                        <p>
                          {t("workflow.dependencies")}:{" "}
                          {selected.dependencyIds
                            .map((id) => workstreams.find((item) => item.id === id)?.title ?? id)
                            .join(", ")}
                        </p>
                      )}
                      <p>
                        <strong>{t("workflow.nextAction")}: </strong>
                        {selected.nextAction}
                      </p>
                      {selected.mainSessionId && (
                        <Button onClick={() => void openSession(selected.mainSessionId!)}>
                          {t("workflow.openMain")}
                        </Button>
                      )}
                      {candidate && (
                        <div className="workflow-candidate-summary">
                          <h3>{t("workflow.currentCandidate")}</h3>
                          <strong>{candidate.label}</strong>
                          <p>
                            {candidate.revision} · {candidate.environment}
                          </p>
                          <div className="workflow-actions">
                            <Button
                              onClick={() =>
                                void openReference({ kind: "artifact", id: candidate.id }).catch(
                                  fail,
                                )
                              }
                            >
                              {candidate.entryPoint}
                            </Button>
                            <Button onClick={() => selectTab("artifacts")}>
                              {t("workflow.artifacts")}
                            </Button>
                          </div>
                        </div>
                      )}
                      <WorkflowControls
                        key={selected.id}
                        workstream={selected}
                        projectPaths={group?.roots.map((root) => root.path) ?? []}
                        onOpenSession={openSession}
                        onCreateSession={async () => {
                          if (!group) return;
                          try {
                            await useAppStore
                              .getState()
                              .newSession({ projectPath: group.primaryPath });
                          } catch (cause) {
                            fail(cause);
                          }
                        }}
                      />
                    </section>
                  )
                )}
              </>
            ) : (
              <>
                <div className="workflow-filter"><Field label={t("workflow.chooseWorkstream")}>
                  <Select
                    value={selectedId}
                    onChange={(event) => selectWorkstream(event.target.value, false)}
                  >
                    <option value="">{t("workflow.allWorkstreams")}</option>
                    {workstreams.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </Select>
                </Field></div>
                {tab === "context" ? (
                  <WorkflowContext
                    projectId={projectId}
                    workstreamId={selected?.id}
                    onOpenReference={openReference}
                  />
                ) : (
                  <WorkflowArtifacts
                    projectId={projectId}
                    workstreamId={selected?.id}
                    onOpenReference={openReference}
                  />
                )}
              </>
            )}
            </div>
          </>
        )}
        {groupLoaded && !group && <p role="status">{t("workflow.projectMissing")}</p>}
        {editing && <WorkstreamEditorDialog onClose={() => setEditing(null)}>
          <WorkstreamEditor key={editing === "edit" ? selected?.id : "new"} projectId={projectId}
            workstream={editing === "edit" ? selected : undefined} onClose={() => setEditing(null)}
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
    </div>
  );
}
