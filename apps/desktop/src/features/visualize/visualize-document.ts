import designCss from "./assets/visualize-design.css?raw";
import runtimeJs from "./assets/visualize-runtime.js?raw";
import bridgeJs from "./assets/visualize-bridge.js?raw";

/*
 * Assembles the standalone HTML document a visualization card loads into its
 * sandboxed iframe: CSP, the design system, the host bridge, the
 * agent-authored fragment, then the runtime that wires the documented
 * behaviors (tabs, tooltips, carousel, Lucide).
 *
 * The document is initialized inside the host-owned pi-visualize frame. Its
 * response CSP is independent of the app document, and remains enforced when
 * the one-shot bootstrap writes this markup. The sandbox still has no
 * same-origin access.
 */

import { VISUALIZE_CDN_ORIGINS, visualizeFrameCsp } from "../../../electron/shared/visualize-frame";
export { VISUALIZE_CDN_ORIGINS };

const FLOATING_UI_CORE =
  "https://unpkg.com/@floating-ui/core@1.7.3/dist/floating-ui.core.umd.min.js";
const FLOATING_UI_DOM =
  "https://unpkg.com/@floating-ui/dom@1.7.4/dist/floating-ui.dom.umd.min.js";
const LUCIDE = "https://unpkg.com/lucide@1.17.0/dist/umd/lucide.js";

/**
 * Frame bounds the host accepts from the bridge's height reports. The floor
 * keeps an empty fragment clickable; the ceiling matches the block-renderer
 * clamp so a runaway card cannot tower over the transcript.
 */
export const VISUALIZE_MIN_HEIGHT_PX = 64;
export const VISUALIZE_MAX_HEIGHT_PX = 4000;

export function clampVisualizeHeight(height: unknown): number {
  const value =
    typeof height === "number" && Number.isFinite(height)
      ? Math.ceil(height)
      : 0;
  return Math.min(Math.max(value, VISUALIZE_MIN_HEIGHT_PX), VISUALIZE_MAX_HEIGHT_PX);
}

/** JSON safe for an inline `<script type="application/json">` element. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value ?? null).replace(/</g, "\\u003c");
}

export function buildVisualizeDocument({
  fragment,
  theme,
  state,
}: {
  fragment: string;
  theme: "light" | "dark";
  state: unknown;
}): string {
  return [
    "<!doctype html>",
    `<html data-theme="${theme === "light" ? "light" : "dark"}">`,
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${visualizeFrameCsp()}">`,
    `<style>${designCss}</style>`,
    "</head>",
    "<body>",
    // The bridge and its state seed run before the fragment so fragment
    // scripts can call window.openai.* during setup.
    `<script type="application/json" id="pi-visualize-state">${inlineJson(state)}</script>`,
    `<script>${bridgeJs}</script>`,
    fragment,
    `<script src="${FLOATING_UI_CORE}"></script>`,
    `<script src="${FLOATING_UI_DOM}"></script>`,
    `<script>${runtimeJs}</script>`,
    `<script id="pi-visualize-lucide" async src="${LUCIDE}"></script>`,
    "</body>",
    "</html>",
  ].join("\n");
}
