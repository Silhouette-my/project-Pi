/** The sole built-in document served to sandboxed transcript visualization frames. */
export const VISUALIZE_FRAME_SCHEME = "pi-visualize";
export const VISUALIZE_FRAME_URL = `${VISUALIZE_FRAME_SCHEME}://frame/index.html`;

export const VISUALIZE_CDN_ORIGINS = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://esm.sh",
  "https://fonts.googleapis.com",
] as const;

/** Applied as a response header, so fragment markup cannot remove this policy. */
export function visualizeFrameCsp(): string {
  const cdn = VISUALIZE_CDN_ORIGINS.join(" ");
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${cdn}`,
    `style-src 'unsafe-inline' ${cdn}`,
    "img-src data: blob:",
    `font-src ${cdn} https://fonts.gstatic.com`,
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
  ].join("; ");
}

/** No fragment or filesystem path enters the protocol request. */
export function visualizeFrameBootstrap(): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
(() => {
  const owner = window.parent;
  const initialize = (event) => {
    if (event.source !== owner || event.data === null || typeof event.data !== "object") return;
    const data = event.data;
    if (data.source !== "pi-visualize-host" || data.type !== "initialize" || typeof data.document !== "string") return;
    window.removeEventListener("message", initialize);
    document.open();
    document.write(data.document);
    document.close();
  };
  window.addEventListener("message", initialize);
})();
</script></body></html>`;
}
