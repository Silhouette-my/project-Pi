import assert from "node:assert/strict";
import test from "node:test";

const {
  ACTIVE_TAB_MIN_WIDTH,
  TAB_ICON_ONLY_WIDTH,
  TAB_MAX_WIDTH,
  TAB_TITLE_MIN_WIDTH,
  adjacentTabId,
  freezeTabWidths,
  tabStripLayout,
  tabWidth,
  workPanelShortcut,
} = await import("../src/lib/work-panel-strip.ts");
const { closeWorkPanelTabState } = await import("../src/lib/work-panel-tabs.ts");

test("a few tabs keep the maximum width and share the strip evenly as they grow", () => {
  assert.deepEqual(tabStripLayout(800, 2), {
    activeWidth: TAB_MAX_WIDTH,
    inactiveWidth: TAB_MAX_WIDTH,
    inactiveIconOnly: false,
    overflow: false,
  });
  const four = tabStripLayout(480, 4);
  assert.equal(four.activeWidth, 120);
  assert.equal(four.inactiveWidth, 120);
  assert.equal(four.overflow, false);
});

test("inactive tabs shrink first, turn icon-only, and never drop below 36px before overflow", () => {
  const six = tabStripLayout(330, 6);
  assert.equal(six.activeWidth, ACTIVE_TAB_MIN_WIDTH);
  assert.ok(six.inactiveWidth >= TAB_ICON_ONLY_WIDTH && six.inactiveWidth < TAB_TITLE_MIN_WIDTH);
  assert.equal(six.inactiveIconOnly, true);
  assert.equal(six.overflow, false);

  const eight = tabStripLayout(330, 8);
  assert.equal(eight.inactiveWidth, TAB_ICON_ONLY_WIDTH);
  assert.equal(eight.overflow, true, "104 + 7 * 36 is 356px, wider than the strip");

  const roomy = tabStripLayout(420, 5);
  assert.equal(roomy.inactiveIconOnly, false);
  assert.ok(roomy.inactiveWidth >= TAB_TITLE_MIN_WIDTH);
});

test("the active tab is never squeezed under its minimum and widths never exceed the strip without overflow", () => {
  for (let count = 1; count <= 14; count += 1) {
    for (let room = 40; room <= 900; room += 37) {
      const layout = tabStripLayout(room, count);
      assert.ok(layout.activeWidth >= Math.min(ACTIVE_TAB_MIN_WIDTH, room) || layout.overflow);
      if (!layout.overflow && count > 1) {
        assert.ok(layout.activeWidth + (count - 1) * layout.inactiveWidth <= room + count, `${count}/${room}`);
      }
    }
  }
});

test("frozen widths win over the layout and drop the closed tab", () => {
  const layout = tabStripLayout(800, 3);
  assert.equal(tabWidth(layout, false), TAB_MAX_WIDTH);
  assert.equal(tabWidth(layout, true, 120), 120);
  assert.deepEqual(freezeTabWidths({ a: 100.4, b: 100, c: 0, d: Number.NaN }, "b"), { a: 100 });
});

test("closing the active tab activates the right neighbour, else the left one", () => {
  const tabs = ["a", "b", "c"].map((id) => ({ id, kind: "new" }));
  const middle = closeWorkPanelTabState({ tabs, activeTabId: "b" }, "b");
  assert.equal(middle.activeTabId, "c");
  const last = closeWorkPanelTabState({ tabs, activeTabId: "c" }, "c");
  assert.equal(last.activeTabId, "b");
  const inactive = closeWorkPanelTabState({ tabs, activeTabId: "a" }, "c");
  assert.equal(inactive.activeTabId, "a");
});

test("Ctrl+Tab cycles with wrap-around in both directions", () => {
  const ids = ["a", "b", "c"];
  assert.equal(adjacentTabId(ids, "a", 1), "b");
  assert.equal(adjacentTabId(ids, "c", 1), "a");
  assert.equal(adjacentTabId(ids, "a", -1), "c");
  assert.equal(adjacentTabId(ids, null, 1), "a");
  assert.equal(adjacentTabId([], "a", 1), null);
});

test("panel shortcuts: Cmd/Ctrl+W closes, Ctrl+Tab cycles, everything else passes through", () => {
  const key = (key, mods = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
  assert.equal(workPanelShortcut(key("w", { metaKey: true }), "darwin"), "close-tab");
  assert.equal(workPanelShortcut(key("w", { ctrlKey: true }), "darwin"), null);
  assert.equal(workPanelShortcut(key("w", { ctrlKey: true }), "win32"), "close-tab");
  assert.equal(workPanelShortcut(key("w", { metaKey: true }), "win32"), null);
  assert.equal(workPanelShortcut(key("W", { metaKey: true, shiftKey: true }), "darwin"), null);
  assert.equal(workPanelShortcut(key("Tab", { ctrlKey: true }), "darwin"), "next-tab");
  assert.equal(workPanelShortcut(key("Tab", { ctrlKey: true, shiftKey: true }), "linux"), "previous-tab");
  assert.equal(workPanelShortcut(key("Tab"), "darwin"), null);
  assert.equal(workPanelShortcut(key("w", { metaKey: true, altKey: true }), "darwin"), null);
});
