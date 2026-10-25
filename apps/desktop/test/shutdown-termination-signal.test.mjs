import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
import test from "node:test";

// Only Electron is replaced; the shutdown handler is the production code.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron") return { url: "test:electron", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "test:electron") return {
      format: "module", shortCircuit: true,
      source: `import { EventEmitter } from "node:events";
        export const app = new EventEmitter();
        app.quit = () => {}; app.exit = () => {}; app.whenReady = () => Promise.resolve();
        export const globalShortcut = { unregister() {} };`,
    };
    return next(url, context);
  },
});
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { app } = await import("electron");
const { registerShutdownHandlers, QUIT_SHUTDOWN_HARD_TIMEOUT_MS, quitConfirmationDisabled } =
  await import("../electron/main/bootstrap/shutdown.ts");

function wire({ hostDispose = async () => {}, activeTurns = new Map() } = {}) {
  app.removeAllListeners();
  process.removeAllListeners("SIGTERM");
  const calls = { confirm: 0, exit: 0, warnings: [], quits: 0 };
  const state = {
    shutdownComplete: false, shutdownPromise: null, quitting: false,
    quitConfirmed: false, closeBehavior: "quit", tray: null,
    pluginLauncherAccelerator: null, toggleWindowAccelerator: null,
  };
  const dispose = () => undefined;
  app.quit = () => { calls.quits += 1; app.emit("before-quit", { preventDefault() {} }); };
  app.exit = () => { calls.exit += 1; };
  registerShutdownHandlers({
    hasSingleInstanceLock: true, state,
    getHost: () => ({ dispose: hostDispose }),
    getSidecar: () => null, getMcpControl: () => null, activeTurns,
    persistenceOutbox: { flush: async () => {}, size: () => 0 },
    inflightCheckpointer: { flushAll: async () => {}, dispose },
    flushEventPersistence: async () => {},
    pluginPanels: { closeAll: async () => {} }, plugins: { disposeAll: async () => {} },
    userMcp: { disposeAll: dispose }, browserHost: { dispose },
    pluginViews: { dispose: async () => {} },
    updater: { dispose, isInstallingUpdate: () => false },
    logger: { app: (_a, level, event) => { if (level === "warn") calls.warnings.push(event); } },
    confirmQuitDialog: () => { calls.confirm += 1; return new Promise(() => {}); },
    disposePowerSaveBlockers: dispose,
  });
  return { state, calls, ready: () => new Promise((resolve) => setImmediate(resolve)) };
}

test("SIGTERM quits without waiting on the confirmation dialog", async (t) => {
  delete process.env.PI_DESKTOP_SKIP_QUIT_CONFIRM;
  t.after(() => { app.removeAllListeners(); process.removeAllListeners("SIGTERM"); });
  const { state, calls, ready } = wire();
  await ready();
  process.emit("SIGTERM", "SIGTERM");
  assert.ok(state.shutdownPromise, "shutdown started synchronously");
  await state.shutdownPromise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.confirm, 0, "a signal is not an explicit user quit");
  assert.equal(state.shutdownComplete, true);
});

test("a plain app.quit asks for confirmation while a turn is running", (t) => {
  delete process.env.PI_DESKTOP_SKIP_QUIT_CONFIRM;
  t.after(() => { app.removeAllListeners(); process.removeAllListeners("SIGTERM"); });
  const { state, calls } = wire({ activeTurns: new Map([["session", "turn"]]) });
  app.quit();
  assert.equal(calls.confirm, 1);
  assert.equal(state.shutdownPromise, null);
});

test("an idle app quits without a confirmation nobody is there to answer", async (t) => {
  delete process.env.PI_DESKTOP_SKIP_QUIT_CONFIRM;
  t.after(() => { app.removeAllListeners(); process.removeAllListeners("SIGTERM"); });
  const { state, calls } = wire();
  app.quit();
  assert.equal(calls.confirm, 0);
  await state.shutdownPromise;
  assert.ok(state.quitting);
});

test("PI_DESKTOP_SKIP_QUIT_CONFIRM disables the confirmation", () => {
  assert.equal(quitConfirmationDisabled({ PI_DESKTOP_SKIP_QUIT_CONFIRM: "1" }), true);
  assert.equal(quitConfirmationDisabled({}), false);
});

test("a host that never stops cannot keep the app alive", async (t) => {
  t.after(() => { app.removeAllListeners(); process.removeAllListeners("SIGTERM"); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { state, calls, ready } = wire({ hostDispose: () => new Promise(() => {}) });
  await ready();
  process.emit("SIGTERM", "SIGTERM");
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.shutdownComplete, false, "still waiting inside the budget");
  t.mock.timers.tick(QUIT_SHUTDOWN_HARD_TIMEOUT_MS);
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.shutdownComplete, true);
  assert.deepEqual(calls.warnings, ["shutdown exceeded its time budget; quitting anyway"]);
});

test("a repeated SIGTERM during shutdown exits immediately", async (t) => {
  t.after(() => { app.removeAllListeners(); process.removeAllListeners("SIGTERM"); });
  const { calls, ready } = wire({ hostDispose: () => new Promise(() => {}) });
  await ready();
  process.emit("SIGTERM", "SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  process.emit("SIGTERM", "SIGTERM");
  assert.equal(calls.exit, 1);
});
