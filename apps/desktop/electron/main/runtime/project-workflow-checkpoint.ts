import { isProjectWorkflowCommand, type WorkflowArtifact, type WorkflowEvidence } from "@pi-desktop/shared";

export type WorkflowStep = { action: string; resources: string[]; prompt: string };
export type WorkflowCheckpoint = {
  summary: string; next?: WorkflowStep; stop: boolean;
  artifacts: WorkflowArtifact[]; evidence: WorkflowEvidence[];
  consumedDeliveryIds: string[];
};

/** Validate the model boundary once. Missing/invalid reports stop, not retry. */
export function parseWorkflowCheckpoint(content: string): WorkflowCheckpoint {
  const blocks = [...content.matchAll(/```project-workflow-checkpoint\s*\n([\s\S]*?)\n```/g)];
  if (blocks.length !== 1) throw new Error("Exactly one project-workflow-checkpoint is required");
  const value: unknown = JSON.parse(blocks[0][1]);
  if (!value || typeof value !== "object") throw new Error("Invalid workflow checkpoint");
  const input = value as Record<string, unknown>;
  if (typeof input.summary !== "string" || !input.summary.trim() || typeof input.stop !== "boolean"
    || !Array.isArray(input.artifacts) || !input.artifacts.every((artifact) => isProjectWorkflowCommand({ kind: "artifact.put", commandId: "validate", expectedRevision: 0, artifact }))
    || !Array.isArray(input.evidence) || !input.evidence.every((evidence) => isProjectWorkflowCommand({ kind: "evidence.add", commandId: "validate", expectedRevision: 0, evidence }))) {
    throw new Error("Invalid workflow checkpoint fields");
  }
  if (input.consumedDeliveryIds !== undefined && (!Array.isArray(input.consumedDeliveryIds)
    || !input.consumedDeliveryIds.every((entry) => typeof entry === "string"))) throw new Error("Invalid consumption acknowledgements");
  let next: WorkflowStep | undefined;
  if (input.next !== undefined) {
    if (!input.next || typeof input.next !== "object") throw new Error("Invalid workflow next step");
    const step = input.next as Record<string, unknown>;
    if (typeof step.action !== "string" || !step.action.trim() || typeof step.prompt !== "string" || !step.prompt.trim()
      || !Array.isArray(step.resources) || !step.resources.length || !step.resources.every((r) => typeof r === "string" && r.length > 0)) {
      throw new Error("Invalid workflow next step");
    }
    next = { action: step.action, prompt: step.prompt, resources: step.resources as string[] };
  }
  return { summary: input.summary, stop: input.stop, next, artifacts: input.artifacts as WorkflowArtifact[], evidence: input.evidence as WorkflowEvidence[],
    consumedDeliveryIds: input.consumedDeliveryIds as string[] | undefined ?? [] };
}
