/** The browser session stays in Electron; only conversation data crosses RPC. */
export interface ChatGptChatProbeDiagnostic {
  endpoint: string;
  status: number | null;
  contentType: string | null;
  reason: string;
}

export interface ChatGptChatStatus {
  loggedIn: boolean;
  state: "signed_out" | "checking" | "challenge" | "error" | "signed_in";
  message?: string;
  diagnostic?: ChatGptChatProbeDiagnostic & { checks?: ChatGptChatProbeDiagnostic[] };
}

/** Only public selection metadata may leave the account browser. */
export interface ChatGptChatModelCatalog {
  models: Array<{ id: string; name: string; description?: string; defaultThinkingEffort?: string; thinkingEfforts?: string[] }>;
  defaultModelId?: string;
}

export interface ChatGptConversationOpenParams {
  requestId: string;
  body: Record<string, unknown>;
}

export interface ChatGptConversationCancelParams {
  requestId: string;
}

export type ChatGptConversationNotification =
  | { method: "chatgpt.conversation.chunk"; params: { requestId: string; chunk: string } }
  | { method: "chatgpt.conversation.end"; params: { requestId: string } }
  | { method: "chatgpt.conversation.error"; params: { requestId: string; error: string } };

export const CHATGPT_CHAT_BASE_URL = "https://chatgpt.com/backend-api";
