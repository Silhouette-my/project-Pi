import type { AppSettings } from "@pi-desktop/shared";

/**
 * Resolve whether shell calls stay outside the tool groups they run among.
 *
 * `keepCommandsExpanded` is the preference; an absent value means `true`, so an
 * existing install keeps the scannable command rows it has today. This is a
 * presentation preference only: it never changes what a tool received, what it
 * returned, stored history, export, or the copy payload.
 *
 * It also never decides whether a turn renders a process disclosure. Both
 * values render exactly one, and only the placement of run rows inside it
 * changes.
 */
export function resolveKeepCommandsExpanded(
  settings: Pick<AppSettings, "keepCommandsExpanded"> | null | undefined,
): boolean {
  return settings?.keepCommandsExpanded !== false;
}
