import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectGitSnapshot, WorkspaceDiff } from "@pi-desktop/shared";
import { Badge, Button, Field, Select } from "../../components/ui";
import { IconChevronRight } from "../../components/icons";
import { api } from "../../lib/api";
import { gitGraph } from "./git-structure-model";

export function GitStructureView({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<ProjectGitSnapshot>();
  const [rootId, setRootId] = useState("");
  const [selection, setSelection] = useState("");
  const [diff, setDiff] = useState<WorkspaceDiff>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setSnapshot(undefined);
    setError("");
    void api.projectStructure
      .gitSnapshot({ projectId })
      .then((value) => {
        if (!cancelled) setSnapshot(value);
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, revision]);
  const repo =
    snapshot?.repositories.find((item) => item.rootId === rootId) ?? snapshot?.repositories[0];
  useEffect(() => {
    let cancelled = false;
    setDiff(undefined);
    if (!repo?.isRepository) return;
    setError("");
    void api.projectStructure
      .gitDiff({ projectId, rootId: repo.rootId, ...(selection ? { commit: selection } : {}) })
      .then((value) => {
        if (!cancelled) setDiff(value);
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, repo?.rootId, selection, revision]);
  const graph = gitGraph(repo?.commits ?? []);
  const commit = repo?.commits.find((item) => item.oid === selection);
  return (
    <section data-project-structure="git">
      <div className="project-structure-filters">
        <Field label={t("projectStructure.repository")}>
          <Select
            value={repo?.rootId ?? ""}
            onChange={(event) => {
              setRootId(event.target.value);
              setSelection("");
            }}
          >
            {snapshot?.repositories.map((item) => (
              <option key={item.rootId} value={item.rootId}>
                {item.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="ghost" onClick={() => setRevision((value) => value + 1)}>
          {t("workflow.retry")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="workflow-error">
          {error}
        </p>
      ) : null}
      {!snapshot ? (
        <p role="status">{t("workflow.loading")}</p>
      ) : !repo ? (
        <p>{t("projectStructure.noRoots")}</p>
      ) : repo.error ? (
        <p role="alert" className="workflow-error">
          {repo.error}
        </p>
      ) : !repo.isRepository ? (
        <p>{t("projectStructure.notRepository")}</p>
      ) : (
        <>
          <div className="project-git-summary">
            <strong>{repo.branch || t("projectStructure.detached")}</strong>
            <code>{repo.head?.slice(0, 10)}</code>
            <span>{repo.rootPath}</span>
          </div>
          <div className="project-git-layout">
            <div className="project-git-history">
              <Button
                variant="ghost"
                className="project-git-working"
                aria-pressed={!selection}
                onClick={() => setSelection("")}
              >
                <strong>{t("projectStructure.workingChanges")}</strong>
                <Badge>{repo.changes.files.length}</Badge>
              </Button>
              {graph.nodes.length ? (
                <div
                  className="project-git-graph"
                  style={{ "--graph-width": `${graph.width * 18 + 14}px` } as React.CSSProperties}
                >
                  <svg
                    aria-hidden="true"
                    width={graph.width * 18 + 14}
                    height={graph.nodes.length * 58}
                  >
                    {graph.nodes.flatMap((node) =>
                      node.parents.map((parent) => (
                        <path
                          key={`${node.commit.oid}-${parent.oid}`}
                          className={parent.row === undefined ? "is-boundary" : ""}
                          d={`M ${node.column * 18 + 12} ${node.row * 58 + 29} C ${node.column * 18 + 12} ${node.row * 58 + 55}, ${(parent.column ?? node.column) * 18 + 12} ${(parent.row ?? node.row + 0.65) * 58}, ${(parent.column ?? node.column) * 18 + 12} ${(parent.row ?? node.row + 0.65) * 58 + 29}`}
                        />
                      )),
                    )}
                    {graph.nodes.map((node) => (
                      <circle
                        key={node.commit.oid}
                        cx={node.column * 18 + 12}
                        cy={node.row * 58 + 29}
                        r={4}
                        className={selection === node.commit.oid ? "is-selected" : ""}
                      />
                    ))}
                  </svg>
                  <ol>
                    {graph.nodes.map(({ commit: item }) => (
                      <li key={item.oid}>
                        <Button
                          variant="ghost"
                          aria-pressed={selection === item.oid}
                          data-project-commit={item.oid}
                          onClick={() => setSelection(item.oid)}
                        >
                          <strong>{item.subject}</strong>
                          <small>
                            <code>{item.oid.slice(0, 8)}</code> · {item.authorName}
                            {item.refNames.map((ref) => (
                              <Badge key={ref}>{ref}</Badge>
                            ))}
                          </small>
                        </Button>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : (
                <p>{t("projectStructure.noCommits")}</p>
              )}
              {repo.truncated ? (
                <p className="workflow-muted">{t("projectStructure.historyLimited")}</p>
              ) : null}
              {repo.refs.length ? (
                <details className="project-git-refs">
                  <summary><IconChevronRight size={12} className="project-disclosure-icon" />{t("projectStructure.references", { count: repo.refs.length })}</summary>
                  {repo.refs.map((ref) => (
                    <p key={ref.name}>
                      <Badge>{ref.name}</Badge>
                      <code>{ref.oid.slice(0, 10)}</code>
                    </p>
                  ))}
                </details>
              ) : null}
            </div>
            <section className="project-git-detail">
              <h3>{commit?.subject ?? t("projectStructure.workingChanges")}</h3>
              {commit ? (
                <p className="workflow-muted">
                  {commit.authorName} · {commit.authoredAt}
                  <br />
                  <code>{commit.oid}</code>
                  <br />
                  {t("projectStructure.parents")}:{" "}
                  {commit.parents.map((oid) => oid.slice(0, 10)).join(", ") ||
                    t("projectStructure.rootCommit")}
                </p>
              ) : null}
              {commit && commit.parents.length > 1 ? (
                <p className="workflow-muted">{t("projectStructure.mergeBase")}</p>
              ) : null}
              {!diff ? <p role="status">{t("workflow.loading")}</p> : <ProjectDiff diff={diff} />}
            </section>
          </div>
        </>
      )}
    </section>
  );
}

function ProjectDiff({ diff }: { diff: WorkspaceDiff }) {
  const { t } = useTranslation();
  return (
    <div className="project-diff">
      {!diff.files.length ? (
        <p className="workflow-muted">{t("projectStructure.noChanges")}</p>
      ) : (
        diff.files.map((file) => (
          <details key={file.path} open={diff.files.length === 1}>
            <summary>
              <IconChevronRight size={12} className="project-disclosure-icon" />
              <code>{file.path}</code>
              <span>
                {t(`projectStructure.fileStates.${file.status}`)} · +{file.additions} −{file.deletions}
              </span>
            </summary>
            {file.oldPath ? (
              <p>
                {file.oldPath} → {file.path}
              </p>
            ) : null}
            {file.binary || file.tooLarge ? (
              <p>{t(file.binary ? "projectStructure.binary" : "projectStructure.diffLimited")}</p>
            ) : (
              file.hunks.map((hunk, index) => (
                <pre key={`${hunk.header}-${index}`}>
                  <span className="project-diff-hunk">
                    {hunk.header}
                    {"\n"}
                  </span>
                  {hunk.lines.map((line, index) => (
                    <span key={index} className={`project-diff-${line.type}`}>
                      {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
                      {line.text}
                      {"\n"}
                    </span>
                  ))}
                </pre>
              ))
            )}
          </details>
        ))
      )}
      {diff.truncated ? <p>{t("projectStructure.diffLimited")}</p> : null}
    </div>
  );
}
