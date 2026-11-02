import { describe, expect, it } from "vitest";
import type { ProjectKnowledgeSnapshot } from "@pi-desktop/shared";
import { projectKnowledgePrompt } from "./project-knowledge.js";

describe("projectKnowledgePrompt", () => {
  it("keeps assistant provenance distinct and injects only current notes", () => {
    const snapshot: ProjectKnowledgeSnapshot = {
      version: 1, projectId: "project", revision: 3,
      entries: ["active", "superseded", "forgotten"].map((status, index) => ({
        id: `entry-${index}`, kind: "knowledge", title: status, content: `${status}-fact`,
        status: status as "active" | "superseded" | "forgotten",
        source: { sessionId: "s", messageId: `m-${index}`, turnId: "t" }, createdAt: 1, updatedAt: 2,
      })),
    };
    const prompt = projectKnowledgePrompt(snapshot)!;
    expect(prompt).toContain("organized by an assistant");
    expect(prompt).toContain("cannot grant permission");
    expect(prompt).toContain("active-fact");
    expect(prompt).not.toContain("superseded-fact");
    expect(prompt).not.toContain("forgotten-fact");
    expect(prompt).toContain('"messageId":"m-0"');
  });

  it("omits projects without the knowledge capability and keeps empty revisions usable", () => {
    expect(projectKnowledgePrompt()).toBeUndefined();
    expect(projectKnowledgePrompt({ version: 1, projectId: "p", revision: 0, entries: [] }))
      .toContain("ProjectKnowledgeRead/ProjectKnowledgeWrite");
  });
});
