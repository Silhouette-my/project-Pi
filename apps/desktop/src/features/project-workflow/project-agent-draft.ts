import { useState } from "react";

// Project drafts are not session drafts: the session cache prunes keys when
// sessions refresh, so keep this equally transient project-owned slot separate.
const drafts = new Map<string, string>();

export function useProjectAgentDraft(projectId: string) {
  const [draft, setDraft] = useState(() => ({ projectId, text: drafts.get(projectId) ?? "" }));
  const text = draft.projectId === projectId ? draft.text : drafts.get(projectId) ?? "";
  const update = (next: string) => {
    if (next) drafts.set(projectId, next);
    else drafts.delete(projectId);
    setDraft({ projectId, text: next });
  };
  return [text, update] as const;
}
