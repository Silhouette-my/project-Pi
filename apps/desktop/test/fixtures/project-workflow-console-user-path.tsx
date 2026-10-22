import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import {
  IPC,
  emptyProjectWorkflowSnapshot,
  isProjectWorkflowUserCommand,
  isProjectWorkflowAction,
} from "@pi-desktop/shared";
import { workflowFixtureWorkstream } from "../../../../packages/shared/src/project-workflow-fixtures";
import type {
  ProjectWorkflowSnapshot,
  ProjectWorkflowAction,
  ProjectWorkflowUserCommand,
  SessionSummary,
  ProviderPublic,
} from "@pi-desktop/shared";
import {
  ProjectWorkflowProvider,
  useProjectWorkflow,
} from "../../src/features/project-workflow/useProjectWorkflow";
import { ProjectConsole } from "../../src/features/project-workflow/ProjectConsole";
import { ProjectAgentTab } from "../../src/features/project-panel/ProjectAgentTab";
import { useAppStore } from "../../src/stores/app-store";
import { useUnfiledNewSession } from "../../src/features/project-workflow/useUnfiledNewSession";
import "../../src/styles/globals.css";

await i18n.use(initReactI18next).init({
  lng: "en",
  keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});
const t = (key: string) => i18n.t(key);
const now = "2026-10-20T00:00:00Z";
const agentSession: SessionSummary = {
  id: "main-chat",
  title: "Executable Agent",
  projectPath: "/synthetic/project",
  providerId: "agent-provider",
  modelId: "synthetic-model",
  mode: "agent",
  messageCount: 1,
  thinkingLevel: "omit",
  permissionMode: "ask",
  createdAt: now,
  updatedAt: now,
};
const agentProvider: ProviderPublic = {
  id: "agent-provider",
  name: "Synthetic Agent",
  vendorKey: "synthetic",
  type: "custom",
  protocol: "openai",
  enabled: true,
  authKind: "none",
  hasSecret: false,
  models: [],
  supportsReasoning: false,
  supportedThinkingLevels: [],
  createdAt: now,
  updatedAt: now,
};
const longTitle =
  "Deliver session-independent project continuity with a clear accountable owner and a durable current candidate — including long labels";
let durable: ProjectWorkflowSnapshot = {
  ...emptyProjectWorkflowSnapshot(),
  revision: 3,
  workstreams: [
    {
      ...structuredClone(workflowFixtureWorkstream),
      title: longTitle,
      mainSessionId: "main-chat",
      currentCandidateId: "candidate-7",
      revision: 3,
      owner: { kind: "agent", ref: "continuity-owner" },
      status: "blocked",
      blocker: {
        reason: "Waiting for candidate review",
        owner: "reviewer-owner",
        resumeWhen: "A reviewer accepts candidate-7",
      },
      nextAction: "Review the current candidate and its exact revision",
      acceptance: [
        {
          id: "ac-1",
          title: "New sessions retain adopted decisions",
          status: "pending",
          evidenceIds: ["evidence-7"],
        },
      ],
    },
  ],
  artifacts: [
    {
      id: "candidate-6",
      projectId: "project-1",
      workstreamId: "work-1",
      label: "Historical continuity candidate",
      kind: "candidate",
      revision: "candidate-revision-6",
      environment: "isolated-renderer",
      entryPoint: "/synthetic/continuity/old.html",
      source: { kind: "file", ref: "old-build" },
      createdAt: now,
    },
    {
      id: "candidate-7",
      projectId: "project-1",
      workstreamId: "work-1",
      label: "Continuity candidate",
      kind: "candidate",
      revision: "candidate-revision-7",
      environment: "isolated-renderer",
      entryPoint: "/synthetic/continuity/report.html",
      source: { kind: "file", ref: "synthetic-build" },
      createdAt: now,
    },
  ],
  evidence: [
    {
      id: "evidence-7",
      projectId: "project-1",
      workstreamId: "work-1",
      candidateId: "candidate-7",
      candidateRevision: "candidate-revision-7",
      environment: "isolated-renderer",
      scenario: "Reload retains effective decisions",
      acceptanceId: "ac-1",
      outcome: "passed",
      kind: "rendered",
      limits: "Synthetic IPC boundary; host persistence is not exercised",
      source: { kind: "file", ref: "renderer-probe" },
      createdAt: now,
    },
  ],
};
const calls: { channel: string; input?: unknown }[] = [];
const actions: ProjectWorkflowAction[] = [];
const mutations: ProjectWorkflowUserCommand[] = [];
const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
let rejectMutation = false;
let heldAction: { resolve: (value: unknown) => void; input: ProjectWorkflowAction } | null = null;
let holdNextAction = false;
let heldSnapshot: { resolve: (value: unknown) => void; snapshot: ProjectWorkflowSnapshot } | null =
  null;
let holdNextSnapshot = false;
const ok = (data: unknown) => ({ ok: true, data });
function applyMutation(command: ProjectWorkflowUserCommand) {
  if (command.kind === "workstream.create") durable.workstreams.push(command.workstream);
  else if (command.kind === "workstream.update")
    durable.workstreams = durable.workstreams.map((item) =>
      item.id === command.workstreamId
        ? { ...item, ...command.patch, revision: item.revision + 1 }
        : item,
    );
  else if (command.kind === "authorization.grant")
    durable.authorizations.push(command.authorization);
  else if (command.kind === "feedback.add") durable.feedback.push(command.feedback);
  else if (command.kind === "navigation.move")
    durable.navigation = durable.navigation.map((item) =>
      command.sessionIds.includes(item.sessionId) ? { ...item, folderId: command.folderId } : item,
    );
  else throw Error("Unexpected mutation " + command.kind);
  durable.revision++;
}
window.piDesktop = {
  platform: "darwin",
  on(channel: string, listener: (...args: unknown[]) => void) {
    const set = listeners.get(channel) ?? new Set();
    set.add(listener);
    listeners.set(channel, set);
    return () => set.delete(listener);
  },
  async invoke(channel: string, input?: unknown) {
    calls.push({ channel, input });
    if (channel === IPC.invoke.projectWorkflowSnapshot) {
      if (holdNextSnapshot) {
        holdNextSnapshot = false;
        return new Promise((resolve) => {
          heldSnapshot = { resolve, snapshot: structuredClone(durable) };
        });
      }
      return ok(structuredClone(durable));
    }
    if (channel === IPC.invoke.projectGroupList)
      return ok({
        groups: [
          {
            id: "project-1",
            name: "Continuity workspace",
            primaryPath: "/synthetic/project",
            roots: [{ path: "/synthetic/project", name: "project", position: 0 }],
            createdAt: now,
            updatedAt: now,
          },
        ],
      });
    if (channel === IPC.invoke.projectWorkflowMutate) {
      if (!isProjectWorkflowUserCommand(input)) throw Error("Invalid C0 mutation");
      mutations.push(input);
      if (rejectMutation) {
        rejectMutation = false;
        return { ok: false, error: { code: "CONFLICT", message: "Synthetic stale revision" } };
      }
      if (input.expectedRevision !== durable.revision) throw Error("Wrong mutation revision");
      applyMutation(input);
      return ok({ snapshot: structuredClone(durable), replayed: false });
    }
    if (channel === IPC.invoke.projectWorkflowAction) {
      if (!isProjectWorkflowAction(input)) throw Error("Invalid C0 action");
      if (input.expectedRevision !== durable.revision) throw Error("Wrong action revision");
      actions.push(input);
      if (holdNextAction) {
        holdNextAction = false;
        return new Promise((resolve) => {
          heldAction = { resolve, input };
        });
      }
      // Deliberately unchanged: the UI must not invent execution status from an accepted intent.
      return ok({ snapshot: structuredClone(durable), ...(input.kind === "agent.open" ? { sessionId: "project-agent" } : {}) });
    }
    if (
      channel === IPC.invoke.projectWorkflowSearch &&
      (input as { query: string }).query === "history"
    )
      return ok({
        hits: [
          {
            kind: "artifact",
            id: "candidate-6",
            artifactId: "candidate-6",
            label: "Historical continuity candidate",
            excerpt: "Retained prior output",
            projectId: "project-1",
            workstreamId: "work-1",
            breadcrumb: ["Continuity workspace", "Outputs", "Historical continuity candidate"],
          },
        ],
      });
    if (
      channel === IPC.invoke.projectWorkflowSearch &&
      (input as { query: string }).query === "message"
    )
      return ok({
        hits: [
          {
            kind: "message",
            id: "m-search",
            sessionId: "main-chat",
            messageId: "m-search",
            label: "Matched message",
            excerpt: "Exact transcript result",
            projectId: "project-1",
            workstreamId: "work-1",
            breadcrumb: ["Continuity workspace", "Executable Agent", "Matched message"],
          },
        ],
      });
    if (channel === IPC.invoke.sessionGet)
      return ok({
        session: {
          ...agentSession,
          messages: [
            {
              id: "m-search",
              role: "assistant",
              content: "Exact transcript result",
              createdAt: now,
            },
          ],
          messageStart: 0,
          hasMoreBefore: false,
          hasMoreAfter: false,
        },
      });
    if (channel === IPC.invoke.projectWorkflowSearch)
      return ok({
        hits: [
          {
            kind: "workstream",
            id: "work-1",
            label: "Continuity search match",
            excerpt: "Exact workstream source",
            projectId: "project-1",
            workstreamId: "work-1",
            breadcrumb: ["Continuity workspace", longTitle],
          },
        ],
      });
    if (channel === IPC.invoke.projectWorkflowOpenReference)
      return ok({
        opened: true,
        uri: "/synthetic/continuity/report.html",
        revision: "candidate-revision-7",
      });
    if (channel === IPC.invoke.sessionList) return ok({ sessions: [] });
    throw Error("Unexpected IPC channel " + channel);
  },
} as typeof window.piDesktop;

useAppStore.setState({
  page: "project",
  projectConsoleId: "project-1",
  activeSessionId: null,
  sessions: [
    agentSession,
    {
      ...agentSession,
      id: "consumer-chat",
      providerId: "consumer-provider",
      title: "Consumer discussion",
    },
  ],
  providers: [
    agentProvider,
    {
      ...agentProvider,
      id: "consumer-provider",
      name: "Consumer Chat",
      apiStyle: "chatgpt_conversation",
    },
  ],
});
function RevisionProbe() {
  const { snapshot } = useProjectWorkflow();
  const newUnfiledSession = useUnfiledNewSession();
  return (
    <>
      <output data-workflow-test-revision>{snapshot?.revision}</output>
      <button data-workflow-global-new hidden onClick={() => void newUnfiledSession()}>
        New
      </button>
    </>
  );
}
/**
 * Stands in for the right work panel, which the console no longer renders: it
 * shows the project Agent tab once the project's panel context holds one,
 * exactly what WorkPanel does for a `project-agent` tab.
 */
function WorkPanelProbe() {
  const tab = useAppStore((state) => state.workPanelTabs.find((item) => item.kind === "project-agent"));
  return tab?.resource ? (
    <aside data-work-panel-probe style={{ width: 340, display: "flex", flexDirection: "column" }}>
      <ProjectAgentTab projectId={tab.resource} />
    </aside>
  ) : null;
}
const root = createRoot(document.getElementById("root")!);
function mount() {
  flushSync(() =>
    root.render(
      <ProjectWorkflowProvider>
        <RevisionProbe />
        <ProjectConsole projectId="project-1" />
        <WorkPanelProbe />
      </ProjectWorkflowProvider>,
    ),
  );
}
mount();
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(predicate: () => unknown, message: string) {
  for (let n = 0; n < 150; n++) {
    if (predicate()) return;
    await frame();
  }
  throw Error(message + " DOM=" + document.body.textContent);
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}
function findButton(key: string, scope: ParentNode = document) {
  check(scope, "Missing button scope " + key);
  const label = t(key);
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label,
  );
  check(button, "Missing button " + key);
  return button;
}
function click(key: string, scope: ParentNode = document) {
  flushSync(() => findButton(key, scope).click());
}
function field(key: string, scope: ParentNode = document) {
  check(scope, "Missing field scope " + key);
  const named = [...scope.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select")].find((input) => input.getAttribute("aria-label") === t(key));
  if (named) return named;
  const label = [...scope.querySelectorAll("label")].find(
    (label) => label.firstElementChild?.textContent?.trim() === t(key),
  );
  check(label, "Missing field " + key);
  const input = label.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    "input,textarea,select",
  );
  check(input, "Missing input " + key);
  return input;
}
function fill(key: string, value: string, scope: ParentNode = document) {
  const input = field(key, scope);
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  flushSync(() =>
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    ),
  );
}
function submit(scope: ParentNode) {
  const form = scope instanceof HTMLFormElement ? scope : scope.querySelector("form");
  check(form, "Missing form");
  flushSync(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
const detail = () => document.querySelector<HTMLElement>('[data-workstream-id="work-1"]')!;
async function selectPrimary() {
  if (!document.querySelector(".workflow-workstream")) {
    click("workflow.workstreams", document.querySelector(".workflow-tabs")!);
    if (document.querySelector("[data-workstream-id]")) click("workflow.allWorkstreams");
  }
  const button = [...document.querySelectorAll<HTMLButtonElement>(".workflow-workstream")].find(
    (button) => button.textContent?.includes(longTitle),
  );
  check(button, "Missing primary stream");
  flushSync(() => button.click());
  await until(() => detail(), "Primary detail missing");
}
async function actionClick(key: string) {
  const before = actions.length;
  click(key, detail());
  await until(() => actions.length === before + 1, "Action not sent " + key);
  await until(() => !findButton("workflow.discuss", detail()).disabled, "Action remained busy");
  return actions.at(-1)!;
}
const emit = () =>
  listeners.get(IPC.event.projectWorkflowChanged)?.forEach((listener) =>
    listener({
      revision: durable.revision,
      commandId: "external-event",
      kind: "workstream.update",
    }),
  );

Object.assign(window, {
  async consoleProbe() {
    await until(
      () => document.querySelector(".workflow-workstream"),
      "Console did not load independently",
    );
    check(useAppStore.getState().activeSessionId === null, "Console required an active chat");
    await selectPrimary();
    const executorSelect = field("workflow.executionSession", detail()) as HTMLSelectElement;
    check(
      [...executorSelect.options].some((option) => option.value === "main-chat") &&
        ![...executorSelect.options].some((option) => option.value === "consumer-chat"),
      "Executor selector admitted consumer-only Chat",
    );
    check(detail().textContent?.includes("reviewer-owner"), "Blocker owner missing");
    check(
      detail().textContent?.includes("A reviewer accepts candidate-7"),
      "Resume condition missing",
    );
    check(detail().textContent?.includes("continuity-owner"), "Accountable owner missing");
    check(
      findButton("workflow.start", detail()).disabled,
      "Start permitted without explicit authority",
    );
    click("workflow.editWorkstream", detail());
    await until(
      () => document.querySelector('[data-workflow="workstream-editor"]'),
      "Editor missing",
    );
    const edit = document.querySelector('[data-workflow="workstream-editor"]')!;
    field("workflow.title", edit).focus();
    check(document.activeElement === field("workflow.title", edit), "Title not keyboard-focusable");
    fill("workflow.nextAction", "Review exact candidate and preserve reading position", edit);
    submit(edit);
    await until(
      () =>
        durable.workstreams[0].nextAction ===
        "Review exact candidate and preserve reading position",
      "Edit not persisted through IPC",
    );
    await until(() => !document.querySelector('[data-workflow="workstream-editor"]'), "Saved editor did not close");
    // An unchanged field must not overwrite a newer background checkpoint.
    click("workflow.editWorkstream", detail());
    const concurrentEditor = document.querySelector('[data-workflow="workstream-editor"]')!;
    fill("workflow.title", longTitle + " (reviewed)", concurrentEditor);
    durable.workstreams[0].nextAction = "Background checkpoint must survive title editing";
    durable.workstreams[0].revision++;
    durable.revision++;
    emit();
    await until(
      () =>
        document.querySelector("[data-workflow-test-revision]")?.textContent ===
        String(durable.revision),
      "Background edit not projected",
    );
    submit(concurrentEditor);
    await until(
      () => !document.querySelector('[data-workflow="workstream-editor"]'),
      "Concurrent editor did not settle",
    );
    check(
      durable.workstreams[0].nextAction === "Background checkpoint must survive title editing",
      "Untouched next action was overwritten",
    );
    const titleMutation = mutations.at(-1)!;
    check(
      titleMutation.kind === "workstream.update" && !("nextAction" in titleMutation.patch),
      "Editor submitted an untouched stale field",
    );
    click("workflow.editWorkstream", detail());
    const conflictingEditor = document.querySelector('[data-workflow="workstream-editor"]')!;
    fill("workflow.nextAction", "User draft from old checkpoint", conflictingEditor);
    durable.workstreams[0].nextAction = "New authoritative checkpoint";
    durable.workstreams[0].revision++;
    durable.revision++;
    emit();
    await until(
      () =>
        document.querySelector("[data-workflow-test-revision]")?.textContent ===
        String(durable.revision),
      "Conflicting event not projected",
    );
    const beforeConflict = mutations.length;
    submit(conflictingEditor);
    await until(
      () => conflictingEditor.querySelector('[role="alert"]'),
      "Conflicting field edit was not fenced",
    );
    check(
      mutations.length === beforeConflict &&
        durable.workstreams[0].nextAction === "New authoritative checkpoint",
      "Stale field escaped the editor",
    );
    click("workflow.retry", conflictingEditor);
    check(
      field("workflow.nextAction", conflictingEditor).value === "New authoritative checkpoint",
      "Reload did not restore current field",
    );
    click("workflow.close", conflictingEditor);
    click("workflow.newWorkstream");
    const create = document.querySelector('[data-workflow="workstream-editor"]')!;
    check(create.closest('[role="dialog"][aria-modal="true"]'), "Work editor was not a modal dialog");
    field("workflow.title", create).focus();
    flushSync(() => field("workflow.title", create).dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
    check(document.activeElement === findButton("workflow.close", create), "Dialog focus escaped backwards");
    flushSync(() => findButton("workflow.close", create).dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    check(document.activeElement === field("workflow.title", create), "Dialog focus escaped forwards");
    fill("workflow.title", "Independent validation", create);
    fill("workflow.goal", "Validate after restart", create);
    fill("workflow.acceptance", "Reload restores state", create);
    fill("workflow.owner", "validation-owner", create);
    submit(create);
    await until(() => durable.workstreams.length === 2, "Workstream creation missing");
    await until(
      () => !document.querySelector('[data-workflow="workstream-editor"]'),
      "Creation did not settle",
    );
    await selectPrimary();
    click("workflow.authority", detail());
    const authority = document.querySelector('[data-workflow="authorization-editor"]')!;
    fill("workflow.allowedActions", "read, edit", authority);
    fill("workflow.allowedResources", "/synthetic/project", authority);
    fill("workflow.maxRuns", "2", authority);
    fill("workflow.stopConditions", "Stop on first failed check", authority);
    submit(authority);
    await until(() => durable.authorizations.length === 1, "Authority not granted");
    await until(
      () => !findButton("workflow.start", detail()).disabled,
      "Granted authority not available",
    );
    const grant = durable.authorizations[0];
    check(
      grant.source.kind === "user" && grant.permissionCeiling === "ask" && grant.maxRuns === 2,
      "Authority source or bounds lost",
    );
    const start = await actionClick("workflow.start");
    check(
      start.kind === "start" &&
        start.authorizationId === grant.id &&
        start.sessionId === "main-chat",
      "Start routed incorrectly",
    );
    check(
      durable.workstreams[0].status === "blocked" && detail()?.textContent?.includes(t("workflow.status.blocked")),
      "UI optimistically invented execution",
    );
    check((await actionClick("workflow.pause")).kind === "pause", "Pause not explicit");
    const discuss = await actionClick("workflow.discuss");
    check(discuss.kind === "discuss" && !discuss.pause, "Discuss silently paused work");
    const pauseDiscuss = await actionClick("workflow.pauseDiscuss");
    check(
      pauseDiscuss.kind === "discuss" && pauseDiscuss.pause,
      "Pause to discuss lost pause choice",
    );
    for (const purpose of ["ask", "explore", "work"] as const) {
      click("workflow.newSide", detail());
      const side = document.querySelector('[data-workflow="side-editor"]')!;
      fill("workflow.purpose", purpose, side);
      fill("workflow.assignment", purpose + " bounded task", side);
      fill("workflow.selection", "Selected context only", side);
      submit(side);
      await until(
        () =>
          actions.at(-1)?.kind === "side.create" &&
          (actions.at(-1) as { purpose?: string }).purpose === purpose,
        "Side action missing " + purpose,
      );
      await until(
        () => !document.querySelector('[data-workflow="side-editor"]'),
        "Side editor did not close",
      );
      const action = actions.at(-1)!;
      check(
        action.kind === "side.create" &&
          action.sourceSessionId === "main-chat" &&
          action.task === purpose + " bounded task",
        "Side binding lost",
      );
      check(
        action.kind === "side.create" &&
          (purpose === "work" ? action.authorizationId === grant.id : !action.authorizationId),
        "Side execution authority leaked",
      );
    }
    click("workflow.overview");
    // The Agent lives in the right work panel's project context; the header
    // entry asks the panel to show it.
    const openDock = () => {
      if (document.querySelector('[data-workflow="project-intent"]')) return true;
      const toggle = document.querySelector<HTMLButtonElement>("[data-project-agent-dock-toggle]");
      if (toggle && !toggle.disabled) flushSync(() => toggle.click());
      return Boolean(document.querySelector('[data-workflow="project-intent"]'));
    };
    await until(openDock, "Project Agent dock did not open");
    const intent = document.querySelector('[data-workflow="project-intent"]')!;
    check(!intent.querySelector("select"), "Project Agent required a workstream");
    fill("workflow.intentText", "Review a new direction", intent);
    check(!findButton("workflow.sendAgent", intent).disabled, "Project Agent submit unavailable");
    const originals = useAppStore.getState();
    const sent: { text: string; target: string }[] = [];
    let rejectSend = true;
    useAppStore.setState({
      activeSessionId: "unrelated-chat",
      refreshSessions: async () => {},
      selectSession: async (id: string) => { useAppStore.setState({ activeSessionId: id, page: "chat" }); },
      sendPrompt: async (text, _draft, target) => { sent.push({ text, target: target! }); return !rejectSend; },
    });
    submit(intent);
    await until(() => sent.length === 1 && document.querySelector('[role="alert"]'), "Agent failure was not visible");
    check(field("workflow.intentText", intent).value === "Review a new direction", "Failed send discarded project draft");
    flushSync(() => root.render(null));
    useAppStore.setState({ page: "project", projectConsoleId: "project-1", activeSessionId: null });
    mount();
    await until(openDock, "Project overview missing after remount");
    // Sending needs the reloaded snapshot; the Agent tab says so until it arrives.
    await until(() => !document.querySelector(".detached-conversation-notice"), "Agent tab stayed unavailable after remount");
    const restoredIntent = document.querySelector('[data-workflow="project-intent"]')!;
    check(field("workflow.intentText", restoredIntent).value === "Review a new direction", "Remount discarded project draft");
    rejectSend = false;
    submit(restoredIntent);
    await until(() => sent.length === 2 && !field("workflow.intentText", restoredIntent).value, "Successful send did not clear draft");
    check(sent.every((item) => item.target === "project-agent"), "Project prompt used unrelated active chat");
    check(actions.at(-1)?.kind === "agent.open", "Project Agent used fake workstream action");
    useAppStore.setState({ page: "project", projectConsoleId: "project-1", activeSessionId: null, refreshSessions: originals.refreshSessions, selectSession: originals.selectSession, sendPrompt: originals.sendPrompt });
    // Outputs and evidence live in the workstream detail rather than a tab.
    await selectPrimary();
    await until(
      () => document.querySelector('[data-workflow-artifact="candidate-7"]'),
      "Candidate missing",
    );
    const candidate = document.querySelector('[data-workflow-artifact="candidate-7"]')!;
    check(
      candidate.textContent?.includes("candidate-revision-7") &&
        candidate.textContent?.includes("Reload retains effective decisions"),
      "Candidate/evidence identity missing",
    );
    check(
      candidate.textContent?.includes("Synthetic IPC boundary; host persistence is not exercised"),
      "Evidence limits lost",
    );
    const reference = [...candidate.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.title === "/synthetic/continuity/report.html",
    );
    check(reference, "Candidate reference missing");
    flushSync(() => reference.click());
    await until(
      () => calls.some((call) => call.channel === IPC.invoke.projectWorkflowOpenReference),
      "Candidate reference did not cross IPC",
    );
    const opened = calls.find((call) => call.channel === IPC.invoke.projectWorkflowOpenReference)!
      .input as { projectId: string; kind: string; id: string };
    check(
      opened.projectId === "project-1" && opened.kind === "artifact" && opened.id === "candidate-7",
      "Candidate opener used a loose URI rather than authoritative identity",
    );
    click("workflowArtifacts.giveFeedback", candidate);
    const feedback = document.querySelector('[data-workflow-feedback-editor="candidate-7"]')!;
    fill("workflowArtifacts.feedbackComment", "Rendered candidate is readable", feedback);
    submit(feedback);
    await until(() => durable.feedback.length === 1, "Feedback missing");
    check(
      durable.feedback[0].candidateRevision === "candidate-revision-7",
      "Feedback not pinned to candidate revision",
    );
    click("workflow.overview");
    await selectPrimary();
    // Boundary rejection must remain visible and must not fabricate a mutation.
    click("workflow.editWorkstream", detail());
    const rejectedEditor = document.querySelector('[data-workflow="workstream-editor"]')!;
    fill("workflow.owner", "must-not-apply", rejectedEditor);
    rejectMutation = true;
    submit(rejectedEditor);
    await until(() => document.querySelector('[role="alert"]'), "Mutation rejection hidden");
    check(
      durable.workstreams[0].owner.ref === "continuity-owner",
      "Rejected mutation applied optimistically",
    );
    click("workflow.close", rejectedEditor);
    // Older in-flight refresh cannot overwrite the newer event snapshot.
    const oldRevision = durable.revision;
    holdNextSnapshot = true;
    click("workflow.retry");
    await until(() => heldSnapshot, "Snapshot was not held");
    durable.revision += 2;
    durable.workstreams[0].nextAction = "Newer event state";
    emit();
    await until(
      () =>
        document.querySelector("[data-workflow-test-revision]")?.textContent ===
        String(durable.revision),
      "Newer event not projected",
    );
    heldSnapshot!.resolve(ok(heldSnapshot!.snapshot));
    heldSnapshot = null;
    await frame();
    await frame();
    check(
      document.querySelector("[data-workflow-test-revision]")?.textContent ===
        String(oldRevision + 2),
      "Stale response replaced newer snapshot",
    );
    flushSync(() => root.render(null));
    mount();
    await until(
      () => document.querySelector(".workflow-workstream"),
      "Reload did not reconstruct snapshot",
    );
    await selectPrimary();
    check(detail().textContent?.includes("Newer event state"), "Reload reconstructed stale state");
    // Same-project navigation is also an intent boundary.
    useAppStore.setState({ page: "project", projectConsoleId: "project-1", activeSessionId: null });
    holdNextAction = true;
    click("workflow.discuss", detail());
    await until(() => heldAction, "Same-project action was not held");
    click("workflow.allWorkstreams");
    const otherWorkstream = [
      ...document.querySelectorAll<HTMLButtonElement>(".workflow-workstream"),
    ].find((button) => button.textContent?.includes("Independent validation"))!;
    flushSync(() => otherWorkstream.click());
    await until(
      () => document.querySelector(`[data-workstream-id="${durable.workstreams[1].id}"]`),
      "Other workstream was not selected",
    );
    heldAction!.resolve(
      ok({ snapshot: structuredClone(durable), sessionId: "late-side-from-old-workstream" }),
    );
    heldAction = null;
    await frame();
    await frame();
    check(
      useAppStore.getState().page === "project" &&
        useAppStore.getState().activeSessionId !== "late-side-from-old-workstream" &&
        document.querySelector(`[data-workstream-id="${durable.workstreams[1].id}"]`),
      "Late side result overrode selected workstream",
    );
    await selectPrimary();
    // A result arriving after project navigation may not steal focus into its session.
    holdNextAction = true;
    click("workflow.discuss", detail());
    await until(() => heldAction, "Action was not held");
    useAppStore.getState().setPage("settings");
    heldAction!.resolve(ok({ snapshot: structuredClone(durable), sessionId: "old-action-result" }));
    heldAction = null;
    await until(
      () => calls.some((call) => call.channel === IPC.invoke.sessionList),
      "Action session guard did not reach refresh boundary",
    );
    await frame();
    check(
      useAppStore.getState().page === "settings" &&
        useAppStore.getState().activeSessionId !== "old-action-result",
      "Late action stole navigation",
    );
    useAppStore.setState({ page: "project", projectConsoleId: "project-1", activeSessionId: null });
    click("workflow.search", document.querySelector(".workflow-header")!);
    fill("workflow.search", "continuity");
    submit(document.querySelector(".workflow-search-form")!);
    await until(() => document.querySelector(".workflow-search-results"), "Search results missing");
    check(
      document
        .querySelector(".workflow-search-results")
        ?.textContent?.includes("Continuity workspace / " + longTitle),
      "Search breadcrumb lost",
    );
    const hit = document.querySelector<HTMLButtonElement>(".workflow-search-results button")!;
    flushSync(() => hit.click());
    check(detail(), "Search workstream did not navigate");
    fill("workflow.search", "history");
    submit(document.querySelector(".workflow-search-form")!);
    await until(
      () => document.querySelector(".workflow-search-results button"),
      "Historical search result missing",
    );
    flushSync(() =>
      document.querySelector<HTMLButtonElement>(".workflow-search-results button")!.click(),
    );
    await until(
      () =>
        document.querySelector('[data-workflow-artifact="candidate-6"]')?.closest("details")?.open,
      "Historical search result stayed folded",
    );
    check(
      document.activeElement?.getAttribute("data-workflow-artifact") === "candidate-6",
      "Historical result did not receive focus",
    );
    useAppStore.setState({ activeSessionId: "main-chat", retainedSessionIds: ["main-chat"] });
    fill("workflow.search", "message");
    submit(document.querySelector(".workflow-search-form")!);
    await until(
      () => document.querySelector(".workflow-search-results button"),
      "Message search result missing",
    );
    flushSync(() =>
      document.querySelector<HTMLButtonElement>(".workflow-search-results button")!.click(),
    );
    await until(
      () => useAppStore.getState().transcriptViews["main-chat"]?.focus?.messageId === "m-search",
      "Message result did not use transcript jump",
    );
    check(useAppStore.getState().page === "chat", "Message hit did not select Chat destination");
    // The actual global creation helper must unfile a reused empty conversation.
    durable.folders.push({ id: "folder-test", name: "Existing folder", order: 0 });
    durable.navigation.push({
      sessionId: "empty-chat",
      folderId: "folder-test",
      order: 0,
      favorite: false,
    });
    durable.revision++;
    emit();
    await until(
      () =>
        document.querySelector("[data-workflow-test-revision]")?.textContent ===
        String(durable.revision),
      "Folder fixture did not project",
    );
    useAppStore.setState({
      page: "chat",
      activeSessionId: "empty-chat",
      workspace: undefined,
      messages: [],
      sessions: [{ ...agentSession, id: "empty-chat", projectPath: undefined, messageCount: 0 }],
    });
    flushSync(() =>
      document.querySelector<HTMLButtonElement>("[data-workflow-global-new]")!.click(),
    );
    await until(
      () => !durable.navigation.find((item) => item.sessionId === "empty-chat")?.folderId,
      "Global New Chat retained a reused folder",
    );
    check(
      useAppStore.getState().activeSessionId === "empty-chat",
      "Global creation lost the reusable conversation identity",
    );
    useAppStore.setState({
      page: "project",
      projectConsoleId: "project-1",
      activeSessionId: null,
      sessions: [agentSession],
    });
    click("workflow.overview");
    await selectPrimary();
    return {
      passed: true,
      actions: actions.map((action) => action.kind),
      mutations: mutations.map((command) => command.kind),
      revision: durable.revision,
    };
  },
  async consoleScreenshot(theme: string, target = "top") {
    document.documentElement.dataset.theme = theme;
    const searchToggle = findButton("workflow.search", document.querySelector(".workflow-header")!);
    if (searchToggle.getAttribute("aria-expanded") === "true") flushSync(() => searchToggle.click());
    if (target === "top") click("workflow.overview");
    if (target === "controls") {
      click("workflow.overview");
      await selectPrimary();
    }
    if (target === "artifacts") {
      click("workflow.overview");
      await selectPrimary();
      document.querySelector('[data-workflow-artifact="candidate-7"]')?.scrollIntoView({ block: "start" });
      await until(
        () => document.querySelector('[data-workflow-artifact="candidate-7"]'),
        "Candidate screenshot missing",
      );
    }
    await frame();
    document.getAnimations().forEach((animation) => animation.finish());
    await frame();
    if (target !== "artifacts") document.querySelector<HTMLElement>(".workflow-page")!.scrollTop = 0;
    if (target === "controls") detail().scrollIntoView({ block: "start" });
    await frame();
    return {
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      consoleWidth: document.querySelector(".workflow-console")!.clientWidth,
    };
  },
});
