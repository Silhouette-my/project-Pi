import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "../../styles/visualize.css";
import { IconCircleAlert, IconSparkles } from "../../components/icons";
import type { SourcePositionProps } from "../../lib/markdown-source";
import { openHttpUrl } from "../../lib/open-http-url";
import { useThemeMode } from "../../lib/use-theme-mode";
import { useSlotSessionId } from "../../plugins/renderer-slots/use-slots";
import { useAppStore } from "../../stores/app-store";
import {
  buildVisualizeDocument,
  clampVisualizeHeight,
} from "./visualize-document";
import type { VisualizeFenceSpec } from "./visualize-fence";
import { useVisualizeFragment } from "./use-visualize-fragment";
import { readWidgetState, writeWidgetState } from "./widget-state";

/*
 * Transcript card for a ```visualize fence. The agent-authored HTML fragment
 * is read through the contained `fsRead` channel and rendered in a sandboxed
 * iframe (`allow-scripts`, no same-origin) whose document carries the design
 * system, the host bridge, and a CSP limited to the CDN allowlist.
 *
 * The card identity — session + path + fence offset — keys the session-memory
 * widgetState store, so scrolling the card away and back restores the
 * fragment's saved interaction state.
 */

function displayName(spec: VisualizeFenceSpec): string {
  if (spec.title) return spec.title;
  const segments = spec.path.split(/[/\\]/);
  return segments[segments.length - 1] || spec.path;
}

export function VisualizeCard({
  spec,
  sourcePosition,
}: {
  spec: VisualizeFenceSpec;
  sourcePosition: SourcePositionProps;
}) {
  const { t } = useTranslation();
  const theme = useThemeMode();
  const paneSessionId = useSlotSessionId();
  const sessionId = useAppStore((s) => paneSessionId || s.activeSessionId);
  const fragment = useVisualizeFragment(spec.path);
  const cardId = `${sessionId ?? "draft"}|${spec.path}|${
    sourcePosition["data-source-start"] ?? 0
  }`;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [docUrl, setDocUrl] = useState<string | null>(null);
  const [height, setHeight] = useState(240);

  // Build the sandbox document whenever the fragment changes. Theme changes
  // are pushed into the live frame by the effect below instead of rebuilding,
  // so an interacting user never loses in-flight fragment state.
  useEffect(() => {
    if (fragment.kind !== "text") {
      setDocUrl(null);
      return;
    }
    const url = URL.createObjectURL(
      new Blob(
        [
          buildVisualizeDocument({
            fragment: fragment.content,
            theme,
            state: readWidgetState(cardId),
          }),
        ],
        { type: "text/html" },
      ),
    );
    setDocUrl(url);
    return () => URL.revokeObjectURL(url);
    // `theme` is read at build time only; live updates go by postMessage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fragment, cardId]);

  useEffect(() => {
    if (!docUrl) return;
    iframeRef.current?.contentWindow?.postMessage(
      { source: "pi-visualize-host", type: "theme", theme },
      "*",
    );
  }, [docUrl, theme]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as
        | { source?: string; type?: string; height?: unknown; state?: unknown; prompt?: unknown; title?: unknown; href?: unknown }
        | null;
      if (data === null || typeof data !== "object" || data.source !== "pi-visualize") {
        return;
      }
      switch (data.type) {
        case "height":
          setHeight(clampVisualizeHeight(data.height));
          break;
        case "set-state":
          writeWidgetState(cardId, data.state);
          break;
        case "follow-up": {
          const prompt = typeof data.prompt === "string" ? data.prompt.trim() : "";
          if (prompt) {
            // Same send path as the composer; a busy session queues it.
            void useAppStore.getState().sendPrompt(prompt, undefined, sessionId ?? undefined);
          }
          break;
        }
        case "open-external": {
          if (typeof data.href === "string") openHttpUrl(data.href);
          break;
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [cardId, sessionId]);

  const status = useMemo(() => {
    if (fragment.kind === "loading") {
      return (
        <div className="visualize-card-status" role="status">
          <span>{t("chat.visualizeLoading")}</span>
        </div>
      );
    }
    if (fragment.kind === "too-large") {
      return (
        <div className="visualize-card-status" role="status">
          <IconCircleAlert size={14} aria-hidden />
          <span>{t("chat.visualizeTooLarge")}</span>
        </div>
      );
    }
    if (fragment.kind === "error") {
      return (
        <div className="visualize-card-status" role="status">
          <IconCircleAlert size={14} aria-hidden />
          <span>{t("chat.visualizeUnavailable")}</span>
        </div>
      );
    }
    return null;
  }, [fragment.kind, t]);

  return (
    <div
      className={`visualize-card${spec.mode === "wide" ? " wide" : ""}`}
      {...sourcePosition}
    >
      <div className="visualize-card-head">
        <span className="visualize-card-title">
          <IconSparkles size={13} aria-hidden />
          <span>{displayName(spec)}</span>
        </span>
      </div>
      {status ?? (
        <iframe
          ref={iframeRef}
          className="visualize-frame"
          title={t("chat.visualizeFrame")}
          sandbox="allow-scripts"
          src={docUrl ?? undefined}
          style={{ height }}
          loading="lazy"
        />
      )}
    </div>
  );
}
