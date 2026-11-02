import type { WorkflowWorkstream } from "@pi-desktop/shared";

type Translate = (key: string, options?: Record<string, unknown>) => string;
type SessionTitle = { id: string; title?: string };

const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Record identifiers are references, not names; they never become visible copy. */
export function isOpaqueId(value: string): boolean {
  return OPAQUE_ID.test(value.trim());
}

/**
 * Human label for a workstream owner. A conversation owner resolves to that
 * conversation's title; an unresolved or opaque reference falls back to the
 * owner kind so a raw id never reaches the page.
 */
export function workflowOwnerLabel(
  owner: WorkflowWorkstream["owner"],
  sessions: readonly SessionTitle[],
  t: Translate,
): string {
  const kind = t(`workflow.ownerKinds.${owner.kind}`);
  if (owner.kind === "session") {
    const title = sessions.find((session) => session.id === owner.ref)?.title?.trim();
    return title || kind;
  }
  return owner.ref.trim() && !isOpaqueId(owner.ref) ? owner.ref : kind;
}

/** Local, readable time for record metadata; the exact value stays in the tooltip. */
export function formatWorkflowTime(value: string, locale?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
