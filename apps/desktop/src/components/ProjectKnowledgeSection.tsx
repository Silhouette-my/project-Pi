import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectKnowledgeEntry, ProjectKnowledgeSnapshot } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { normalizeProjectPath } from "../lib/sidebar-session-groups";
import { Button } from "./ui";
import { IconBookOpen, IconChat, IconExternal, IconSparkles, IconTrash } from "./icons";

function byRecentUpdate(left: ProjectKnowledgeEntry, right: ProjectKnowledgeEntry) {
  return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
}

function formatUpdateTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function ProjectKnowledgeSection({
  groupId,
  projectPath,
  onOpenSource,
}: {
  groupId?: string;
  projectPath: string;
  onOpenSource: (sessionId: string, messageId: string) => void;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<ProjectKnowledgeSnapshot | null>(null);
  const [resolvedGroupId, setResolvedGroupId] = useState<string | null>(groupId ?? null);
  const [loadedProjectKey, setLoadedProjectKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<"load" | "update">("load");
  const [errorProjectKey, setErrorProjectKey] = useState<string | null>(null);
  const generation = useRef(0);
  const projectPathKey = normalizeProjectPath(projectPath);
  const projectKey = groupId ?? projectPathKey;
  const projectSnapshot = loadedProjectKey === projectKey ? snapshot : null;
  const projectError = errorProjectKey === projectKey ? error : null;
  const waitingForProject = !projectKey || (loadedProjectKey !== projectKey && projectError === null);
  const showingLoading = loading || waitingForProject;

  const load = async (isCurrent: () => boolean) => {
    setLoading(true);
    setError(null);
    setErrorProjectKey(projectKey);
    setErrorKind("load");
    try {
      let resolved = groupId;
      if (!resolved) {
        if (!projectPathKey) throw new Error(t("project.agentKnowledgeProjectMissing"));
        const { groups } = await api.listProjectGroups();
        const group = groups.find((candidate) =>
          [candidate.primaryPath, ...candidate.roots.map((root) => root.path)]
            .map(normalizeProjectPath)
            .includes(projectPathKey),
        );
        if (!group) throw new Error(t("project.agentKnowledgeProjectMissing"));
        resolved = group.id;
      }
      if (!isCurrent()) return;
      setResolvedGroupId(resolved);
      const next = await api.getProjectKnowledge(resolved);
      if (!isCurrent()) return;
      setSnapshot(next);
      setLoadedProjectKey(projectKey);
    } catch (cause) {
      if (isCurrent()) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setErrorProjectKey(projectKey);
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  };

  useEffect(() => {
    const request = ++generation.current;
    setSnapshot(null);
    setLoadedProjectKey(null);
    setResolvedGroupId(groupId ?? null);
    setHistoryOpen(false);
    setForgetting(null);
    setClearingHistory(false);
    setConfirmClearHistory(false);
    void load(() => generation.current === request);
    return () => {
      generation.current += 1;
    };
  }, [groupId, projectPath]);

  const active = useMemo(
    () => (projectSnapshot?.entries ?? []).filter((entry) => entry.status === "active").sort(byRecentUpdate),
    [projectSnapshot],
  );
  const shownEntries = useMemo(() => {
    if (!historyOpen) return active;
    return [...(projectSnapshot?.entries ?? [])].sort(byRecentUpdate);
  }, [active, historyOpen, projectSnapshot]);

  const historyEntries = projectSnapshot?.entries.filter((entry) => entry.status !== "active") ?? [];

  const forget = async (entry: ProjectKnowledgeEntry) => {
    if (!snapshot || !projectSnapshot || !resolvedGroupId || entry.status !== "active") return;
    const revision = snapshot.revision;
    const request = generation.current;
    setForgetting(entry.id);
    setError(null);
    setErrorProjectKey(projectKey);
    try {
      const next = await api.forgetProjectKnowledge(resolvedGroupId, entry.id, revision);
      if (generation.current === request) setSnapshot(next);
    } catch (cause) {
      if (generation.current === request)
        setErrorKind("update");
      if (generation.current === request)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation.current === request) setForgetting(null);
    }
  };

  const clearHistory = async () => {
    if (!snapshot || !projectSnapshot || !resolvedGroupId || historyEntries.length === 0 || !confirmClearHistory) return;
    const revision = snapshot.revision;
    const request = generation.current;
    setClearingHistory(true);
    setError(null);
    setErrorProjectKey(projectKey);
    try {
      const next = await api.clearProjectKnowledgeHistory(resolvedGroupId, revision);
      if (generation.current === request) {
        setSnapshot(next);
        setConfirmClearHistory(false);
      }
    } catch (cause) {
      if (generation.current === request)
        setErrorKind("update");
      if (generation.current === request)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation.current === request) setClearingHistory(false);
    }
  };

  return (
    <section className="project-knowledge-section" aria-labelledby="project-knowledge-title" aria-busy={showingLoading || forgetting !== null || clearingHistory}>
      <div className="project-knowledge-heading">
        <h4 id="project-knowledge-title">
          <IconSparkles size={15} aria-hidden="true" />
          {t("project.agentKnowledgeTitle")}
        </h4>
        <p>{t("project.agentKnowledgeDescription")}</p>
      </div>
      {projectSnapshot && projectSnapshot.entries.length > active.length ? (
        <div className="project-knowledge-heading-actions">
            {historyOpen && historyEntries.length > 0 ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="project-knowledge-clear-history"
                disabled={loading || clearingHistory || forgetting !== null}
                onClick={() => setConfirmClearHistory(true)}
              >
                <IconTrash size={13} aria-hidden="true" />
                {t("project.agentKnowledgeClearHistory")}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-expanded={historyOpen}
              disabled={loading || clearingHistory}
              onClick={() => {
                setConfirmClearHistory(false);
                setHistoryOpen((open) => !open);
              }}
            >
              <IconBookOpen size={14} aria-hidden="true" />
              {historyOpen ? t("project.agentKnowledgeHideHistory") : t("project.agentKnowledgeShowHistory")}
            </Button>
        </div>
      ) : null}

      {projectError ? (
        <div className="project-knowledge-error" role="alert">
          <span>{t(errorKind === "load" ? "project.agentKnowledgeLoadError" : "project.agentKnowledgeUpdateError", { detail: projectError })}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => {
              const request = ++generation.current;
              void load(() => generation.current === request);
            }}
          >
            {t("project.agentKnowledgeRetry")}
          </Button>
        </div>
      ) : null}

      {showingLoading ? (
        <p className="project-knowledge-state" role="status">
          {t("project.agentKnowledgeLoading")}
        </p>
      ) : null}

      {!showingLoading && !projectError && shownEntries.length === 0 ? (
        <p className="project-knowledge-state">
          {historyOpen ? t("project.agentKnowledgeHistoryEmpty") : t("project.agentKnowledgeEmpty")}
        </p>
      ) : null}

      {!showingLoading && !projectError && shownEntries.length > 0 ? (
        <div className="project-knowledge-list" role="list">
          {shownEntries.map((entry) => (
            <article className="project-knowledge-card" key={entry.id} role="listitem">
              <div className="project-knowledge-card-heading">
                <div className="project-knowledge-title-row">
                  <strong>{entry.title || t("project.agentKnowledgeUntitled")}</strong>
                  {entry.status !== "active" ? (
                    <span className={`project-knowledge-status is-${entry.status}`}>
                      {t(`project.agentKnowledgeStatus.${entry.status}`)}
                    </span>
                  ) : null}
                </div>
                <span className="project-knowledge-meta">
                  {t(`project.agentKnowledgeKind.${entry.kind}`)} · {t("project.agentKnowledgeUpdated", {
                    time: formatUpdateTime(entry.updatedAt),
                  })}
                </span>
              </div>
              <p className="project-knowledge-content">{entry.content}</p>
              <div className="project-knowledge-actions">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => onOpenSource(entry.source.sessionId, entry.source.messageId)}
                >
                  <IconChat size={14} aria-hidden="true" />
                  {t("project.agentKnowledgeSource")}
                  <IconExternal size={12} aria-hidden="true" />
                </Button>
                {entry.status === "active" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={loading || forgetting !== null}
                    onClick={() => void forget(entry)}
                  >
                    <IconTrash size={14} aria-hidden="true" />
                    {forgetting === entry.id
                      ? t("project.agentKnowledgeForgetting")
                      : t("project.agentKnowledgeForget")}
                  </Button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {historyOpen && confirmClearHistory && !showingLoading && !projectError ? (
        <div className="project-knowledge-clear-confirm" role="group" aria-labelledby="project-knowledge-clear-description">
          <p id="project-knowledge-clear-description">{t("project.agentKnowledgeClearHistoryPrompt")}</p>
          <div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={clearingHistory}
              onClick={() => setConfirmClearHistory(false)}
            >
              {t("project.agentKnowledgeCancelClearHistory")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled={clearingHistory}
              onClick={() => void clearHistory()}
            >
              {clearingHistory
                ? t("project.agentKnowledgeClearingHistory")
                : t("project.agentKnowledgeConfirmClearHistory")}
            </Button>
          </div>
        </div>
      ) : null}

    </section>
  );
}
