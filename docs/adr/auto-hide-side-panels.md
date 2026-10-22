# ADR: Auto-hide side panels

- Status: Accepted
- Related: ADR 0033, ADR 0151, ADR 0028, ADR 0141, ADR 0290, ADR 0238

## Context

Users want maximal content width, with the sidebar and the work panel available
on demand. Both panels were permanent in-flow columns that the user had to
collapse and reopen by hand, and a docked right panel plus an expanded sidebar
squeezed MainChat toward its 450px floor.

## Decision

Both side panels **auto-hide by default** and can be **pinned** to dock exactly
as before.

- Settings: optional `AppSettings.sidebarPinned` and `workPanelPinned`. Absent
  means unpinned. They persist through the normal settings save path, each side
  independently, and are exposed in Settings -> General -> Panel layout and by a
  header pin button on each panel. They are not config-synced: layout is a
  per-device preference (the synced application fields are appearance, input and
  model defaults).
- Unpinned panel: no layout width. The pointer resting 80ms in a 6px hot zone on
  its window edge (below the 46px titlebar row, so never over traffic lights or
  window controls) slides it in as a fixed overlay with a shadow, at the sidebar's
  current width / the work panel's stored width. It hides 300ms after the pointer
  leaves the panel and zone, unless a menu, popover, context menu or dialog is
  open, a drag or resize is running, text input inside it has focus, or keyboard
  focus inside it was moved there by the keyboard. Escape hides it and returns
  focus. Reduced motion removes the slide.
- Shortcuts: Cmd/Ctrl+B and Cmd/Ctrl+J reveal or hide an unpinned panel. A
  shortcut (command) reveal is sticky: it stays until Escape, a pointer exit
  after the pointer entered it, or the shortcut again. Pinned panels keep today's
  toggle, resize and collapse behavior.
- Work panel availability is unchanged (ADR 0033): without an active session
  there is no hot zone and no reveal, and agent or tool results never open or
  reveal it. While unpinned the store's per-session `open` flag is treated as a
  request: it reveals the overlay only when it follows a user input gesture
  within 400ms (a file or link opened into the panel); otherwise it is dropped.
- Width budget: the MainPane 450px floor, the sidebar-yields-first rule and the
  sidebar-reopen width lending apply only to pinned (docked) panels. Overlays
  never change MainPane width, so ADR 0238 holds for docked panels. An overlay
  work panel has no maximize (preview mode needs the dock).
- Accessibility: the hot zone is pointer-only (mouse pointers); keyboard users
  use the shortcuts. A command reveal moves focus onto the panel. Overlays are
  labelled `aside` regions, the closed sidebar is `inert`, and the pin button
  keeps a visible focus ring with `aria-pressed`.

## Reusable mechanism

`lib/edge-reveal.ts` is the framework-free controller (dwell, hide delay, hold
rules, sticky command reveal) and `hooks/use-edge-reveal.ts` binds it to the DOM.
Shared styles are `styles/edge-reveal.css` (`.edge-reveal-zone`, `.edge-panel`,
`.edge-pin-btn`). The project Agent dock can adopt it without copying code:

```ts
const reveal = useEdgeReveal({
  side: "left" | "right",
  enabled: boolean,        // false: no hot zone, panel hidden (docked/no context)
  dwellMs?: 80, hideDelayMs?: 300, exitMs?: 180,
  zoneWidth?: 6, topInset?: 46,
  holdOpen?: () => boolean,        // extra hold rule
  onOpenChange?: (open, source) => void,
});
// reveal: { enabled, open, mounted, phase: "closed"|"open"|"closing",
//   source: "pointer"|"command"|null, openPanel(), closePanel(), toggle(),
//   panelProps (ref, tabIndex, inert, data-edge-*), zoneProps }
```

Render the panel with `className="... edge-panel"` and `{...reveal.panelProps}`
(mounted while `reveal.mounted`, or always mounted and inert while closed), and
an empty `<div className="edge-reveal-zone" {...reveal.zoneProps} />` while
`reveal.enabled`. The hot zone is measured from window pointer samples and is
not hit-tested, so it never steals the transcript scrollbar or wheel events.
The pointer counts as inside the panel by its bounding rectangle, so a native
plugin view hosted in the panel does not retract it. Hold rules: root attributes
`data-sidebar-resizing`, `data-work-panel-resizing`, `data-project-reordering`,
`data-work-panel-tab-reordering`, HTML5 drags, a pressed button inside, an open
`[role=menu|dialog|alertdialog]`, `[aria-modal]` or `[data-edge-reveal-hold]`
outside `.main-pane`, text-entry focus, and `:focus-visible` focus inside.

## Preserved decisions

- 0033/0151: the panel stays inside the window; no native bounds change.
- 0141/0290: sidebar width resize and the 160px collapse threshold (dragging an
  overlay below it retracts it).
- 0238: the 450px MainPane floor and sidebar-yields-first for docked panels.
- 0028: per-session work panel contexts are unchanged; only visibility differs.

## Alternatives

- Hover-only without pin: rejected, some users want a permanent dock.
- A hit-tested edge element: rejected, it steals the right-edge scrollbar.
- Default pinned: rejected by the product decision (maximal content width).
- Syncing pin state across devices: rejected, window size differs per device.

## Amendment: width-adaptive default (2026-10-22)

Absent pin flags now mean **auto**: a panel docks when the window is wide
enough for it and auto-hides otherwise (sidebar from 960px, right panel from
1280px, `PANEL_AUTO_DOCK_MIN_WIDTH`). An explicit pin or unpin from a panel
header stores `true`/`false` and wins over the width. Settings → General →
Panel layout offers Auto / Docked / Auto-hide per side; Auto clears the
stored flag. On an unpinned sidebar the visible chrome sidebar button docks
it again instead of opening a transient overlay, because a retracting overlay
read as "cannot restore"; Cmd/Ctrl+B keeps the overlay toggle.
