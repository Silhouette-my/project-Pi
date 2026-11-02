import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import type { MentionGroup, MentionRow } from "./mention-core";
import type { CaretPoint } from "./caret-position";
import "./mention.css";

const GROUP_KEYS = {
  project: "mention.groupProject",
  recent: "mention.groupRecent",
  other: "mention.groupOther",
} as const;

/**
 * The `@` list of a plain-textarea composer, anchored above the caret in the
 * app's autocomplete menu surface. Focus never leaves the textarea: rows pick
 * on mousedown.
 */
export function MentionPopover({
  point,
  groups,
  highlight,
  onHighlight,
  onPick,
  onClose,
}: {
  point: CaretPoint;
  groups: readonly MentionGroup[];
  highlight: number;
  onHighlight: (index: number) => void;
  onPick: (row: MentionRow) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-mention-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);
  let index = -1;
  return (
    <>
      <span
        ref={anchorRef}
        className="mention-anchor"
        aria-hidden="true"
        style={{ left: point.x, top: point.y, height: point.height }}
      />
      <AnchoredMenu
        className="composer-autocomplete-anchor"
        open
        onClose={onClose}
        anchorRef={anchorRef}
        menuClassName="composer-autocomplete mention-popover"
        label={t("mention.menu")}
        role="listbox"
        side="top"
        initialFocus="none"
        trigger={() => null}
      >
        <div className="composer-ac-list" ref={listRef}>
          {groups.length === 0 ? (
            <div className="composer-model-empty">{t("mention.empty")}</div>
          ) : (
            groups.map((group) => (
              <div key={group.id} role="group" aria-label={t(GROUP_KEYS[group.id])}>
                <div className="composer-model-group-label">{t(GROUP_KEYS[group.id])}</div>
                {group.rows.map((row) => {
                  index += 1;
                  const at = index;
                  const active = at === highlight;
                  return (
                    <button
                      key={row.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      data-mention-index={at}
                      title={row.title}
                      className={`composer-plus-item composer-ac-item mention-row ${active ? "kb-active" : ""}`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        onPick(row);
                      }}
                      onMouseMove={() => onHighlight(at)}
                    >
                      <span className="mention-row-title">{row.title}</span>
                      {row.secondary ? (
                        <span className="mention-row-secondary">{row.secondary}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </AnchoredMenu>
    </>
  );
}
