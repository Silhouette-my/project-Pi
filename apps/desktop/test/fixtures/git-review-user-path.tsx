import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { ReviewTab } from "../../src/components/workpanel/ReviewTab";
import { useAppStore } from "../../src/stores/app-store";
import "../../src/styles/globals.css";

const calls = [];
window.piDesktop = {
  platform: "darwin", on: () => () => {},
  async invoke(channel, ...args) {
    calls.push({ channel, args });
    if (channel === IPC.invoke.workspaceDiff) return { ok: true, data: await window.reviewFixture.diff(args[0]?.sessionId) };
    if (channel === IPC.invoke.projectStructureGitSnapshot) return { ok: true, data: await window.reviewFixture.project() };
    throw new Error(`Unexpected fixture IPC: ${channel}`);
  },
};
await i18n.use(initReactI18next).init({
  lng: "zh-CN", fallbackLng: "en", keySeparator: false,
  resources: Object.fromEntries(["en", "zh-CN"].map((locale) => [locale, { translation: flattenCatalog(catalogs[locale]) }])),
  interpolation: { escapeValue: false },
});
const now = new Date().toISOString();
const historical = {
  id: "history-tool", role: "tool", content: "", createdAt: now,
  toolName: "Edit", toolStatus: "success",
  toolResult: { details: { root: "workspace", review: {
    version: 1, snapshotId: "history-snapshot", messageId: "history-tool", path: "historical-edit.txt",
    operation: "edit", status: "modified", state: "active", additions: 1, deletions: 1,
    hunks: [{ header: "@@ -1 +1 @@", lines: [{ type: "add", text: "historical edit" }] }], reversible: true,
  } } },
};
useAppStore.setState({
  activeSessionId: "a", workspace: { path: "/globally-selected-b", name: "Other project" },
  isRunning: false, messages: [historical],
  sessions: [{ id: "a", title: "A", mode: "agent", projectPath: "/a", createdAt: now, updatedAt: now, messageCount: 1 }],
});
const root = createRoot(document.getElementById("root"));
function render(projectId?: string) {
  flushSync(() => root.render(<div style={{ height: "100vh", display: "flex", flexDirection: "column" }}><ReviewTab projectId={projectId} /></div>));
}
render();
const frame = () => new Promise(requestAnimationFrame);
async function waitFor(check, message) {
  for (let i = 0; i < 180; i++) { if (check()) return; await frame(); }
  throw new Error(`${message}: ${document.body.textContent}`);
}
function assert(value, message) { if (!value) throw new Error(message); }
function button(text) {
  const item = [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === text);
  assert(item, `Missing button ${text}`); return item;
}
window.prepareGitReview = async () => {
  await waitFor(() => document.querySelector('[data-review-git-path="script-output.txt"]'), "Git files loaded");
  document.querySelector('[data-review-git-path="script-output.txt"] summary').click();
  await frame(); await frame();
};
window.gitReviewProbe = async () => {
  assert(document.querySelector('[data-review-layer="staged"] [data-review-git-path="tracked.txt"]'), "Staged edits are visible");
  assert(document.querySelector('[data-review-layer="unstaged"] [data-review-git-path="tracked.txt"]'), "Working edits are visible independently");
  assert(document.body.textContent.includes("shell-created output"), "Actual Shell-created untracked patch is readable");
  assert(!document.querySelector(".review-change-rollback"), "Live Git changes have no historical rollback action");
  assert(calls.some((call) => call.channel === IPC.invoke.workspaceDiff && call.args[0].sessionId === "a"), "Git query is bound to current session");
  button("工具记录").click();
  await waitFor(() => document.querySelector(".review-change-card"), "Historical tool records remain available");
  assert(document.body.textContent.includes("historical-edit.txt"), "History stays separate from Git");
  button("工作区改动").click();
  await waitFor(() => document.querySelector('[data-review-git-path="script-output.txt"]'), "Return to Git view");
  await window.reviewFixture.mutate();
  document.querySelector('button[aria-label="刷新 Git 改动"]').click();
  await waitFor(() => document.querySelector('[data-review-git-path="after-refresh.txt"]'), "Refresh observes external file writes");
  useAppStore.setState({ activeSessionId: "b" });
  await waitFor(() => document.querySelector('[data-review-git-path="other-project.txt"]'), "Session switch selects other working tree");
  assert(!document.querySelector('[data-review-git-path="script-output.txt"]'), "Previous session changes are not retained");
  useAppStore.setState({ activeSessionId: "plain" });
  await waitFor(() => document.body.textContent.includes("此工作区不是 Git 仓库"), "Non-Git workspace has explicit state");
  button("工具记录").click();
  await waitFor(() => document.querySelector(".review-change-card"), "Non-Git work still has tool history");
  button("工作区改动").click();
  useAppStore.setState({ activeSessionId: "broken" });
  await waitFor(() => document.querySelector('[role="alert"]'), "Git failures are displayed rather than a clean state");
  assert(document.querySelector('[role="alert"]').textContent.includes("Git fixture failure"), "Failure message preserved");
  render("project-a");
  await waitFor(() => document.querySelector('select'), "Project Review exposes its own roots");
  assert(document.querySelector('[data-review-git-path="script-output.txt"]'), "Project context is independent of active session");
  const select = document.querySelector("select");
  select.value = "b"; select.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => document.querySelector('[data-review-git-path="other-project.txt"]'), "Repository picker selects another project root");
  return { passed: true, liveGit: true, sessionScope: true, stagedAndUnstaged: true, externalRefresh: true, separateHistory: true, nonGitAndErrors: true, projectRoots: true };
};
