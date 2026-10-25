import { app, globalShortcut, type Tray } from "electron";
import type { CloseBehavior } from "@pi-desktop/shared";
import type { AgentSidecar } from "../agent-sidecar";
import type { BrowserHost } from "../browser-host";
import type { HostProcess } from "../host-process";
import type { InflightCheckpointer } from "@pi-desktop/host-runtime";
import type { Logger } from "../logger";
import type { PersistenceOutbox } from "../persistence-outbox";
import type { PluginPanelHost } from "../plugin-panel-host";
import type { PluginRuntime } from "../plugin-runtime";
import type { PluginViewHost } from "../plugin-view-host";
import type { ComposerSuggestionRelay } from "../services/composer-suggestion";
import type { AppUpdaterController } from "../updater";
import type { UserMcpRuntime } from "../user-mcp";
import type { McpControlServer } from "../mcp-control";
import type { McpOAuthManager } from "../mcp-oauth";
import { getActiveRemoteHostsBoot, setActiveRemoteHostsBoot } from "./remote-hosts";
import type { LiveCallService } from "../live-voice/call-service";

const QUIT_TURN_SETTLE_BUDGET_MS = 2_000;
/**
 * Upper bound for the whole graceful shutdown. Every step below has its own
 * budget; this is the backstop for a step that has none (a host or child that
 * never answers) so the process still reaches `app.quit()` and Electron tears
 * the children down, instead of staying alive forever.
 */
export const QUIT_SHUTDOWN_HARD_TIMEOUT_MS = 15_000;
/** Signals that mean "terminate", not "a person pressed Quit". */
const TERMINATION_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/**
 * True when the environment asks for quits without the confirmation dialog:
 * automation (E2E, probes, capture) has nobody to click it.
 */
export function quitConfirmationDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.PI_DESKTOP_BOOT_PROBE === "1" ||
    env.PI_DESKTOP_SUPERVISION_PROBE === "1" ||
    env.PI_DESKTOP_CAPTURE === "1" ||
    env.PI_DESKTOP_SKIP_QUIT_CONFIRM === "1"
  );
}

export type ShutdownState = {
  shutdownComplete: boolean;
  shutdownPromise: Promise<void> | null;
  quitting: boolean;
  quitConfirmed: boolean;
  closeBehavior: CloseBehavior;
  tray: Tray | null;
  pluginLauncherAccelerator: string | null;
  toggleWindowAccelerator: string | null;
};

export type ShutdownDependencies = {
  hasSingleInstanceLock: boolean;
  state: ShutdownState;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  getMcpControl: () => McpControlServer | null;
  activeTurns: Map<string, string>;
  persistenceOutbox: PersistenceOutbox;
  inflightCheckpointer: InflightCheckpointer;
  flushEventPersistence: () => Promise<void>;
  pluginPanels: Pick<PluginPanelHost, "closeAll">;
  plugins: Pick<PluginRuntime, "disposeAll">;
  userMcp: Pick<UserMcpRuntime, "disposeAll">;
  mcpOAuth?: Pick<McpOAuthManager, "disposeAll">;
  browserHost: Pick<BrowserHost, "dispose">;
  pluginViews: Pick<PluginViewHost, "dispose">;
  /** Composer suggestions still waiting for an answer at quit (ADR 0333). */
  composerSuggestion?: Pick<ComposerSuggestionRelay, "dispose">;
  updater: Pick<AppUpdaterController, "dispose" | "isInstallingUpdate">;
  logger: Pick<Logger, "app">;
  confirmQuitDialog: () => Promise<boolean>;
  disposePowerSaveBlockers: () => void;
  liveCallService?: Pick<LiveCallService, "endForLifecycle">;
  disposeSystemProxyRelay?: () => Promise<void>;
  disposeProjectWorkflow?: () => Promise<void>;
};

/** Register the last-window and before-quit resource lifecycle handlers. */
export function registerShutdownHandlers({
  hasSingleInstanceLock,
  state,
  getHost,
  getSidecar,
  getMcpControl,
  activeTurns,
  persistenceOutbox,
  inflightCheckpointer,
  flushEventPersistence,
  pluginPanels,
  plugins,
  userMcp,
  mcpOAuth,
  browserHost,
  pluginViews,
  composerSuggestion,
  updater,
  logger,
  confirmQuitDialog,
  disposePowerSaveBlockers,
  liveCallService,
  disposeSystemProxyRelay,
  disposeProjectWorkflow,
}: ShutdownDependencies): void {
  let quitConfirmationPending = false;
  // SIGTERM/SIGINT/SIGHUP are the OS or a supervisor asking the process to end.
  // Chromium turns them into `before-quit`, where the confirmation dialog would
  // wait for a person who did not ask to quit and keep the app alive forever.
  // Treat them as already confirmed; a repeated signal during shutdown means
  // "now", and ends the process without waiting for the remaining steps.
  // The listeners go in once the app is ready: a Node signal listener installed
  // while the main script loads is replaced by Chromium's own handler when the
  // browser process starts, and would never run.
  if (hasSingleInstanceLock) {
    const onTerminationSignal = (signal: NodeJS.Signals) => {
      if (state.shutdownPromise && !state.shutdownComplete) {
        logger.app("lifecycle", "warn", "repeated termination signal; exiting without waiting", {
          data: signal,
        });
        app.exit(0);
        return;
      }
      logger.app("lifecycle", "info", "termination signal received", { data: signal });
      state.quitConfirmed = true;
      app.quit();
    };
    void app.whenReady?.().then(() => {
      for (const signal of TERMINATION_SIGNALS) process.on(signal, onTerminationSignal);
    });
  }
  app.on("window-all-closed", () => {
    // The D216 tray is resident on every platform, so its presence says nothing
    // about whether the app should survive a closed window — the user's close
    // behavior does. Under "tray" a window destroyed for any reason must not
    // take the app down (the tray click recreates it); otherwise closing the
    // last window on Windows/Linux exits the app as before.
    if (process.platform === "darwin") return;
    if (state.closeBehavior === "tray" && state.tray) return;
    app.quit();
  });

  app.on("before-quit", (event) => {
    // A duplicate launch has no host, sidecar, panel, or outbox of its own, and
    // the shutdown sequence below would write into the running instance's data
    // directory. Let it exit straight away.
    if (!hasSingleInstanceLock) return;
    if (state.shutdownComplete) return;
    event.preventDefault();
    if (state.shutdownPromise || quitConfirmationPending) return;

    // Show a confirmation dialog on the first explicit quit (Cmd+Q, tray quit,
    // application-menu Quit) while a turn is running. The data-saving shutdown
    // runs after confirmation.
    // Skip confirmation in automated probe/capture modes where no human is
    // present to interact with the dialog.
    const isAutomatedMode = quitConfirmationDisabled();
    // Skip confirmation for the quit that an in-app update performs. The
    // installer for that update was already spawned before app.quit(), and it
    // aborts once the app stays alive for a few seconds, so deferring this quit
    // behind a dialog fails the update. There is no decision left either: the
    // user chose "restart to update" to get here.
    const isUpdateRestart = updater.isInstallingUpdate();
    // The dialog warns that running sessions will be stopped. With no turn in
    // flight there is nothing to warn about, and asking anyway makes every quit
    // from a script, a supervisor or AppleScript wait for a click that nobody
    // is there to give (the dialog has no timeout once it falls back to native).
    const hasRunningWork = activeTurns.size > 0;
    if (!state.quitConfirmed && !isAutomatedMode && !isUpdateRestart && hasRunningWork) {
      state.quitConfirmed = true;
      quitConfirmationPending = true;
      void confirmQuitDialog().then(
        (confirmed) => {
          quitConfirmationPending = false;
          if (confirmed) {
            app.quit();
          } else {
            // User cancelled: allow future quit requests to prompt again.
            state.quitConfirmed = false;
          }
        },
        (error: unknown) => {
          quitConfirmationPending = false;
          logger.app("lifecycle", "warn", "quit confirmation failed; allowing shutdown", {
            data: String(error),
          });
          app.quit();
        },
      );
      return;
    }

    state.quitting = true;
    // Persist the confirmed shutdown before any awaited cleanup so a forced
    // process termination still leaves an observable lifecycle boundary.
    logger.app("lifecycle", "info", "app shutdown");
    disposePowerSaveBlockers();
    state.tray?.destroy();
    state.tray = null;
    if (state.pluginLauncherAccelerator) {
      globalShortcut.unregister(state.pluginLauncherAccelerator);
      state.pluginLauncherAccelerator = null;
    }
    if (state.toggleWindowAccelerator) {
      globalShortcut.unregister(state.toggleWindowAccelerator);
      state.toggleWindowAccelerator = null;
    }
    state.shutdownPromise = (async () => {
      await disposeProjectWorkflow?.();
      await liveCallService?.endForLifecycle("app-quit");
      // Close every paired remote host before the local host-core so any
      // in-flight remote turn's abort still goes over a live socket. Bounded
      // parallelism inside `closeAll`; safe to run before local disposals.
      const remoteHostsShutdown = getActiveRemoteHostsBoot()?.closeAll();
      setActiveRemoteHostsBoot(null);
      // Replies still streaming are stopped through the sidecar first so their
      // aborted final rows can reach the transcript while host-core is alive;
      // whatever does not make it in time is covered by the last checkpoint
      // (D299). Bounded: a quit must not hang on an unresponsive provider.
      await settleRunningTurnsForQuit({
        activeTurns,
        getHost,
        getSidecar,
        inflightCheckpointer,
        persistenceOutbox,
        logger,
      });
      // Panel windows and docked views are the only pages that call the plugin
      // runtime over the panel bridge. They are torn down, and their pages are
      // waited for, before the runtime and the host stop: a call such a page
      // already sent while its surface was closing is otherwise answered by a
      // runtime that is already shutting down, and surfaces as a bridge failure
      // nobody can act on. The wait is bounded inside the hosts, so a page that
      // refuses to close cannot hold up the quit.
      const pluginSurfacesShutdown = Promise.allSettled([
        pluginPanels.closeAll(),
        pluginViews.dispose(),
      ]);
      await pluginSurfacesShutdown;
      // Stop event production before draining the terminal writes. A finished
      // turn can already have left activeTurns while its branch archive is
      // still awaiting the host; closing host-core first loses that archive.
      const sidecarShutdown = getSidecar()?.dispose();
      await Promise.allSettled([sidecarShutdown]);
      await inflightCheckpointer.flushAll();
      let persistenceTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = await Promise.race([
          flushEventPersistence().then(() => true),
          new Promise<boolean>((resolve) => {
            persistenceTimer = setTimeout(() => resolve(false), QUIT_TURN_SETTLE_BUDGET_MS);
          }),
        ]);
        if (!settled) {
          logger.app("lifecycle", "warn", "quit before event persistence settled");
        }
      } finally {
        if (persistenceTimer) clearTimeout(persistenceTimer);
      }
      await persistenceOutbox.flush(getHost);
      const hostShutdown = getHost()?.dispose();
      const mcpShutdown = getMcpControl()?.stop();
      updater.dispose();
      // Plugin hosts are stopped as a shutdown, not left for the process teardown
      // to kill: an unannounced exit is indistinguishable from a crash, and would
      // end every quit in error logs, toasts, and restarts into a closing app.
      const pluginShutdown = plugins.disposeAll();
      userMcp.disposeAll();
      mcpOAuth?.disposeAll();
      browserHost.dispose();
      composerSuggestion?.dispose();
      inflightCheckpointer.dispose();

      try {
        await hostShutdown;
      } catch (error) {
        logger.app("lifecycle", "warn", "host shutdown failed", { data: String(error) });
      }
      await Promise.allSettled([
        pluginShutdown,
        sidecarShutdown,
        mcpShutdown,
        remoteHostsShutdown,
      ]);
      await disposeSystemProxyRelay?.();
    })();

    const releaseQuit = () => {
      state.shutdownComplete = true;
      app.quit();
    };
    void state.shutdownPromise.then(releaseQuit, releaseQuit);
    // Backstop for a step that never settles; the normal path above wins and
    // the timer is released with the process.
    const hardTimer = setTimeout(() => {
      if (state.shutdownComplete) return;
      logger.app("lifecycle", "warn", "shutdown exceeded its time budget; quitting anyway", {
        data: `${QUIT_SHUTDOWN_HARD_TIMEOUT_MS}ms`,
      });
      releaseQuit();
    }, QUIT_SHUTDOWN_HARD_TIMEOUT_MS);
    hardTimer.unref?.();
  });
}

type TurnSettlementDependencies = {
  activeTurns: Map<string, string>;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  inflightCheckpointer: InflightCheckpointer;
  persistenceOutbox: PersistenceOutbox;
  logger: Pick<Logger, "app">;
};

async function settleRunningTurnsForQuit({
  activeTurns,
  getHost,
  getSidecar,
  inflightCheckpointer,
  persistenceOutbox,
  logger,
}: TurnSettlementDependencies): Promise<void> {
  const sessions = [...activeTurns.keys()];
  const deadline = Date.now() + QUIT_TURN_SETTLE_BUDGET_MS;
  // The newest snapshot of every streaming reply lands first: it is the
  // fallback if the abort below does not produce a final row in time.
  await inflightCheckpointer.flushAll();
  if (sessions.length === 0) {
    await persistenceOutbox.flush(getHost);
    return;
  }
  const sidecar = getSidecar();
  if (sidecar) {
    await Promise.allSettled(
      sessions.map((sessionId) =>
        Promise.race([
          sidecar.call("agent.abort", { sessionId }),
          new Promise((resolve) => setTimeout(resolve, 800)),
        ]),
      ),
    );
  }
  // The abort surfaces as message_end + error/agent_end, which finishTurn
  // turns into a settled turn and an outbox append. Wait for that, bounded.
  while (Date.now() < deadline) {
    await persistenceOutbox.flush(getHost);
    if (activeTurns.size === 0 && persistenceOutbox.size() === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await persistenceOutbox.flush(getHost);
  if (activeTurns.size > 0 || persistenceOutbox.size() > 0) {
    logger.app("lifecycle", "warn", "quit before streaming replies settled", {
      data: { running: activeTurns.size, pendingAppends: persistenceOutbox.size() },
    });
  }
}
