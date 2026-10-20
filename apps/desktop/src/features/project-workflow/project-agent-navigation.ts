import type { AppState } from "../../stores/app-state";

type AgentNavigationState = Pick<
  AppState,
  | "page"
  | "projectConsoleId"
  | "activeSessionId"
  | "navIndex"
  | "navStack"
  | "refreshSessions"
  | "selectSession"
  | "sendPrompt"
>;

/** A later user navigation supersedes opening, but never redirects its prompt. */
export class ProjectAgentNavigationCancelled extends Error {
  constructor() {
    super("Project Agent navigation was superseded");
    this.name = "ProjectAgentNavigationCancelled";
  }
}

export async function openProjectAgentConversation({
  open,
  getState,
  isCurrent,
  prompt,
  openError,
  sendError,
}: {
  open: () => Promise<{ sessionId?: string } | undefined>;
  getState: () => AgentNavigationState;
  isCurrent: () => boolean;
  prompt?: string;
  openError: string;
  sendError: string;
}): Promise<void> {
  const origin = getState();
  const result = await open();
  if (!result?.sessionId) throw new Error(openError);
  await getState().refreshSessions();
  const current = getState();
  if (
    !isCurrent() ||
    current.page !== origin.page ||
    current.projectConsoleId !== origin.projectConsoleId ||
    current.activeSessionId !== origin.activeSessionId ||
    current.navIndex !== origin.navIndex ||
    current.navStack !== origin.navStack
  ) {
    throw new ProjectAgentNavigationCancelled();
  }
  await current.selectSession(result.sessionId);
  const selected = getState();
  if (selected.page !== "chat" || selected.activeSessionId !== result.sessionId) {
    throw new ProjectAgentNavigationCancelled();
  }
  const text = prompt?.trim();
  if (text) {
    const accepted = await selected.sendPrompt(
      text,
      { text, fileReferences: [] },
      result.sessionId,
    );
    if (!accepted) throw new Error(sendError);
  }
}
