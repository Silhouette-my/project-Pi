import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { ArchivedConversationsSection } from "../../src/features/settings/ArchivedConversationsSection";
import { SETTINGS_NAV } from "../../src/lib/settings-search";
import { loadSidebarPreferences } from "../../src/lib/sidebar-preferences";
import { useAppStore } from "../../src/stores/app-store";
import "../../src/styles/globals.css";

const calls = [];
const session = (id, title, projectPath, extra = {}) => ({
  id, title, projectPath, messageCount: 1, mode: "agent", permissionMode: "ask",
  thinkingLevel: "off", providerId: "fixture", modelId: "fixture",
  createdAt: "2026-10-25T10:00:00Z", updatedAt: "2026-10-27T10:00:00Z", ...extra,
});
const sessions = [
  session("archived-project", "Fix login button", "/fixture/project"),
  session("archived-chat", "旅行计划", undefined, { archived: true }),
  session("visible", "Visible conversation", undefined),
  session("scheduled", "Hidden scheduled output", undefined, { scheduledRun: true, archived: true }),
];
window.piDesktop = {
  platform: "darwin",
  on: () => () => {},
  async invoke(channel, ...args) {
    calls.push({ channel, args });
    if (channel === IPC.invoke.sessionGet) {
      if (args[0].id === "archived-failure") throw new Error("Transcript unavailable");
      const found = sessions.find((item) => item.id === args[0].id);
      return { ok: true, data: { session: { ...found, messages: [{ id: "message", role: "user", content: "fixture", createdAt: found.createdAt, status: "complete" }] } } };
    }
    if (channel === IPC.invoke.plansPending) return { ok: true, data: { plans: [] } };
    if (channel === IPC.invoke.pendingInteractive) return { ok: true, data: { permissions: [], asks: [] } };
    if (channel === IPC.invoke.projectClear) return { ok: true, data: undefined };
    if (channel === IPC.invoke.appGetOnboarding) return { ok: true, data: { showChecklist: false, steps: [] } };
    throw new Error(`Unexpected fixture IPC: ${channel}`);
  },
};
await i18n.use(initReactI18next).init({
  lng: "en", fallbackLng: "en", keySeparator: false,
  resources: Object.fromEntries(["en", "zh-CN"].map((locale) => [locale, { translation: flattenCatalog(catalogs[locale]) }])),
  interpolation: { escapeValue: false },
});
useAppStore.setState({
  page: "settings", sessions, sessionMeta: { "archived-project": { archived: true, pinned: true, order: 3 } },
  openProjects: [{ path: "/fixture/project", name: "Fixture project" }],
  projectMeta: { "/fixture/project": { archived: true } },
  openProjectPaths: ["/fixture/project"], activeProjectPath: "/fixture/project",
  workspace: { path: "/fixture/project", name: "Fixture project" },
});
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(<div className="settings-content"><ArchivedConversationsSection /></div>));
const frame = () => new Promise(requestAnimationFrame);
const settle = async () => { await frame(); await frame(); };
function assert(condition, message) { if (!condition) throw new Error(message); }
function button(text, within = document) {
  const result = [...within.querySelectorAll("button")].find((item) => item.textContent.trim() === text);
  assert(result, `Missing button: ${text}`);
  return result;
}
async function search(text) {
  const input = document.querySelector('[role="dialog"] input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}
window.prepareArchiveSettings = async () => {
  button("Manage").focus(); button("Manage").click(); await settle();
  assert(document.querySelector('[role="dialog"]'), "Manage opens the dialog");
  assert(document.querySelectorAll("[data-archived-session]").length === 2, "Only archived ordinary conversations are listed");
  assert(document.activeElement.tagName === "INPUT", "Search receives focus");
};
window.archiveSettingsScreenshot = async (theme) => {
  document.documentElement.dataset.theme = theme;
  await settle();
  await Promise.all(document.getAnimations()
    .filter((animation) => Number.isFinite(animation.effect.getTiming().iterations))
    .map((animation) => animation.finished));
  const dialog = document.querySelector('[role="dialog"]');
  assert(dialog.scrollWidth <= dialog.clientWidth + 1, "Dialog does not overflow horizontally");
};
window.archiveSettingsProbe = async () => {
  assert(SETTINGS_NAV.find((item) => item.id === "general").keywordKeys.includes("settings.archivedChats.title"), "General and global settings search index the archive entry");
  await search("Fixture project");
  assert(document.querySelectorAll("[data-archived-session]").length === 1, "Search matches project names");
  await search("旅行");
  assert(document.querySelector('[data-archived-session="archived-chat"]'), "Search matches conversation titles");
  await search("does not exist");
  assert(document.documentElement.textContent.includes("No matching conversations."), `No-results state is visible: ${document.documentElement.textContent}`);
  await search("");
  const close = document.querySelector('[role="dialog"] button');
  close.focus();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
  assert(document.activeElement.textContent.trim() === "Unarchive", "Shift-Tab wraps inside dialog");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await settle();
  assert(!document.querySelector('[role="dialog"]'), "Escape closes the dialog");
  assert(document.activeElement.textContent.trim() === "Manage", "Closing restores focus");
  button("Manage").click(); await settle();
  button("Unarchive", document.querySelector('[data-archived-session="archived-project"]')).click(); await settle();
  assert(!document.querySelector('[data-archived-session="archived-project"]'), "Unarchiving removes the row");
  assert(document.activeElement.tagName === "INPUT", "Restoring a row keeps keyboard focus in the dialog");
  const meta = useAppStore.getState().sessionMeta["archived-project"];
  assert(!meta.archived && meta.pinned && meta.order === 3, "Restore preserves other sidebar metadata");
  assert(useAppStore.getState().sessions.find((item) => item.id === "archived-project").projectPath === "/fixture/project", "Project association is preserved");
  assert(loadSidebarPreferences().sessionMeta["archived-project"].archived === false, "Restore persists through the existing preferences");
  assert(useAppStore.getState().projectMeta["/fixture/project"].archived, "Restore leaves the parent project archived");
  assert(document.documentElement.textContent.includes("Its project is still archived."), "Restoration explains the archived parent project");
  button("Open", document.querySelector('[data-archived-session="archived-chat"]')).click();
  for (let attempt = 0; attempt < 90 && document.querySelector('[role="dialog"]'); attempt++) await settle();
  assert(useAppStore.getState().activeSessionId === "archived-chat", `Open uses the real session selection path: ${document.documentElement.textContent}; IPC: ${JSON.stringify(calls)}`);
  assert(useAppStore.getState().sessions.find((item) => item.id === "archived-chat").archived, "Opening does not unarchive");
  assert(calls.some((call) => call.channel === IPC.invoke.sessionGet), "Transcript is read through the existing IPC");
  useAppStore.getState().restoreSession("archived-chat");
  button("Manage").click(); await settle();
  assert(document.documentElement.textContent.includes("No archived conversations."), "Empty state is visible");
  await i18n.changeLanguage("zh-CN"); await settle();
  assert(document.documentElement.textContent.includes("归档对话"), "The dialog is localized");
  await i18n.changeLanguage("en");
  useAppStore.setState((state) => ({ sessions: [...state.sessions, session("archived-failure", "Unavailable conversation", undefined, { archived: true })] }));
  await settle();
  button("Open", document.querySelector('[data-archived-session="archived-failure"]')).click();
  for (let attempt = 0; attempt < 90 && !useAppStore.getState().toasts.length; attempt++) await settle();
  assert(useAppStore.getState().toasts.some((toast) => toast.message === "Transcript unavailable"), "Opening errors reach the app-wide toast even after leaving Settings");
  assert(useAppStore.getState().sessions.find((item) => item.id === "archived-failure").archived, "A failed open preserves archive state");
  return { passed: true, openingPreservesArchive: true, restorePreservesMetadata: true, searchAndKeyboard: true, emptyAndLocalized: true };
};
