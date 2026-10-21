import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

test("Dock icon follows the system preference and releases its observer on quit", { skip: process.platform !== "darwin" }, async () => {
  let appearance = "Dark";
  let changed;
  let quit;
  let unsubscribed;
  const icons = [];
  globalThis.__dockTest = {
    app: {
      isPackaged: false,
      getAppPath: () => "/pi",
      dock: { setIcon: (icon) => icons.push(icon.path) },
      once: (event, callback) => { assert.equal(event, "will-quit"); quit = callback; },
    },
    nativeImage: { createFromPath: (path) => ({ path, isEmpty: () => false }) },
    systemPreferences: {
      getUserDefault: (key, type) => {
        assert.equal(key, "AppleInterfaceStyle");
        assert.equal(type, "string");
        return appearance;
      },
      subscribeNotification: (name, callback) => {
        assert.equal(name, "AppleInterfaceThemeChangedNotification");
        changed = callback;
        return 17;
      },
      unsubscribeNotification: (id) => { unsubscribed = id; },
    },
  };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "electron") return {
        url: "data:text/javascript," + encodeURIComponent("export const {app,nativeImage,systemPreferences}=globalThis.__dockTest;"),
        shortCircuit: true,
      };
      return next(specifier, context);
    },
  });
  try {
    const { installSystemDockIcon } = await import("../electron/main/system-dock-icon.ts");
    installSystemDockIcon();
    appearance = "";
    changed();
    assert.deepEqual(icons, ["/pi/build/icon-dark_1024.png", "/pi/build/icon_1024.png"]);
    quit();
    assert.equal(unsubscribed, 17);
  } finally {
    hooks.deregister();
    delete globalThis.__dockTest;
  }
});
