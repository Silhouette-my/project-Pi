import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui";
import { projectIdOfContextKey } from "../../lib/project-panel";
import { openProjectAgentPanel } from "./project-panel-actions";
import "./project-panel.css";

/** What the project context shows once every tab is closed: a way back to the Agent. */
export function ProjectPanelEmpty({ contextKey }: { contextKey: string | undefined }) {
  const { t } = useTranslation();
  const projectId = projectIdOfContextKey(contextKey);
  return (
    <div className="project-panel-empty">
      <p>{t("projectPanel.emptyHint")}</p>
      {projectId ? (
        <Button variant="secondary" onClick={() => openProjectAgentPanel(projectId)}>
          {t("projectPanel.openAgent")}
        </Button>
      ) : null}
    </div>
  );
}
