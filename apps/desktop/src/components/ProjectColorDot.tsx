import type { AccentPresetId } from "@pi-desktop/shared";
import { projectAccentStyle } from "../lib/project-accent";

/**
 * Small colour dot for project colour menu rows. Without `color` it shows the
 * live theme colour as a ring ("follow theme colour").
 */
export function ProjectColorDot({ color }: { color?: AccentPresetId }) {
  return (
    <span
      className={color ? "project-color-dot" : "project-color-dot is-theme"}
      style={projectAccentStyle(color)}
      aria-hidden="true"
    />
  );
}
