import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { GenUiCards } from "../../apps/desktop/src/features/chat/gen-ui/GenUiCard";
import { genUiSplitFor } from "../../apps/desktop/src/features/chat/gen-ui/gen-ui-split";
import { genUiFramePool } from "../../apps/desktop/src/features/chat/gen-ui/gen-ui-frames";
import { AssistantTurnParts } from "../../apps/desktop/src/features/chat/transcript/AssistantTurnParts";
import { SlotSessionProvider } from "../../apps/desktop/src/plugins/renderer-slots/use-slots";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { api } from "../../apps/desktop/src/lib/api";

const container = document.getElementById("root");
if (!container) throw new Error("GenUI fixture root is missing");
const root = createRoot(container);
const i18n = createInstance();
const loaded = new WeakSet<object>();
const messages: unknown[] = [];
const legacyActions: Array<{ kind: string; value: string; sessionId?: string }> = [];
window.addEventListener("message", (event) => {
  messages.push(event.data);
  if (event.data?.type === "fixture:loaded" && event.source) loaded.add(event.source);
});

async function wait(predicate: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

// The test enters through the production card interface and real React wiring;
// only the externally generated HTML and its owning session are fixture data.
Object.assign(window, {
  genUiProbe: {
    ready: i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } }).then(() => true),
    mount(content: string, streaming = false, remote = false) {
      const split = genUiSplitFor(content, streaming);
      flushSync(() => root.render(
        createElement(I18nextProvider, { i18n },
          createElement("p", { id: "prose" }, split.content),
          createElement(GenUiCards, { references: split.references, sessionId: "probe_session", remote }),
        ),
      ));
    },
    mountLegacy(fragment: string, reference: string, inlineVisualizations = false) {
      // Only the external file read and final outgoing actions are replaced;
      // production Markdown, cards, store selection and confirmation UI run.
      api.fsRead = async () => ({ kind: "text", content: fragment, size: new TextEncoder().encode(fragment).length });
      api.browserOpenExternal = async (url = "") => {
        legacyActions.push({ kind: "external", value: url });
        return { ok: true };
      };
      useAppStore.setState({
        activeSessionId: "probe_session",
        sessions: [{ id: "probe_session", title: "Compatibility", messageCount: 1, mode: "agent", thinkingLevel: "inherit", permissionMode: "inherit", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" }],
        settings: { defaultMode: "agent", theme: "light", enterToSend: true, onboardingDismissed: true, smoothStreaming: false, inlineVisualizations, linkOpenTarget: "external" },
        sendPrompt: async (prompt, _attachments, sessionId) => {
          legacyActions.push({ kind: "follow-up", value: prompt, sessionId });
        },
      });
      const content = 'Legacy chart:\n\n```visualize\n{"path":"/fixture/legacy.html","title":"Legacy interaction"}\n```\n\n' + reference;
      flushSync(() => root.render(
        createElement(I18nextProvider, { i18n },
          createElement(SlotSessionProvider, { sessionId: "probe_session" },
            createElement(AssistantTurnParts, {
              parts: [{ kind: "message", message: { id: "legacy-compatibility", role: "assistant", content, status: "complete", createdAt: "2026-11-02T00:00:00Z" } }],
              isActive: false,
              turnDelegationStatuses: new Map(),
              turnDelegationTimings: new Map(),
            }),
          ),
        ),
      ));
    },
    legacyActions,
    wait,
    waitLoaded(count: number) {
      return wait(() => {
        const frames = [...document.querySelectorAll("iframe")];
        return frames.length === count && frames.every((frame) => frame.contentWindow && loaded.has(frame.contentWindow));
      }, `guest loads ${count}`);
    },
    messages,
    poolSize: () => genUiFramePool.size,
    unmount() { flushSync(() => root.unmount()); },
  },
});
