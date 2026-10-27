import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DiffFile, WorkspaceDiff } from "@pi-desktop/shared";
import { reviewChangesFromMessages, summarizeReviewChanges } from "../../lib/workspace-review";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { IconChevronRight, IconDiff, IconRefresh } from "../icons";
import { ReviewChangeCard } from "../ReviewChangeCard";
import { SegmentedControl, Select, TooltipButton } from "../ui";
import { WorkTabEmpty } from "./WorkTabEmpty";

type Repository = { id: string; label: string; diff: WorkspaceDiff; error?: string };

function GitFiles({ files }: { files: DiffFile[] }) {
  const { t } = useTranslation();
  return <div className="project-diff review-git-files">{files.map((file) => (
    <details key={file.path} className="review-git-file" data-review-git-path={file.path}>
      <summary>
        <IconChevronRight size={12} className="review-git-caret" />
        <code title={file.path}>{file.path}</code>
        <span>{t(`projectStructure.fileStates.${file.status}`)}</span>
        <span className="diff-counts"><span className="diff-count-add">+{file.additions}</span> <span className="diff-count-del">−{file.deletions}</span></span>
      </summary>
      {file.oldPath && <p>{file.oldPath} → {file.path}</p>}
      {file.binary || file.tooLarge ? <p>{t(file.binary ? "panel.review.binary" : "panel.review.tooLarge")}</p> : file.hunks.length ? (
        <div className="review-change-diff">{file.hunks.map((hunk, index) => <div className="diff-hunk" key={index}>
          <div className="diff-line hunk"><span className="diff-line-text">{hunk.header}</span></div>
          {hunk.lines.map((line, lineIndex) => <div className={`diff-line ${line.type}`} key={lineIndex}>
            <span className="diff-line-sign" aria-hidden>{line.type === "add" ? "+" : line.type === "del" ? "−" : " "}</span>
            <span className="diff-line-text">{line.text}</span>
          </div>)}
        </div>)}</div>
      ) : <p>{t("panel.review.noLineDetails")}</p>}
    </details>
  ))}</div>;
}

export function ReviewTab({ projectId }: { projectId?: string }) {
  const { t } = useTranslation();
  const messages = useAppStore((state) => state.messages);
  const sessionId = useAppStore((state) => state.activeSessionId);
  const workspacePath = useAppStore((state) => state.workspace?.path);
  const running = useAppStore((state) => state.isRunning);
  const entries = useMemo(() => projectId ? [] : reviewChangesFromMessages(messages), [messages, projectId]);
  const summary = useMemo(() => summarizeReviewChanges(entries), [entries]);
  const [source, setSource] = useState<"git" | "history">("git");
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [rootId, setRootId] = useState("");
  const [revision, setRevision] = useState(0);
  const [loadedKey, setLoadedKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const contextKey = projectId ? `project:${projectId}` : `session:${sessionId ?? ""}:${workspacePath ?? ""}`;
  const completedTools = messages.filter((message) => message.role === "tool" && message.toolStatus !== "running").length;

  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (source !== "git") return;
    setLoading(true);
    setError("");
    const load = async (): Promise<Repository[]> => {
      if (projectId) {
        const value = await api.projectStructure.gitSnapshot({ projectId });
        return value.repositories.map((repo) => ({ id: repo.rootId, label: repo.label, diff: repo.changes, error: repo.error }));
      }
      return [{ id: "workspace", label: workspacePath ?? "", diff: await api.workspaceDiff(sessionId) }];
    };
    void load().then((value) => {
      if (!cancelled) { setRepositories(value); setLoadedKey(contextKey); }
    }).catch((cause) => {
      if (!cancelled) { setError(cause instanceof Error ? cause.message : String(cause)); setRepositories([]); setLoadedKey(contextKey); }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [contextKey, projectId, sessionId, workspacePath, revision, source, running, completedTools]);

  const repo = loadedKey === contextKey ? repositories.find((item) => item.id === rootId) ?? repositories[0] : undefined;
  const diff = repo?.diff;
  const currentError = loadedKey === contextKey ? error || repo?.error : "";
  const layered = diff?.stagedFiles !== undefined && diff.unstagedFiles !== undefined;
  return <div className="review-tab">
    <div className="review-toolbar review-source-toolbar">
      <SegmentedControl label={t("panel.tabs.review")} value={source} onChange={setSource} options={[
        { value: "git", label: t("panel.review.workspaceChanges") },
        { value: "history", label: t("panel.review.toolHistory") },
      ]} />
      {source === "git" && <TooltipButton tooltip={t("panel.review.refresh")} ariaLabel={t("panel.review.refresh")} disabled={loading} onClick={() => setRevision((value) => value + 1)}><IconRefresh size={14} /></TooltipButton>}
    </div>
    {source === "history" ? <>
      {!entries.length ? <WorkTabEmpty icon={IconDiff} title={t("panel.review.noChanges")} /> : <>
        <div className="review-toolbar"><span className="review-summary">{t("panel.review.changes", { count: summary.changeCount })}</span><span className="diff-counts"><span className="diff-count-add">+{summary.additions}</span> <span className="diff-count-del">−{summary.deletions}</span></span></div>
        <div className="review-scroll">{entries.map((entry) => <ReviewChangeCard key={entry.change.snapshotId} message={entry.message} compact />)}</div>
      </>}
    </> : <>
      <p className="review-git-scope">{t("panel.review.gitScope")}</p>
      {repositories.length > 1 && loadedKey === contextKey && <Select aria-label={t("projectStructure.repository")} value={repo?.id ?? ""} onChange={(event) => setRootId(event.target.value)}>{repositories.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</Select>}
      {loading || loadedKey !== contextKey ? <p role="status" className="review-git-note">{t("common.loading")}</p> : currentError ? <p role="alert" className="review-git-note">{currentError}</p> : !diff?.repo ? <WorkTabEmpty icon={IconDiff} title={t("panel.review.notRepository")} /> : diff.clean ? <WorkTabEmpty icon={IconDiff} title={t("panel.review.clean")} /> : <div className="review-scroll review-git-scroll">
        {layered ? <>
          {!!diff.stagedFiles!.length && <section data-review-layer="staged"><h3>{t("panel.review.staged")}</h3><GitFiles files={diff.stagedFiles!} /></section>}
          {!!diff.unstagedFiles!.length && <section data-review-layer="unstaged"><h3>{t("panel.review.unstaged")}</h3><GitFiles files={diff.unstagedFiles!} /></section>}
        </> : <GitFiles files={diff.files} />}
        {diff.truncated && <p className="review-git-note">{t("projectStructure.diffLimited")}</p>}
      </div>}
    </>}
  </div>;
}
