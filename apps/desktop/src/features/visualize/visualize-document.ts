import designCss from "./assets/visualize-design.css?raw";
import runtimeJs from "./assets/visualize-runtime.js?raw";
import bridgeJs from "./assets/visualize-bridge.js?raw";

/*
 * Assembles the standalone HTML document a visualization card loads into its
 * sandboxed iframe: CSP, the design system, the host bridge, the
 * agent-authored fragment, then the runtime that wires the documented
 * behaviors (tabs, tooltips, carousel, Lucide).
 *
 * The document is handed to the iframe as a blob: URL rather than a srcdoc
 * attribute on purpose: a srcdoc document inherits the renderer's own CSP
 * (`default-src 'self'`), which would silently block the CDN scripts the
 * fragment and runtime load. A blob document carries only the CSP declared
 * here, and the iframe stays `sandbox="allow-scripts"` with no same-origin
 * access, so the fragment runs in an opaque origin either way.
 */

/** Origins a fragment may load scripts, styles, and fonts from. */
export const VISUALIZE_CDN_ORIGINS = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://esm.sh",
  "https://fonts.googleapis.com",
] as const;

/** Font files referenced by a Google Fonts stylesheet live on this origin. */
const FONT_FILE_ORIGIN = "https://fonts.gstatic.com";

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

function buildCsp(): string {
  const cdn = VISUALIZE_CDN_ORIGINS.join(" ");
  // 'unsafe-inline' is required for the injected runtime and for fragment
  // scripts and styles; network access stays limited to the CDN allowlist,
  // and connect-src 'none' keeps the fragment from exfiltrating data.
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${cdn}`,
    `style-src 'unsafe-inline' ${cdn}`,
    "img-src data: blob:",
    `font-src ${cdn} ${FONT_FILE_ORIGIN}`,
    "connect-src 'none'",
  ].join("; ");
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
    `<meta http-equiv="Content-Security-Policy" content="${buildCsp()}">`,
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
