import { stat, realpath, cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DEVELOPMENT_INSTALLATION_NAME } from "./data-paths";
import type { Cookie, Cookies, CookiesSetDetails } from "electron";

const supportedDomain = (domain: string) => {
  const host = domain.replace(/^\./, "");
  return ["chatgpt.com", "openai.com"].some((root) => host === root || host.endsWith(`.${root}`));
};

export function importedCookie(cookie: Cookie): CookiesSetDetails & { name: string } {
  return {
    url: `https://${cookie.domain!.replace(/^\./, "")}${cookie.path ?? "/"}`,
    name: cookie.name,
    value: cookie.value,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    ...(cookie.session ? {} : { expirationDate: cookie.expirationDate }),
  };
}

/** Credentials stay inside Electron; never return or log cookie values. */
export async function transferChatLogin(source: Cookies, target: Cookies): Promise<void> {
  const existing = (await target.get({})).filter((cookie) => cookie.domain && supportedDomain(cookie.domain));
  const cookies = (await source.get({})).filter((cookie) => cookie.domain && supportedDomain(cookie.domain));
  if (!cookies.length) {
    throw new Error("Electron could not read any ChatGPT cookies from the previous Pi profile.");
  }
  const saved: (CookiesSetDetails & { name: string })[] = [];
  try {
    for (const cookie of cookies) {
      const details = importedCookie(cookie);
      await target.set(details);
      saved.push(details);
    }
    await target.flushStore();
  } catch {
    for (const cookie of saved) await target.remove(cookie.url, cookie.name);
    for (const cookie of existing) await target.set(importedCookie(cookie));
    await target.flushStore();
    throw new Error("ChatGPT login import failed; the previous destination cookies were restored.");
  }
}

/** Only an explicit settings action opens the previous Pi development partition. */
export async function importPreviousChatLogin(): Promise<void> {
  const { app, session } = await import("electron");
  const path = join(app.getPath("appData"), DEVELOPMENT_INSTALLATION_NAME, "Partitions", "chatgpt-chat");
  if (!(await stat(path)).isDirectory()) {
    throw new Error("The previous Pi Chat profile is unavailable.");
  }
  const target = session.fromPartition("persist:chatgpt-chat");
  if (await realpath(path) === await realpath(target.storagePath!)) return;
  // Chromium may update its cookie database while opening it. Work on an
  // owner-only snapshot, never on the original development profile.
  const snapshot = await mkdtemp(join(app.getPath("temp"), "pi-chat-login-import-"));
  await cp(path, snapshot, { recursive: true });
  const source = session.fromPath(snapshot);
  try {
    await transferChatLogin(source.cookies, target.cookies);
  } finally {
    await source.clearStorageData();
    await source.clearCache();
    await source.cookies.flushStore();
    await rm(snapshot, { recursive: true, force: true });
  }
}
