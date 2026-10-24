import { useEffect, useRef } from "react";
import { useAppStore } from "../../stores/app-store";
import { isRemoteSession } from "../../lib/remote-session-safety";
import {
  projectAgentWorkPanelTab,
  shouldDefaultOpenProjectAgent,
  workPanelContextKey,
} from "../../lib/project-panel";
import { requestWorkPanelNavigationReveal } from "../../lib/work-panel-navigation-reveal";
import { workflowContextProjectId } from "../project-workflow/navigation-model";
import { useProjectWorkflow } from "../project-workflow/useProjectWorkflow";
import { useWorkflowProjectGroups } from "../project-workflow/WorkflowNavigation";
import { noteProjectConversation } from "./project-agent-return";

/**
 * Navigation-driven default open of the project Agent (ADR 0033 amendment,
 * ADR auto-hide-side-panels).
 *
 * Entering the project page, or selecting a chat that belongs to a workflow
 * project, adds the project Agent tab to the context being presented and opens
 * the panel. A panel that is docked opens in place; an auto-hidden one is
 * revealed once by `useSidePanelReveal`. The rule never fires from an agent or
 * tool event: it runs once per visit to a context, keyed by page and context,
 * and only reads navigation state. A context whose user closed the tab keeps
 * it closed (see `shouldDefaultOpenProjectAgent`).
 */
export function useProjectPanelDefaults(): void {
  const page = useAppStore((state) => state.page);
  const projectConsoleId = useAppStore((state) => state.projectConsoleId);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const selectingSessionId = useAppStore((state) => state.selectingSessionId);
  const session = useAppStore((state) =>
    state.sessions.find((item) => item.id === state.activeSessionId),
  );
  const { snapshot } = useProjectWorkflow();
  const { groups } = useWorkflowProjectGroups(session?.projectPath);
  const handledVisit = useRef<string | null>(null);

  // The project Agent returns into "the conversation the user came from", so
  // remember which project conversation was last on screen.
  useEffect(() => {
    if (page !== "chat" || !session || !snapshot || isRemoteSession(session)) return;
    const projectId = workflowContextProjectId(snapshot, groups, session);
    if (!projectId) return;
    const agentSessionId = snapshot.projectAgents?.find((agent) => agent.projectId === projectId)
      ?.sessionId;
    if (session.id !== agentSessionId) noteProjectConversation(projectId, session.id);
  }, [groups, page, session, snapshot]);

  useEffect(() => {
    if (page !== "project" && page !== "chat") {
      // Settings, Plugins and Scheduled keep no default of their own; coming
      // back is a new visit.
      handledVisit.current = null;
      return;
    }
    const contextKey = workPanelContextKey({ page, projectConsoleId, activeSessionId });
    if (!contextKey) return;
    const visit = `${page}:${contextKey}`;
    if (handledVisit.current === visit) return;
    const store = useAppStore.getState();
    const tabsOf = () => store.workPanelTabs;

    if (page === "project" && projectConsoleId) {
      const adds = shouldDefaultOpenProjectAgent({
        contextKey,
        projectId: projectConsoleId,
        tabs: tabsOf(),
      });
      if (adds) {
        store.openWorkPanelTabForSession(contextKey, projectAgentWorkPanelTab(projectConsoleId));
      } else {
        store.openWorkPanel();
      }
      handledVisit.current = visit;
      requestWorkPanelNavigationReveal(contextKey);
      return;
    }

    // A chat: wait until an in-flight selection (and its revalidation) is done, and for the data
    // that says whether the session belongs to a project at all.
    if (!session || !snapshot) return;
    if (selectingSessionId) return;
    if (isRemoteSession(session)) {
      handledVisit.current = visit;
      return;
    }
    const projectId = workflowContextProjectId(snapshot, groups, session);
    if (!projectId) return;
    const agentSessionId = snapshot.projectAgents?.find((agent) => agent.projectId === projectId)
      ?.sessionId;
    const adds = shouldDefaultOpenProjectAgent({
      contextKey,
      projectId,
      sessionId: session.id,
      agentSessionId,
      tabs: tabsOf(),
    });
    handledVisit.current = visit;
    if (!adds) return;
    store.openWorkPanelTabForSession(contextKey, projectAgentWorkPanelTab(projectId));
    requestWorkPanelNavigationReveal(contextKey);
  }, [activeSessionId, groups, page, projectConsoleId, selectingSessionId, session, snapshot]);
}
