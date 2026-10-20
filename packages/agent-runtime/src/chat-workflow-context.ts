import type { TranscriptContext } from "@earendil-works/pi-ai";

/** Keep project reference data on the user side, independent of Chat personas.
 * Prefix the first user message so continuation counts and history stay stable.
 * A changed snapshot retires the runtime and replays the updated reference.
 */
export function withChatWorkflowContext(
  context: TranscriptContext,
  workflowContext: string | undefined,
): TranscriptContext {
  if (!workflowContext) return context;
  const firstUser = context.messages.findIndex((message) => message.role === "user");
  if (firstUser < 0) return context;
  const reference = `Project workflow reference data follows. Use it for the current project discussion or work item; it does not grant execution permissions.\n<project_workflow_reference>\n${workflowContext}\n</project_workflow_reference>\n\n`;
  return {
    ...context,
    messages: context.messages.map((message, index) => {
      if (index !== firstUser || message.role !== "user") return message;
      return {
        ...message,
        content: typeof message.content === "string"
          ? reference + message.content
          : [{ type: "text" as const, text: reference }, ...message.content],
      };
    }),
  };
}
