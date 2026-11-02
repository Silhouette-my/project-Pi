import { useState } from "react";
import { openProjectAgentPanel } from "../../features/project-panel/project-panel-actions";
import { IconPlus } from "../icons";
import { AnchoredMenu } from "../settings/AnchoredMenu";
import { TooltipButton, cx } from "../ui";

/**
 * "+" in a project context: the launcher's tools need a session of their own,
 * so the project's "+" brings back the project Agent.
 */
export function ProjectNewTabMenu({
  projectId,
  agentOpen,
  t,
}: {
  projectId: string | undefined;
  agentOpen: boolean;
  t: (key: string) => string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <AnchoredMenu
      className="work-panel-tab-plus-wrap"
      open={open}
      onClose={() => setOpen(false)}
      menuClassName="composer-mode-menu work-return-menu"
      label={t("panel.new.open")}
      role="menu"
      align="end"
      side="bottom"
      trigger={(ref) => (
        <TooltipButton
          ref={ref}
          type="button"
          className="work-panel-new-tab work-panel-tab-plus"
          tooltip={t("panel.new.open")}
          ariaLabel={t("panel.new.open")}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <IconPlus size={16} />
        </TooltipButton>
      )}
    >
      <button
        type="button"
        role="menuitemradio"
        aria-checked={agentOpen}
        disabled={!projectId}
        className={cx("composer-plus-item", agentOpen && "active")}
        data-work-panel-new-agent
        onClick={() => {
          setOpen(false);
          if (projectId) openProjectAgentPanel(projectId);
        }}
      >
        <span className="flex-1 text-left">{t("projectPanel.agentTab")}</span>
      </button>
    </AnchoredMenu>
  );
}
