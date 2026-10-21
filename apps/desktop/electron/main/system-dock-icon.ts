import { app, nativeImage, systemPreferences } from "electron";
import { join } from "node:path";

/** Read the OS preference directly; nativeTheme may be overridden by the app theme. */
export function installSystemDockIcon(): void {
  if (process.platform !== "darwin" || !app.dock) return;
  const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "build");
  const light = nativeImage.createFromPath(join(root, "icon_1024.png"));
  const dark = nativeImage.createFromPath(join(root, "icon-dark_1024.png"));
  if (light.isEmpty() || dark.isEmpty()) throw new Error("Pi system appearance icons are missing.");
  const update = () => app.dock!.setIcon(
    systemPreferences.getUserDefault("AppleInterfaceStyle", "string") === "Dark" ? dark : light,
  );
  update();
  const subscription = systemPreferences.subscribeNotification("AppleInterfaceThemeChangedNotification", update);
  app.once("will-quit", () => systemPreferences.unsubscribeNotification(subscription));
}
