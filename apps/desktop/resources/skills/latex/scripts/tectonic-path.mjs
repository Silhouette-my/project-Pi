import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function getTectonicExecutablePath(
  pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
) {
  const appExecutablePath = process.env.CODEX_TECTONIC_PATH;
  if (
    appExecutablePath &&
    path.isAbsolute(appExecutablePath) &&
    statSync(appExecutablePath, { throwIfNoEntry: false })?.isFile()
  ) {
    return appExecutablePath;
  }
  const executableName =
    process.platform === "win32" ? "tectonic.exe" : "tectonic";
  const executablePath = path.join(pluginRoot, "bin", executableName);
  if (!statSync(executablePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      `Tectonic executable not found through CODEX_TECTONIC_PATH or at ${executablePath}.`,
    );
  }
  return executablePath;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(getTectonicExecutablePath());
}
