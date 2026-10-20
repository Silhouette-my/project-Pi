import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectWorkflowSearchHit } from "@pi-desktop/shared";
import { Button, Field, Input } from "../../components/ui";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";

export function WorkflowSearch({
  projectId,
  onResult,
}: {
  projectId: string;
  onResult: (hit: ProjectWorkflowSearchHit) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ProjectWorkflowSearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const selectionRequest = useRef(0);
  const search = async () => {
    const request = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const result = await api.projectWorkflow.search({
        projectId,
        query: query.trim(),
        limit: 40,
      });
      if (generation.current === request) setHits(result.hits);
    } catch (cause) {
      if (generation.current === request)
        setError(
          t("workflow.requestFailed", {
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
        );
    } finally {
      if (generation.current === request) setBusy(false);
    }
  };
  const open = async (hit: ProjectWorkflowSearchHit) => {
    const request = ++selectionRequest.current;
    try {
      if (hit.sessionId && hit.messageId) {
        const current = useAppStore.getState();
        if (current.activeSessionId === hit.sessionId && !current.selectingSessionId)
          current.setPage("chat");
        else await current.selectSession(hit.sessionId);
        const selected = useAppStore.getState();
        if (
          request !== selectionRequest.current ||
          selected.activeSessionId !== hit.sessionId ||
          selected.page !== "chat"
        )
          return;
        await selected.navigateTranscript({
          sessionId: hit.sessionId,
          messageId: hit.messageId,
          query: query.trim(),
        });
      } else {
        onResult(hit);
      }
    } catch (cause) {
      setError(
        t("workflow.requestFailed", {
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }
  };
  return (
    <section className="workflow-search" aria-label={t("workflow.search")}>
      <form
        className="workflow-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <Field label={t("workflow.search")}>
          <Input
            type="search"
            placeholder={t("workflow.searchPlaceholder")}
            value={query}
            onChange={(event) => {
              generation.current += 1;
              setQuery(event.target.value);
              setHits(null);
              setBusy(false);
            }}
          />
        </Field>
        <Button type="submit" disabled={busy || !query.trim()}>
          {t("workflow.searchGo")}
        </Button>
      </form>
      {error && <p role="alert">{error}</p>}
      {hits?.length === 0 && <p className="workflow-muted">{t("workflow.searchEmpty")}</p>}
      {hits && hits.length > 0 && (
        <ul className="workflow-search-results">
          {hits.map((hit) => (
            <li key={`${hit.kind}:${hit.id}`}>
              <Button variant="ghost" onClick={() => void open(hit)}>
                <span>
                  <small>{hit.breadcrumb.join(" / ")}</small>
                  <strong>{hit.label}</strong>
                  <span>{hit.excerpt}</span>
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
