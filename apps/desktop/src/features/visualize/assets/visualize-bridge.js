/*
 * Host bridge for in-conversation visualization cards. Runs inside the
 * sandboxed iframe (no same-origin access) before the agent-authored
 * fragment, and exposes the `window.openai` surface the visualize skill
 * documents:
 *
 *   - `widgetState` / `setWidgetState`: the host keeps the snapshot in
 *     session-lifetime memory only (Phase 1). It survives iframe remounts
 *     inside one app run — scrolling, re-renders — but NOT an app restart
 *     or transcript reload, and it is never sent to the model.
 *   - `sendFollowUpMessage`: posts the prompt straight into the composer
 *     send path for the owning session. The `title` is accepted and
 *     ignored; PI-Desktop shows no confirmation dialog.
 *   - `openExternal`: routes an http(s) link through the host's external
 *     opener.
 *
 * Messages are plain postMessage envelopes; the host validates the source
 * window and the `source` tag on both directions.
 */
(() => {
  const root = document.documentElement;
  const stateElement = document.getElementById("pi-visualize-state");
  let state = null;
  try {
    state = JSON.parse(stateElement?.textContent ?? "null");
  } catch {
    state = null;
  }
  stateElement?.remove();
  const post = (type, payload) => {
    try {
      globalThis.parent.postMessage({ source: "pi-visualize", type, ...payload }, "*");
    } catch {
      // The host may already be gone (card unmounted mid-interaction).
    }
  };
  const dispatchGlobals = (globals) => {
    globalThis.dispatchEvent(
      new CustomEvent("openai:set_globals", { detail: { globals } }),
    );
  };
  const userInitiated = () =>
    globalThis.navigator.userActivation?.isActive === true;
  const setWidgetState = async (next) => {
    const value = typeof next === "function" ? next(state) : next;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Widget state must be a JSON object");
    }
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).length > 16 * 1024) {
      throw new TypeError("Widget state must be a JSON object of at most 16 KiB");
    }
    state = JSON.parse(serialized);
    openai.widgetState = state;
    dispatchGlobals({ widgetState: state });
    // Session-memory store: the host always accepts, so the write resolves
    // optimistically. See the Phase 1 limitation note above.
    post("set-state", { state });
  };
  const openai = {
    widgetState: state,
    theme: root.dataset.theme === "light" ? "light" : "dark",
    setWidgetState,
    sendFollowUpMessage: ({ prompt, title } = {}) => {
      if (userInitiated()) {
        post("follow-up", {
          prompt: String(prompt ?? ""),
          title: title == null ? null : String(title),
        });
      }
      return Promise.resolve();
    },
    openExternal: ({ href } = {}) => {
      if (userInitiated()) {
        post("open-external", { href: String(href ?? "") });
      }
      return Promise.resolve();
    },
  };
  Object.defineProperty(globalThis, "openai", {
    value: openai,
    configurable: true,
    writable: true,
  });
  globalThis.addEventListener("message", (event) => {
    if (event.source !== globalThis.parent) {
      return;
    }
    const data = event.data;
    if (
      data === null ||
      typeof data !== "object" ||
      data.source !== "pi-visualize-host"
    ) {
      return;
    }
    if (data.type === "state") {
      state = data.state ?? null;
      openai.widgetState = state;
      dispatchGlobals({ widgetState: state });
    } else if (data.type === "theme") {
      const theme = data.theme === "light" ? "light" : "dark";
      root.dataset.theme = theme;
      openai.theme = theme;
      dispatchGlobals({ theme, visualizationTheme: theme });
    }
  });
  const sendHeight = () => {
    post("height", {
      height: Math.ceil(
        Math.max(
          root.scrollHeight,
          document.body?.scrollHeight ?? 0,
          document.body?.getBoundingClientRect().height ?? 0,
        ),
      ),
    });
  };
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(sendHeight).observe(root);
  }
  sendHeight();
})();
