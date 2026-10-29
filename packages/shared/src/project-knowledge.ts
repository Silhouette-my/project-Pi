/** Assistant-maintained project notes. These never replace user-authored memory. */
export type ProjectKnowledgeKind = "state" | "decision" | "knowledge";
export type ProjectKnowledgeStatus = "active" | "superseded" | "forgotten";

export type ProjectKnowledgeEntry = {
  id: string;
  kind: ProjectKnowledgeKind;
  title: string;
  content: string;
  status: ProjectKnowledgeStatus;
  source: { sessionId: string; messageId: string; turnId: string };
  createdAt: number;
  updatedAt: number;
  supersedesId?: string;
};

export type ProjectKnowledgeSnapshot = {
  version: 1;
  projectId: string;
  revision: number;
  entries: ProjectKnowledgeEntry[];
};

export const PROJECT_KNOWLEDGE_LIMITS = {
  titleChars: 160,
  contentBytes: 4096,
  activeBytes: 16384,
  activeEntries: 40,
  storedBytes: 1048576,
} as const;
