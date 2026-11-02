import { useTranslation } from "react-i18next";
import type { WorkflowWorkstream } from "@pi-desktop/shared";
import { Badge } from "../../components/ui";
import { IconCheck } from "../../components/icons";

/** Acceptance conditions as one tile: a check per satisfied item, a badge only for reopened ones. */
export function WorkflowAcceptance({ workstream }: { workstream: WorkflowWorkstream }) {
  const { t } = useTranslation();
  const items = workstream.acceptance;
  if (!items.length) return null;
  const done = items.filter((item) => item.status === "satisfied").length;
  return (
    <section className="workflow-detail-block" aria-label={t("workflow.acceptance")}>
      <div className="project-section-label">
        <h3>{t("workflow.acceptance")}</h3>
        <span className="project-section-count">
          {done} / {items.length}
        </span>
      </div>
      <ul className="workflow-acceptance">
        {items.map((item) => (
          <li key={item.id}>
            <span
              className={`workflow-check is-${item.status}`}
              role="img"
              aria-label={t(`workflow.acceptanceStatus.${item.status}`)}
              title={t(`workflow.acceptanceStatus.${item.status}`)}
            >
              {item.status === "satisfied" ? <IconCheck size={10} /> : null}
            </span>
            <span>{item.title}</span>
            {item.status === "reopened" ? (
              <Badge>{t("workflow.acceptanceStatus.reopened")}</Badge>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
