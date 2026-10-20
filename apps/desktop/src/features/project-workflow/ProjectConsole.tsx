import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectGroupRecord, ProjectWorkflowSearchHit } from "@pi-desktop/shared";
import { Badge, Button, Field, Select, SegmentedControl, Textarea } from "../../components/ui";
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
import "./workflow.css";

export function ProjectConsole({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { snapshot, loading, error, refresh, busy, action } = useProjectWorkflow();
  const [group, setGroup] = useState<ProjectGroupRecord | null>(null);
  const [groupLoaded, setGroupLoaded] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [tab, setTab] = useState<"overview" | "context" | "artifacts">("overview");
  const [editing, setEditing] = useState<"new" | "edit" | null>(null);
  const [contextEditor, setContextEditor] = useState<"instructions" | "memory" | null>(null);
  const [intent, setIntent] = useState("");
  const [intentTarget, setIntentTarget] = useState("");
  const [searchTarget, setSearchTarget] = useState<ProjectWorkflowSearchHit | null>(null);
  const mounted = useRef(true);
  const consoleNavigation = useRef(0);
  const renderNavigation = consoleNavigation.current;
  const selectWorkstream = (id: string) => {
    consoleNavigation.current += 1;
    setSelectedId(id);
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
  const attention = workstreams.filter(
    (item) => item.status === "blocked" || item.status === "awaiting_user",
  );
  const completed = workstreams.filter((item) => item.status === "completed");
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
    const target = workstreams.find((item) => item.id === intentTarget);
    if (!target) return;
    const result = await action({
      kind: "side.create",
      projectId,
      workstreamId: target.id,
      purpose: "explore",
      visibility: "project",
      task: intent.trim(),
      sourceSessionId: target.mainSessionId,
      readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: true },
    });
    if (result) {
      setIntent("");
      if (result.sessionId) await openSession(result.sessionId);
    }
  };
  const project = group ? { name: group.name, path: group.primaryPath, groupId: group.id } : null;
  return (
    <div className="workflow-console" data-workflow="console" data-project-id={projectId}>
      <div className="workflow-page">
        <header className="workflow-header">
          <div>
            <p className="workflow-eyebrow">{t("workflow.console")}</p>
            <h1>{group?.name ?? projectId}</h1>
          </div>
          <div className="workflow-actions">
            <Button disabled={loading || busy} onClick={() => void refresh()}>
              {t("workflow.retry")}
            </Button>
            <Button disabled={!group} onClick={() => setContextEditor("instructions")}>
              {t("workflow.instructions")}
            </Button>
            <Button disabled={!group} onClick={() => setContextEditor("memory")}>
              {t("workflow.memory")}
            </Button>
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
            <WorkflowSearch
              key={projectId}
              projectId={projectId}
              onResult={(hit) => {
                selectWorkstream(hit.workstreamId ?? "");
                selectTab(
                  hit.kind === "artifact"
                    ? "artifacts"
                    : hit.kind === "decision"
                      ? "context"
                      : "overview",
                );
                setSearchTarget(hit);
              }}
            />
            <SegmentedControl
              value={tab}
              onChange={selectTab}
              label={t("workflow.console")}
              options={[
                { value: "overview", label: t("workflow.overview") },
                { value: "context", label: t("workflow.context") },
                { value: "artifacts", label: t("workflow.artifacts") },
              ]}
            />
            {tab === "overview" ? (
              <>
                <section className="workflow-summary">
                  <div>
                    <h2>{t("workflow.stage")}</h2>
                    <p>
                      {selected?.goal ??
                        (workstreams
                          .filter((item) => !["completed", "cancelled"].includes(item.status))
                          .map((item) => item.goal)
                          .join(" · ") ||
                          t("workflow.empty"))}
                    </p>
                  </div>
                  {attention.length > 0 && (
                    <div>
                      <h3>{t("workflow.attention")}</h3>
                      {attention.map((item) => (
                        <Button
                          key={item.id}
                          variant="ghost"
                          onClick={() => selectWorkstream(item.id)}
                        >
                          {item.title} · {t(`workflow.status.${item.status}`)}
                        </Button>
                      ))}
                    </div>
                  )}
                  {completed.length > 0 && (
                    <div>
                      <h3>{t("workflow.completed")}</h3>
                      {completed.map((item) => (
                        <Button
                          key={item.id}
                          variant="ghost"
                          onClick={() => selectWorkstream(item.id)}
                        >
                          {item.title}
                        </Button>
                      ))}
                    </div>
                  )}
                </section>
                <div className="workflow-section-heading">
                  <h2>{t("workflow.workstreams")}</h2>
                  <Button
                    onClick={() => {
                      consoleNavigation.current += 1;
                      setEditing("new");
                    }}
                  >
                    {t("workflow.newWorkstream")}
                  </Button>
                </div>
                <div className="workflow-workstream-list">
                  {workstreams.map((item) => (
                    <Button
                      key={item.id}
                      variant="ghost"
                      className={
                        selected?.id === item.id
                          ? "workflow-workstream is-selected"
                          : "workflow-workstream"
                      }
                      data-workflow-workstream={item.id}
                      aria-pressed={selected?.id === item.id}
                      onClick={() => {
                        selectWorkstream(item.id);
                        setEditing(null);
                      }}
                    >
                      <span>
                        <strong>{item.title}</strong>
                        <small>
                          {item.owner.ref} · {item.nextAction}
                        </small>
                      </span>
                      <Badge>{t(`workflow.status.${item.status}`)}</Badge>
                    </Button>
                  ))}
                </div>
                {editing ? (
                  <WorkstreamEditor
                    key={editing === "edit" ? selected?.id : "new"}
                    projectId={projectId}
                    workstream={editing === "edit" ? selected : undefined}
                    onClose={() => setEditing(null)}
                    onSaved={(id) => {
                      if (renderNavigation !== consoleNavigation.current) return;
                      setEditing(null);
                      selectWorkstream(id);
                    }}
                  />
                ) : (
                  selected && (
                    <section className="workflow-detail" data-workstream-id={selected.id}>
                      <div className="workflow-section-heading">
                        <div>
                          <h2>{selected.title}</h2>
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
                <form
                  className="workflow-form workflow-intent"
                  data-workflow="project-intent"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void discussIntent();
                  }}
                >
                  <h2>{t("workflow.intent")}</h2>
                  <Field label={t("workflow.chooseWorkstream")}>
                    <Select
                      required
                      value={intentTarget}
                      onChange={(event) => setIntentTarget(event.target.value)}
                    >
                      <option value="">{t("workflow.chooseWorkstream")}</option>
                      {workstreams.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t("workflow.intentText")}>
                    <Textarea
                      required
                      value={intent}
                      onChange={(event) => setIntent(event.target.value)}
                      rows={3}
                    />
                  </Field>
                  <p className="workflow-muted">{t("workflow.intentHint")}</p>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={
                      busy ||
                      !intent.trim() ||
                      !workstreams.some((item) => item.id === intentTarget)
                    }
                  >
                    {t("workflow.sendIntent")}
                  </Button>
                </form>
              </>
            ) : (
              <>
                <Field label={t("workflow.chooseWorkstream")}>
                  <Select
                    value={selectedId}
                    onChange={(event) => selectWorkstream(event.target.value)}
                  >
                    <option value="">{t("workflow.allWorkstreams")}</option>
                    {workstreams.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </Select>
                </Field>
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
          </>
        )}
        {groupLoaded && !group && <p role="status">{t("workflow.projectMissing")}</p>}
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
