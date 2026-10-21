import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ProjectArchitectureArtifact,
  ProjectArchitectureSnapshot,
  ProjectArchitectureSource,
  ProjectGitSnapshot,
  ProjectStructureFile,
} from "@pi-desktop/shared";
import { Badge, Button, Field, Select } from "../../components/ui";
import { api } from "../../lib/api";
import { useThemeMode } from "../../lib/use-theme-mode";
import { VISUALIZE_FRAME_URL } from "../../../electron/shared/visualize-frame";
import { architectureRevisionState } from "./architecture-structure-model";
import { buildVisualizeDocument } from "../visualize/visualize-document";

export function ArchitectureStructureView({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<ProjectArchitectureSnapshot>();
  const [git, setGit] = useState<ProjectGitSnapshot>();
  const [selectedId, setSelectedId] = useState("");
  const [artifactFile, setArtifactFile] = useState<ProjectStructureFile>();
  const [source, setSource] = useState<ProjectArchitectureSource>();
  const [sourceFile, setSourceFile] = useState<ProjectStructureFile>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setSnapshot(undefined);
    setGit(undefined);
    setError("");
    void Promise.all([
      api.projectStructure.architectureSnapshot({ projectId }),
      api.projectStructure.gitSnapshot({ projectId }),
    ])
      .then(([architecture, repository]) => {
        if (!cancelled) {
          setSnapshot(architecture);
          setGit(repository);
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, revision]);
  const identity = (item: ProjectArchitectureArtifact) => `${item.rootId}|${item.relativePath}`;
  const artifact =
    snapshot?.artifacts.find((item) => identity(item) === selectedId) ??
    snapshot?.artifacts.find((item) => item.kind === "html") ??
    snapshot?.artifacts[0];
  useEffect(() => {
    let cancelled = false;
    setArtifactFile(undefined);
    setSource(undefined);
    setSourceFile(undefined);
    if (!artifact) return;
    setError("");
    void api.projectStructure
      .readFile({
        projectId,
        rootId: artifact.rootId,
        relativePath: artifact.relativePath,
        kind: "artifact",
      })
      .then((value) => {
        if (!cancelled) setArtifactFile(value);
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, artifact?.rootId, artifact?.relativePath, revision]);
  useEffect(() => {
    let cancelled = false;
    setSourceFile(undefined);
    if (!source || !artifact) return;
    setError("");
    void api.projectStructure
      .readFile({ projectId, rootId: artifact.rootId, relativePath: source.path, kind: "source" })
      .then((value) => {
        if (!cancelled) setSourceFile(value);
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, artifact?.rootId, source]);
  const repo = git?.repositories.find((item) => item.rootId === artifact?.rootId);
  const revisionState = artifact ? architectureRevisionState(artifact, repo) : "unknown";
  return (
    <section className="project-architecture" data-project-structure="architecture">
      <div className="project-structure-filters">
        <Field label={t("projectStructure.architectureFile")}>
          <Select
            value={artifact ? identity(artifact) : ""}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {snapshot?.artifacts.map((item) => (
              <option value={identity(item)} key={identity(item)}>
                {snapshot.roots.find((root) => root.rootId === item.rootId)?.label} ·{" "}
                {item.relativePath}
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
      {snapshot?.errors.map((item) => (
        <p role="alert" className="workflow-error" key={`${item.rootId}-${item.relativePath}`}>
          {item.relativePath ?? item.rootId}: {item.message}
        </p>
      ))}
      {!snapshot ? (
        <p role="status">{t("workflow.loading")}</p>
      ) : !artifact ? (
        <div className="workflow-empty">
          <strong>{t("projectStructure.noArchitecture")}</strong>
          <p>{t("projectStructure.architectureLocation")}</p>
        </div>
      ) : (
        <>
          <div className="project-architecture-meta">
            <div>
              <strong>{artifact.title || artifact.relativePath}</strong>
              <small>
                {artifact.relativePath} · {new Date(artifact.modifiedAt).toLocaleString()}
              </small>
            </div>
            <Badge>
              {t(
                revisionState === "unknown"
                  ? "projectStructure.revisionUnknown"
                  : revisionState === "stale"
                    ? "projectStructure.stale"
                    : "projectStructure.revisionMatches",
              )}
            </Badge>
          </div>
          {artifact.repositoryRevision ? (
            <p className="workflow-muted">
              {t("projectStructure.generatedRevision")}: <code>{artifact.repositoryRevision}</code>
              {repo?.head ? (
                <>
                  {" "}
                  · {t("projectStructure.currentRevision")}: <code>{repo.head.slice(0, 10)}</code>
                </>
              ) : null}
            </p>
          ) : null}
          {!artifactFile ? (
            <p role="status">{t("workflow.loading")}</p>
          ) : artifactFile.truncated ? (
            <p role="alert">{t("projectStructure.fileLimited")}</p>
          ) : artifactFile.language === "html" ? (
            <ArchitecturePreview
              key={identity(artifact)}
              content={artifactFile.content}
              title={artifact.title || artifact.relativePath}
            />
          ) : (
            <pre className="project-architecture-json">{artifactFile.content}</pre>
          )}
          {artifact.sources.length ? (
            <section className="project-architecture-sources">
              <h3>{t("projectStructure.sourceReferences")}</h3>
              <p className="workflow-muted">{t("projectStructure.currentSourceHint")}</p>
              <div className="project-source-links">
                {artifact.sources.map((item, index) => (
                  <Button
                    variant="ghost"
                    key={`${item.path}-${item.line}-${index}`}
                    aria-pressed={source === item}
                    onClick={() => setSource(item)}
                  >
                    <code>
                      {item.path}:{item.line}
                      {item.endLine ? `–${item.endLine}` : ""}
                    </code>
                  </Button>
                ))}
              </div>
            </section>
          ) : null}
          {source ? (
            <section className="project-source" data-project-source={source.path}>
              <h3>
                {source.path}:{source.line}
                {source.endLine ? `–${source.endLine}` : ""}{" "}
                <Badge>{t("projectStructure.currentWorkingFile")}</Badge>
              </h3>
              {sourceFile ? (
                <SourceExcerpt file={sourceFile} source={source} />
              ) : (
                <p role="status">{t("workflow.loading")}</p>
              )}
            </section>
          ) : null}
        </>
      )}
      {snapshot?.truncated ? <p>{t("projectStructure.discoveryLimited")}</p> : null}
    </section>
  );
}

/** The existing host-owned pi-visualize origin and opaque script sandbox are mandatory. */
function ArchitecturePreview({ content, title }: { content: string; title: string }) {
  const theme = useThemeMode();
  const frame = useRef<HTMLIFrameElement>(null);
  const document = useMemo(
    () => buildVisualizeDocument({ fragment: content, theme, state: null }),
    [content, theme],
  );
  useEffect(() => {
    frame.current?.contentWindow?.postMessage(
      { source: "pi-visualize-host", type: "theme", theme },
      "*",
    );
  }, [theme]);
  return (
    <iframe
      ref={frame}
      className="project-architecture-frame"
      title={title}
      sandbox="allow-scripts"
      src={VISUALIZE_FRAME_URL}
      onLoad={() =>
        frame.current?.contentWindow?.postMessage(
          { source: "pi-visualize-host", type: "initialize", document },
          "*",
        )
      }
    />
  );
}
function SourceExcerpt({
  file,
  source,
}: {
  file: ProjectStructureFile;
  source: ProjectArchitectureSource;
}) {
  const { t } = useTranslation();
  const first = Math.max(1, source.line - 4);
  const last = Math.min(file.content.split("\n").length, (source.endLine ?? source.line) + 4);
  return (
    <>
      {file.truncated ? <p>{t("projectStructure.fileLimited")}</p> : null}
      <pre>
        {file.content
          .split("\n")
          .slice(first - 1, last)
          .map((line, index) => (
            <span
              key={first + index}
              className={
                first + index >= source.line && first + index <= (source.endLine ?? source.line)
                  ? "is-highlighted"
                  : ""
              }
            >
              <span className="project-source-line-number">{first + index}</span>
              {line}
              {"\n"}
            </span>
          ))}
      </pre>
    </>
  );
}
