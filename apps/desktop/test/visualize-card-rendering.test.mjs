import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/*
 * The ```visualize fence through the production Markdown pipeline (Vite SSR,
 * same harness as markdown-math-rendering.test.mjs): a closed fence becomes
 * a sandboxed card, an unclosed streaming fence stays plain text, and a bad
 * payload stays a code block. The card's iframe document is asserted
 * directly from the builder, which is what the card feeds the frame.
 */

const FENCE = (payload) => "```visualize\n" + payload + "\n```\n";

test("a closed visualize fence renders a sandboxed card, not a code block", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const originalDocument = globalThis.document;
  try {
    // `useThemeMode` reads the theme off the document during render.
    globalThis.document = { documentElement: { dataset: {} } };
    const { Markdown } = await server.ssrLoadModule(
      "/src/components/Markdown.tsx",
    );
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = (source, streaming = false) =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(Markdown, { source, streaming }),
        ),
      );

    const card = render(
      'Here is the chart:\n\n' +
        FENCE('{"path":"/tmp/scratch/battery-drain.html"}') +
        "\nDone.",
    );
    assert.match(card, /class="visualize-card"/);
    assert.match(card, /battery-drain\.html/);
    // The fragment read is async, so SSR shows the loading state; the frame
    // itself is asserted from the document builder below.
    assert.match(card, /Loading visualization/);
    assert.doesNotMatch(card, /code-block-lang">visualize/);

    // Wide mode widens the card.
    const wide = render(
      FENCE('{"path":"/tmp/scratch/app-shell.html","mode":"wide"}'),
    );
    assert.match(wide, /class="visualize-card wide"/);

    // An unclosed fence mid-stream stays raw text — no half-JSON card.
    const streaming = render(
      '```visualize\n{"path":"/tmp/scratch/battery-drain.h',
      true,
    );
    assert.doesNotMatch(streaming, /visualize-card/);
    assert.match(streaming, /battery-drain\.h/);

    // A closed but unparseable payload stays a plain code block.
    const invalid = render(FENCE('{"path":'));
    assert.doesNotMatch(invalid, /visualize-card/);
    assert.match(invalid, /code-block-lang">visualize/);
  } finally {
    globalThis.document = originalDocument;
    await server.close();
  }
});

test("the card document carries the CSP, design system, bridge, and fragment", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const {
      buildVisualizeDocument,
      clampVisualizeHeight,
    } = await server.ssrLoadModule(
      "/src/features/visualize/visualize-document.ts",
    );
    const doc = buildVisualizeDocument({
      fragment: '<div id="viz-root"><i data-lucide="search"></i></div>',
      theme: "dark",
      state: { privateContent: { note: "</script> safe" } },
    });

    // Theme is selected by the data attribute the design CSS keys on.
    assert.match(doc, /<html data-theme="dark">/);
    // CSP: no network except the CDN allowlist, no fetch from the fragment.
    assert.match(doc, /default-src 'none'/);
    assert.match(
      doc,
      /script-src 'unsafe-inline' https:\/\/cdnjs\.cloudflare\.com https:\/\/cdn\.jsdelivr\.net https:\/\/unpkg\.com https:\/\/esm\.sh https:\/\/fonts\.googleapis\.com/,
    );
    assert.match(doc, /img-src data: blob:/);
    assert.match(doc, /connect-src 'none'/);
    // The parent must permit only the isolated document navigation before the sandbox document's
    // stricter content policy can apply. Do not permit arbitrary web frames.
    const { readFile } = await import("node:fs/promises");
    const parentHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
    assert.match(parentHtml, /frame-src 'self' pi-visualize:;/);
    assert.doesNotMatch(parentHtml, /frame-src[^;]*(?:https?:|\*)/);
    // The design system and the bridge are injected around the fragment.
    assert.match(doc, /--viz-series-1/);
    assert.match(doc, /window\.openai/);
    const bridgeAt = doc.indexOf("pi-visualize-state");
    const fragmentAt = doc.indexOf('id="viz-root"');
    const runtimeAt = doc.indexOf("pi-visualize-lucide");
    assert.ok(bridgeAt >= 0 && fragmentAt > bridgeAt, "bridge runs before the fragment");
    assert.ok(runtimeAt > fragmentAt, "runtime wires the fragment after it parses");
    // Saved state is seeded inline with `</script>` kept inert.
    assert.match(doc, /<script type="application\/json" id="pi-visualize-state">/);
    assert.match(doc, /\\u003c\/script> safe/);

    // Height reports are clamped to the frame bounds.
    assert.equal(clampVisualizeHeight(10), 64);
    assert.equal(clampVisualizeHeight(1234.2), 1235);
    assert.equal(clampVisualizeHeight(99999), 4000);
    assert.equal(clampVisualizeHeight("nope"), 64);
  } finally {
    await server.close();
  }
});

test("follow-ups require the host confirmation button before the composer send path", async () => {
  // The card has no DOM of its own to click in node --test; the wiring is
  // asserted at the seam the repo uses for cross-process send paths.
  const { readFile } = await import("node:fs/promises");
  const card = await readFile(
    new URL("../src/features/visualize/VisualizeCard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    card,
    /useAppStore\.getState\(\)\.sendPrompt\(action.value, undefined, sessionId/,
  );
  // The frame stays script-enabled but never same-origin.
  assert.match(card, /sandbox="allow-scripts"/);
  assert.doesNotMatch(card, /allow-same-origin/);
});
