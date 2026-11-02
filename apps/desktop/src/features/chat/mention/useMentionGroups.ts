/**
 * The mention list for one Composer: store state in, grouped rows out. The
 * rules live in `mention-core.ts`; this hook only gathers what they need.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../stores/app-store";
import type { WorkPanelTab } from "../../../lib/work-panel-tabs";
import { listableSessions } from "../../../lib/session-origin";
import { buildMentionCandidates, type MentionGroup } from "./mention-core";

/** Side chat session id → parent session id, from every open side-chat tab. */
export function sideChatParentsOf(
  tabLists: ReadonlyArray<ReadonlyArray<WorkPanelTab>>,
): Record<string, string> {
  const parents: Record<string, string> = {};
  for (const tabs of tabLists) {
    for (const tab of tabs) {
      if (tab.kind === "sidechat" && tab.resource && tab.sideChat) {
        parents[tab.resource] = tab.sideChat.parentSessionId;
      }
    }
  }
  return parents;
}

const NO_GROUPS: MentionGroup[] = [];

export function useMentionGroups({
  enabled,
  query,
  currentSessionId,
  currentProjectPath,
}: {
  enabled: boolean;
  query: string;
  currentSessionId?: string | null;
  currentProjectPath?: string | null;
}): MentionGroup[] {
  const { t } = useTranslation();
  const sessions = useAppStore((state) => state.sessions);
  const tabs = useAppStore((state) => state.workPanelTabs);
  const contexts = useAppStore((state) => state.workPanelContexts);
  return useMemo(() => {
    if (!enabled) return NO_GROUPS;
    return buildMentionCandidates({
      sessions: listableSessions(sessions),
      currentSessionId,
      currentProjectPath,
      query,
      sideChatParents: sideChatParentsOf([tabs, ...Object.values(contexts).map((c) => c.tabs)]),
      sideLabel: (title) => t("mention.sideOf", { title }),
    });
  }, [enabled, sessions, tabs, contexts, currentSessionId, currentProjectPath, query, t]);
}
