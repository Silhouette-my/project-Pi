import type { WorkPanelTab } from "./work-panel-tabs.ts";

/**
 * Project-scoped work-panel context (ADR auto-hide-side-panels amendment,
 * ADR project-structure-views).
 *
 * The work panel keeps one context per active session (ADR 0028). The project
 * page has no session, so it presents its own context keyed `project:<id>`.
 * It holds the project Agent tab and any project side-conversation tabs. A
 * session id never starts with this prefix, so the two key spaces cannot meet.
 */
export const PROJECT_PANEL_CONTEXT_PREFIX = "project:";

export function projectPanelContextKey(projectId: string): string {
  return `${PROJECT_PANEL_CONTEXT_PREFIX}${projectId}`;
}

export function isProjectPanelContextKey(key: string | undefined | null): boolean {
  return typeof key === "string" && key.startsWith(PROJECT_PANEL_CONTEXT_PREFIX);
}

/** The project a `project:<id>` key names. */
export function projectIdOfContextKey(key: string | undefined | null): string | undefined {
  return typeof key === "string" && isProjectPanelContextKey(key)
    ? key.slice(PROJECT_PANEL_CONTEXT_PREFIX.length)
    : undefined;
}

/**
 * The context the panel presents: the project's on the project page, the
 * active session's everywhere else. `undefined` means nothing to present.
 */
export function workPanelContextKey(input: {
  page: string;
  projectConsoleId?: string;
  activeSessionId?: string;
}): string | undefined {
  if (input.page === "project" && input.projectConsoleId) {
    return projectPanelContextKey(input.projectConsoleId);
  }
  return input.activeSessionId;
}

/** The project's canonical Agent session, rendered as a detached conversation. */
export function projectAgentWorkPanelTab(projectId: string, label?: string): WorkPanelTab {
  return {
    id: `project-agent:${projectId}`,
    kind: "project-agent",
    resource: projectId,
    ...(label ? { label } : {}),
  };
}

/** A project side conversation, keyed by its session so reopening reuses the tab. */
export function projectSideWorkPanelTab(sessionId: string, label?: string): WorkPanelTab {
  return {
    id: `project-side:${sessionId}`,
    kind: "project-side",
    resource: sessionId,
    ...(label ? { label } : {}),
  };
}

export function hasProjectAgentTab(tabs: readonly WorkPanelTab[], projectId: string): boolean {
  return tabs.some((tab) => tab.kind === "project-agent" && tab.resource === projectId);
}

/**
 * Contexts in which the user closed the project Agent tab. A default open must
 * not bring it back for that context: closing is an explicit choice. Renderer
 * memory only, like the contexts themselves.
 */
const closedAgentContexts = new Set<string>();

export function markProjectAgentTabClosed(contextKey: string): void {
  closedAgentContexts.add(contextKey);
}

export function wasProjectAgentTabClosed(contextKey: string): boolean {
  return closedAgentContexts.has(contextKey);
}

/** Forget a context (its session was deleted) or reset state in tests. */
export function forgetProjectAgentTabClosed(contextKey?: string): void {
  if (contextKey === undefined) closedAgentContexts.clear();
  else closedAgentContexts.delete(contextKey);
}

export type ProjectAgentDefaultInput = {
  /** The context being presented (`project:<id>` or a session id). */
  contextKey: string | undefined;
  /** The project the context belongs to, when it belongs to one. */
  projectId: string | undefined;
  /** The session being presented, absent on the project page. */
  sessionId?: string;
  /** The project's Agent session, once it exists. */
  agentSessionId?: string;
  /** Whether the session is a remote one (no local panel context). */
  remote?: boolean;
  tabs: readonly WorkPanelTab[];
};

/**
 * Whether entering a context should add the project Agent tab and open the
 * panel. Pure so the rule is testable: it never adds a tab twice, never adds
 * it where the user closed it, and never adds it to the Agent's own session
 * (the Agent tab would show the conversation the user is already in).
 */
export function shouldDefaultOpenProjectAgent(input: ProjectAgentDefaultInput): boolean {
  const { contextKey, projectId, sessionId, agentSessionId, remote, tabs } = input;
  if (!contextKey || !projectId || remote) return false;
  if (hasProjectAgentTab(tabs, projectId)) return false;
  if (sessionId && sessionId === agentSessionId) return false;
  // The project page re-presents the Agent on every entry; only session
  // contexts honour an earlier close.
  if (!isProjectPanelContextKey(contextKey) && wasProjectAgentTabClosed(contextKey)) return false;
  return true;
}
