import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "../../styles/visualize.css";
import { IconCircleAlert, IconSparkles } from "../../components/icons";
import { Button } from "../../components/ui";
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
  sourceId,
}: {
  spec: VisualizeFenceSpec;
  sourcePosition: SourcePositionProps;
  sourceId: string;
}) {
  const { t } = useTranslation();
  const theme = useThemeMode();
  const paneSessionId = useSlotSessionId();
  const sessionId = useAppStore((s) => paneSessionId || s.activeSessionId);
  const cardId = `${sessionId ?? "draft"}|${sourceId}|${spec.path}|${
    sourcePosition["data-source-start"] ?? 0
  }`;
  const fragment = useVisualizeFragment(spec.path, cardId);
  const [pendingAction, setPendingAction] = useState<{ kind: "follow-up" | "open-external"; value: string } | null>(null);
  useEffect(() => setPendingAction(null), [cardId]);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [docUrl, setDocUrl] = useState<string | null>(null);
  const [height, setHeight] = useState(240);

  const fragmentContent = fragment.kind === "text" ? fragment.content : null;

  // Build the sandbox document whenever the fragment changes. Theme changes
  // are pushed into the live frame by the effect below instead of rebuilding,
  // so an interacting user never loses in-flight fragment state.
  useEffect(() => {
    if (fragmentContent === null) {
      setDocUrl(null);
      return;
    }
    const url = URL.createObjectURL(
      new Blob(
        [
          buildVisualizeDocument({
            fragment: fragmentContent,
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
  }, [fragmentContent, cardId]);

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
            setPendingAction({ kind: "follow-up", value: prompt });
          }
          break;
        }
        case "open-external": {
          if (typeof data.href === "string" && /^https?:\/\//i.test(data.href)) {
            setPendingAction({ kind: "open-external", value: data.href });
          }
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
      {pendingAction && (
        <div className="visualize-card-action">
          <p>{t(pendingAction.kind === "follow-up" ? "chat.visualizeConfirmPrompt" : "chat.visualizeConfirmLink")}</p>
          <pre>{pendingAction.value}</pre>
          <Button onClick={() => {
            const action = pendingAction;
            setPendingAction(null);
            if (action.kind === "follow-up") {
              void useAppStore.getState().sendPrompt(action.value, undefined, sessionId ?? undefined);
            } else {
              openHttpUrl(action.value);
            }
          }}>{t(pendingAction.kind === "follow-up" ? "chat.visualizeSend" : "chat.visualizeOpenLink")}</Button>
          <Button onClick={() => setPendingAction(null)}>{t("common.cancel")}</Button>
        </div>
      )}
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
