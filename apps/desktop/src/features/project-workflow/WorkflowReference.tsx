import { useState, type HTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectWorkflowOpenReference } from "@pi-desktop/shared";
import { Button, Panel } from "../../components/ui";

export type WorkflowSurfaceProps = {
  projectId: string;
  workstreamId?: string;
  onOpenReference: (reference: Omit<ProjectWorkflowOpenReference, "projectId">) => Promise<void>;
};

export function WorkflowRecord({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props}>
      <Panel className={className}>{children}</Panel>
    </div>
  );
}

/** The owner supplies the permission-aware opener; a reference is never file authority. */
export function WorkflowReference({
  uri,
  reference,
  onOpenReference,
}: Pick<WorkflowSurfaceProps, "onOpenReference"> & {
  uri: string;
  reference: Omit<ProjectWorkflowOpenReference, "projectId">;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  async function open() {
    setOpening(true);
    setError(null);
    try {
      await onOpenReference(reference);
    } catch (cause) {
      setError(
        t("workflowContext.openFailed", {
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    } finally {
      setOpening(false);
    }
  }
  return (
    <div className="workflow-reference">
      <Button variant="ghost" disabled={opening} onClick={() => void open()} title={uri}>
        {uri}
      </Button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
