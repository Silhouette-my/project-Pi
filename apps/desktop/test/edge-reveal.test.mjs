import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  createEdgeRevealController,
  EDGE_DRAG_ATTRIBUTES,
  EDGE_DWELL_MS,
  EDGE_HIDE_DELAY_MS,
  edgeRevealHoldReason,
  pointInEdgeZone,
  pointInRect,
} from "../src/lib/edge-reveal.ts";
import { readAppSource } from "./helpers/source-contracts.mjs";
import { loadStyles } from "./helpers/styles.mjs";

/** Deterministic clock so every delay is asserted exactly. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    timers: {
      setTimeout(callback, ms) {
        const id = nextId++;
        pending.set(id, { at: now + ms, callback });
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
    },
    tick(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

function setup(options = {}) {
  const clock = fakeClock();
  const changes = [];
  const controller = createEdgeRevealController({
    timers: clock.timers,
    onChange: (state) => changes.push({ ...state }),
    ...options,
  });
  controller.setEnabled(true);
  return { clock, controller, changes };
}

const atEdge = { inZone: true, inPanel: false };
const inPanel = { inZone: false, inPanel: true };
const away = { inZone: false, inPanel: false };

test("the pointer must dwell at the edge before the panel reveals", () => {
  const { clock, controller } = setup();
  controller.pointerMoved(atEdge);
  clock.tick(EDGE_DWELL_MS - 1);
  assert.equal(controller.getState().open, false);
  clock.tick(1);
  assert.deepEqual(controller.getState(), { open: true, source: "pointer" });
});

test("leaving the edge before the dwell ends cancels the reveal", () => {
  const { clock, controller } = setup();
  controller.pointerMoved(atEdge);
  clock.tick(EDGE_DWELL_MS - 10);
  controller.pointerMoved(away);
  clock.tick(1000);
  assert.equal(controller.getState().open, false);
  assert.equal(clock.pendingCount, 0);
});

test("a pressed button at the edge is a drag, never a reveal", () => {
  const { clock, controller } = setup();
  controller.pointerMoved({ ...atEdge, pressed: true });
  clock.tick(1000);
  assert.equal(controller.getState().open, false);
});

test("a blocked reveal (modal dialog open) never starts the dwell", () => {
  const { clock, controller } = setup({ canReveal: () => false });
  controller.pointerMoved(atEdge);
  clock.tick(1000);
  assert.equal(controller.getState().open, false);
});

test("a hover reveal hides 300ms after the pointer leaves", () => {
  const { clock, controller } = setup();
  controller.pointerMoved(atEdge);
  clock.tick(EDGE_DWELL_MS);
  controller.pointerMoved(inPanel);
  controller.pointerMoved(away);
  clock.tick(EDGE_HIDE_DELAY_MS - 1);
  assert.equal(controller.getState().open, true);
  clock.tick(1);
  assert.deepEqual(controller.getState(), { open: false, source: null });
});

test("a hover reveal also hides when the pointer never entered the panel", () => {
  const { clock, controller } = setup();
  controller.pointerMoved(atEdge);
  clock.tick(EDGE_DWELL_MS);
  controller.pointerMoved(away);
  clock.tick(EDGE_HIDE_DELAY_MS);
  assert.equal(controller.getState().open, false);
});

test("returning to the panel or the edge cancels a pending hide", () => {
  const { clock, controller } = setup();
  controller.pointerMoved(atEdge);
  clock.tick(EDGE_DWELL_MS);
  controller.pointerMoved(away);
  clock.tick(EDGE_HIDE_DELAY_MS - 50);
  controller.pointerMoved(inPanel);
  clock.tick(1000);
  assert.equal(controller.getState().open, true);
  controller.pointerMoved(away);
  clock.tick(EDGE_HIDE_DELAY_MS - 50);
  controller.pointerMoved(atEdge);
  clock.tick(1000);
  assert.equal(controller.getState().open, true);
});

test("a hold postpones the hide until it is released", () => {
  let held = true;
  const { clock, controller } = setup({ isHeld: () => held });
  controller.pointerMoved(atEdge);
  clock.tick(EDGE_DWELL_MS);
  controller.pointerMoved(inPanel);
  controller.pointerMoved(away);
  clock.tick(EDGE_HIDE_DELAY_MS * 5);
  assert.equal(controller.getState().open, true);
  held = false;
  clock.tick(200);
  assert.equal(controller.getState().open, false);
});

test("re-entering the panel during a hold keeps it open after release", () => {
  let held = true;
  const { clock, controller } = setup({ isHeld: () => held });
  controller.pointerMoved(atEdge);
  clock.tick(EDGE_DWELL_MS);
  controller.pointerMoved(away);
  clock.tick(EDGE_HIDE_DELAY_MS * 2);
  controller.pointerMoved(inPanel);
  held = false;
  clock.tick(1000);
  assert.equal(controller.getState().open, true);
});

test("a command reveal is sticky until the pointer enters and leaves", () => {
  const { clock, controller } = setup();
  controller.open();
  assert.deepEqual(controller.getState(), { open: true, source: "command" });
  controller.pointerMoved(away);
  clock.tick(5000);
  assert.equal(controller.getState().open, true);
  controller.pointerMoved(inPanel);
  controller.pointerMoved(away);
  clock.tick(EDGE_HIDE_DELAY_MS);
  assert.equal(controller.getState().open, false);
});

test("a command upgrades a hover reveal to sticky", () => {
  const { clock, controller } = setup();
  controller.pointerMoved(atEdge);
  clock.tick(EDGE_DWELL_MS);
  assert.equal(controller.getState().source, "pointer");
  controller.open();
  assert.equal(controller.getState().source, "command");
  controller.pointerMoved(away);
  clock.tick(5000);
  assert.equal(controller.getState().open, true);
});

test("toggle opens and closes, and Escape closes an open panel only", () => {
  const { controller } = setup();
  assert.equal(controller.escape(), false);
  controller.toggle();
  assert.equal(controller.getState().open, true);
  controller.toggle();
  assert.equal(controller.getState().open, false);
  controller.toggle();
  assert.equal(controller.escape(), true);
  assert.equal(controller.getState().open, false);
});

test("a disabled (pinned or unavailable) panel never reveals", () => {
  const { clock, controller } = setup();
  controller.setEnabled(false);
  controller.pointerMoved(atEdge);
  clock.tick(1000);
  controller.open();
  controller.toggle();
  assert.equal(controller.getState().open, false);
});

test("disabling an open panel closes it at once and clears every timer", () => {
  const { clock, controller, changes } = setup();
  controller.open();
  controller.pointerMoved(inPanel);
  controller.pointerMoved(away);
  controller.setEnabled(false);
  assert.equal(controller.getState().open, false);
  assert.equal(clock.pendingCount, 0);
  assert.equal(changes.at(-1).open, false);
});

test("dispose clears pending timers", () => {
  const { clock, controller } = setup();
  controller.pointerMoved(atEdge);
  controller.dispose();
  assert.equal(clock.pendingCount, 0);
});

function environment(overrides = {}) {
  return {
    rootHasAttribute: () => false,
    dragging: () => false,
    pressedInside: () => false,
    focusInside: () => null,
    popupOpen: () => false,
    ...overrides,
  };
}

test("hold rules: nothing in progress means the panel may hide", () => {
  assert.equal(edgeRevealHoldReason(environment()), null);
});

test("hold rules: an open menu, popover or dialog holds the panel", () => {
  assert.equal(
    edgeRevealHoldReason(environment({ popupOpen: () => true })),
    "popup",
  );
});

test("hold rules: a drag or resize in progress holds the panel", () => {
  assert.equal(
    edgeRevealHoldReason(environment({ dragging: () => true })),
    "drag",
  );
  for (const attribute of EDGE_DRAG_ATTRIBUTES) {
    assert.equal(
      edgeRevealHoldReason(
        environment({ rootHasAttribute: (name) => name === attribute }),
      ),
      "drag",
      attribute,
    );
  }
  assert.deepEqual([...EDGE_DRAG_ATTRIBUTES].sort(), [
    "data-project-reordering",
    "data-sidebar-resizing",
    "data-work-panel-resizing",
    "data-work-panel-tab-reordering",
  ]);
});

test("hold rules: a pointer button held down inside holds the panel", () => {
  assert.equal(
    edgeRevealHoldReason(environment({ pressedInside: () => true })),
    "pressed",
  );
});

test("hold rules: text entry focus holds, mouse-moved button focus does not", () => {
  assert.equal(
    edgeRevealHoldReason(
      environment({
        focusInside: () => ({ textEntry: true, keyboardFocus: false }),
      }),
    ),
    "text-entry",
  );
  assert.equal(
    edgeRevealHoldReason(
      environment({
        focusInside: () => ({ textEntry: false, keyboardFocus: false }),
      }),
    ),
    null,
  );
});

test("hold rules: keyboard-moved focus inside holds the panel", () => {
  assert.equal(
    edgeRevealHoldReason(
      environment({
        focusInside: () => ({ textEntry: false, keyboardFocus: true }),
      }),
    ),
    "keyboard-focus",
  );
});

test("the controller honours the hold rules end to end", () => {
  let menuOpen = true;
  const { clock, controller } = setup({
    isHeld: () => edgeRevealHoldReason(environment({ popupOpen: () => menuOpen })) !== null,
  });
  controller.pointerMoved(atEdge);
  clock.tick(EDGE_DWELL_MS);
  controller.pointerMoved(inPanel);
  controller.pointerMoved(away);
  clock.tick(2000);
  assert.equal(controller.getState().open, true);
  menuOpen = false;
  clock.tick(200);
  assert.equal(controller.getState().open, false);
});

test("the hot zone sits on its edge, below the titlebar row", () => {
  const base = { viewportWidth: 1200, zoneWidth: 6, topInset: 46 };
  assert.equal(pointInEdgeZone({ ...base, side: "left", clientX: 0, clientY: 300 }), true);
  assert.equal(pointInEdgeZone({ ...base, side: "left", clientX: 6, clientY: 300 }), true);
  assert.equal(pointInEdgeZone({ ...base, side: "left", clientX: 7, clientY: 300 }), false);
  assert.equal(pointInEdgeZone({ ...base, side: "left", clientX: 2, clientY: 45 }), false);
  assert.equal(pointInEdgeZone({ ...base, side: "left", clientX: 2, clientY: 46 }), true);
  assert.equal(pointInEdgeZone({ ...base, side: "right", clientX: 1199, clientY: 300 }), true);
  assert.equal(pointInEdgeZone({ ...base, side: "right", clientX: 1194, clientY: 300 }), true);
  assert.equal(pointInEdgeZone({ ...base, side: "right", clientX: 1193, clientY: 300 }), false);
  assert.equal(pointInEdgeZone({ ...base, side: "right", clientX: 1199, clientY: 10 }), false);
});

test("pointInRect treats a native view inside the panel rect as inside", () => {
  const rect = { left: 800, right: 1200, top: 0, bottom: 700 };
  assert.equal(pointInRect(rect, 900, 300), true);
  assert.equal(pointInRect(rect, 799, 300), true);
  assert.equal(pointInRect(rect, 790, 300), false);
});

const appSource = await readAppSource();
const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const workPanelSource = await readFile(
  new URL("../src/components/workpanel/WorkPanel.tsx", import.meta.url),
  "utf8",
);
const hookSource = await readFile(
  new URL("../src/hooks/use-edge-reveal.ts", import.meta.url),
  "utf8",
);
const globalStyles = await loadStyles();

test("the shell never budgets an unpinned panel and routes the shortcuts to the overlay", () => {
  assert.match(appSource, /const sidebarCollapsed = sidebarDockCollapsed \|\| !sidebarPinned;/);
  assert.match(appSource, /const workPanelVisible = workPanelOpen && workPanelPinned;/);
  assert.match(appSource, /if \(!sidebarPinnedRef\.current\) \{\s*toggleLeftOverlay\(\);/);
  assert.match(appSource, /if \(!workPanelPinnedRef\.current\) \{\s*if \(store\.activeSessionId\) toggleRightOverlay\(\);/);
  // Availability is unchanged: no session, no hot zone and no reveal.
  assert.match(appSource, /enabled:\s*ready && !workPanelPinned && !pageHidesWorkPanel && Boolean\(activeSessionId\)/);
  // Agent and tool results never reveal: only a fresh user gesture does.
  assert.match(appSource, /USER_GESTURE_WINDOW_MS/);
  assert.match(appSource, /gesture &&\s*!was\.pinned/);
});

test("the pin buttons persist per side through the settings save path", () => {
  assert.match(appSource, /setPanelPinned\("sidebarPinned", true\)/);
  assert.match(appSource, /setPanelPinned\("workPanelPinned", false\)/);
  assert.match(sidebarSource, /data-nav="pin-sidebar"/);
  assert.match(workPanelSource, /data-nav="pin-work-panel"/);
  assert.match(sidebarSource, /aria-pressed=\{pinned\}/);
  assert.match(workPanelSource, /aria-pressed=\{pinned\}/);
});

test("overlay panels are labelled regions and the hot zone is pointer-only", () => {
  assert.match(sidebarSource, /aria-label=\{t\("nav\.sidebarRegion"\)\}/);
  assert.match(workPanelSource, /aria-label=\{t\("panel\.title"\)\}/);
  // Window-level pointer samples, never a hit-tested element.
  assert.match(hookSource, /event\.pointerType !== "mouse"/);
  assert.match(globalStyles, /\.edge-reveal-zone \{[^}]*pointer-events:\s*none;/s);
  assert.match(globalStyles, /\.edge-reveal-zone \{[^}]*top:\s*var\(--ds-toolbar-height\);/s);
});

test("overlays float above the content and honour reduced motion", () => {
  assert.match(globalStyles, /\.edge-panel \{[^}]*position:\s*fixed;/s);
  assert.match(globalStyles, /\.edge-panel \{[^}]*box-shadow:\s*var\(--ds-shadow-edge-panel\);/s);
  assert.match(
    globalStyles,
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.edge-panel,[\s\S]*?animation-duration:\s*0\.01ms !important;/,
  );
  assert.match(globalStyles, /\.edge-pin-btn:focus-visible \{[^}]*outline:/s);
});
