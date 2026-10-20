import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC, isProjectWorkflowUserCommand, isProjectWorkflowAction } from "@pi-desktop/shared";
import { projectWorkflowFixture } from "../../packages/shared/src/project-workflow-fixtures";
import { ProjectWorkflowProvider } from "../../apps/desktop/src/features/project-workflow/useProjectWorkflow";
import { WorkflowContext } from "../../apps/desktop/src/features/project-workflow/WorkflowContext";
import { WorkflowArtifacts } from "../../apps/desktop/src/features/project-workflow/WorkflowArtifacts";
import { api } from "../../apps/desktop/src/lib/api";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false, resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
let snapshot = projectWorkflowFixture();
snapshot.workstreams[0].currentCandidateId = "candidate-1";
const source = { kind: "user", ref: "fixture-user" };
snapshot.resources = [{ id: "foreign", projectId: "project-other", label: "FOREIGN-RESOURCE", uri: "/foreign", kind: "doc", revision: "a", state: "effective", source, updatedAt: "now" }];
snapshot.workstreams.push({ ...structuredClone(snapshot.workstreams[0]), id: "work-2", title: "Independent work", currentCandidateId: undefined });
snapshot.resources.push({ id: "secondary", projectId: "project-1", workstreamId: "work-2", label: "SECONDARY-RESOURCE", uri: "/secondary", kind: "skill", revision: "b", state: "effective", source, updatedAt: "now" });
snapshot.decisions = [
 { id: "alternative-1", projectId: "project-1", workstreamId: "work-1", title: "Alternative direction", statement: "Keep for comparison", state: "alternative", sources: [source], createdAt: "now" },
 { id: "superseded-1", projectId: "project-1", workstreamId: "work-1", title: "Earlier direction", statement: "Historical", state: "superseded", sources: [source], createdAt: "now" }
];
snapshot.artifacts = [{ id: "candidate-1", projectId: "project-1", workstreamId: "work-1", label: "Usable result", kind: "candidate", revision: "commit-abc", environment: "isolated profile", entryPoint: "/tmp/result.html", source, createdAt: "now" }];
snapshot.evidence = [
 { id: "test-1", projectId: "project-1", workstreamId: "work-1", candidateId: "candidate-1", candidateRevision: "commit-abc", environment: "unit harness", scenario: "Fixture tests", acceptanceId: "ac-1", outcome: "passed", kind: "unit", limits: "No live account", source, createdAt: "now" },
 { id: "deployment-1", projectId: "project-1", workstreamId: "work-1", candidateId: "candidate-1", candidateRevision: "commit-abc", environment: "staging", scenario: "Deployment check", acceptanceId: "ac-1", outcome: "not_run", kind: "deployment", limits: "Not authorized", source, createdAt: "now" }
];
snapshot.deliveries = ["produced", "delivered", "consumed"].map((state, index) => ({ id: "delivery-" + index, projectId: "project-1", workstreamId: "work-1", sourceRunId: "run-1", kind: "result", summary: "Result " + index, artifactIds: ["candidate-1"], sources: [source], decisionRevision: 0, state, disposition: ["pending", "stale", "conflict"][index], createdAt: "now" }));
snapshot.runs = [{ id: "run-1", projectId: "project-1", workstreamId: "work-1", sessionId: "session-1", executor: "local-agent", workstreamRevision: 0, decisionRevision: 0, authorizationId: "auth-1", state: "unknown", outcome: "Connection lost after dispatch", effects: [{ id: "effect-1", action: "write", resource: "/tmp/output", state: "unknown", detail: "Reconcile before retry" }], startedAt: "now", updatedAt: "now" }];
const calls = [];
const opened = [];
const changeListeners = new Set();
window.piDesktop = { platform: "darwin", on(channel, listener) { if (channel === IPC.event.projectWorkflowChanged) changeListeners.add(listener); return () => changeListeners.delete(listener); }, async invoke(channel, input) {
 if (channel === IPC.invoke.projectWorkflowSnapshot) return { ok: true, data: snapshot };
 calls.push({ channel, input });
 if (channel === IPC.invoke.projectWorkflowOpenReference) {
  const record = (input.kind === "artifact" ? snapshot.artifacts : snapshot.resources).find(x => x.id === input.id && x.projectId === input.projectId);
  if (!record) throw new Error("Unknown canonical reference");
  opened.push(input);
  return { ok: true, data: { opened: true, uri: input.kind === "artifact" ? record.entryPoint : record.uri, revision: record.revision } };
 }
 if (channel === IPC.invoke.projectWorkflowMutate) {
  if (!isProjectWorkflowUserCommand(input)) throw new Error("Invalid user command");
  if (input.expectedRevision !== snapshot.revision) throw new Error("Wrong revision");
  if (input.kind === "resource.put") snapshot.resources = [...snapshot.resources.filter(x => x.id !== input.resource.id), input.resource];
  else if (input.kind === "decision.propose") snapshot.decisions.push(input.decision);
  else if (input.kind === "decision.resolve") snapshot.decisions.find(x => x.id === input.decisionId).state = input.resolution === "dismiss" ? "dismissed" : "alternative";
  else if (input.kind === "feedback.add") { snapshot.feedback.push(input.feedback); snapshot.workstreams[0].acceptance[0].status = "reopened"; }
  else throw new Error("Unexpected mutation " + input.kind);
  snapshot.revision++;
  return { ok: true, data: { snapshot, replayed: false } };
 }
 if (channel === IPC.invoke.projectWorkflowAction) {
  if (!isProjectWorkflowAction(input) || input.kind !== "adopt") throw new Error("Invalid action");
  snapshot.decisions.find(x => x.id === input.decisionId).state = "effective";
  snapshot.revision++;
  return { ok: true, data: { snapshot } };
 }
 throw new Error("Unexpected IPC " + channel);
} };
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
function check(condition, message) { if (!condition) throw new Error(message); }
function button(text, within = document) { const found = [...within.querySelectorAll("button")].find(x => x.textContent.trim() === text); check(found, "Missing button " + text); return found; }
function field(text, within = document) { const label = [...within.querySelectorAll("label")].find(x => x.firstElementChild.textContent === text); check(label, "Missing field " + text); return label.querySelector("input,textarea,select"); }
async function enter(element, value) {
 const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
 Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
 element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
 await settle();
}
const rootNode = createRoot(document.getElementById("root"));
function show(workstreamId) {
 const open = async reference => { await api.projectWorkflow.openReference({ projectId: "project-1", ...reference }); };
 flushSync(() => rootNode.render(<ProjectWorkflowProvider><WorkflowContext projectId="project-1" workstreamId={workstreamId} onOpenReference={open} /><WorkflowArtifacts projectId="project-1" workstreamId={workstreamId} onOpenReference={open} /></ProjectWorkflowProvider>));
}
window.contextProbe = async () => {
 show("work-1"); await settle();
 check(!document.body.textContent.includes("FOREIGN-RESOURCE"), "Cross-project resource leaked");
 check(!document.body.textContent.includes("SECONDARY-RESOURCE"), "Different workstream resource leaked into scoped view");
 button("Add reference").click(); await settle();
 let editor = document.querySelector("[data-workflow-resource-editor]");
 await enter(field("Label", editor), "Design reference");
 await enter(field("Canonical path or URI", editor), "/tmp/design.md");
 await enter(field("Revision", editor), "r1");
 button("Save reference", editor).click(); await settle();
 const resource = snapshot.resources.find(x => x.label === "Design reference");
 check(resource && resource.workstreamId === "work-1", "New reference did not persist scoped identity");
 let row = document.querySelector('[data-workflow-resource="' + resource.id + '"]');
 button("/tmp/design.md", row).click(); await settle();
 check(opened[0].kind === "resource" && opened[0].id === resource.id && opened[0].projectId === "project-1" && !Object.hasOwn(opened[0], "uri"), "Canonical identity opener was not used");
 button("Edit reference", row).click(); await settle();
 editor = document.querySelector("[data-workflow-resource-editor]");
 await enter(field("Revision", editor), "r2");
 const resourceWritesBeforeEvent = calls.filter(x => x.input.kind === "resource.put").length;
 snapshot = { ...snapshot, revision: snapshot.revision + 1, resources: snapshot.resources.map(x => x.id === resource.id ? { ...x, uri: "/tmp/new-canonical-design.md", revision: "r-background", source: { kind: "file", ref: "/tmp/new-source.md", revision: "source-r2" }, updatedAt: "background-change" } : x) };
 for (const listener of changeListeners) listener({ revision: snapshot.revision, commandId: "background-update", kind: "resource.put", projectId: "project-1", workstreamId: "work-1" });
 await settle();
 editor = document.querySelector("[data-workflow-resource-editor]");
 check(editor.querySelector('[role="alert"]')?.textContent.includes("changed while you were editing"), "Background resource change did not surface a conflict");
 check(field("Revision", editor).value === "r2", "Background update discarded the draft");
 check(button("Save reference", editor).disabled, "Stale resource save remained enabled");
 editor.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
 await settle();
 check(calls.filter(x => x.input.kind === "resource.put").length === resourceWritesBeforeEvent, "Stale form submission overwrote authoritative resource");
 check(snapshot.resources.find(x => x.id === resource.id).uri === "/tmp/new-canonical-design.md", "Canonical URI was overwritten");
 button("Reload current reference", editor).click(); await settle();
 editor = document.querySelector("[data-workflow-resource-editor]");
 check(field("Revision", editor).value === "r-background" && field("Canonical path or URI", editor).value === "/tmp/new-canonical-design.md" && field("Source reference", editor).value === "/tmp/new-source.md", "Reload did not adopt authoritative reference/source");
 await enter(field("Revision", editor), "r2");
 button("Save reference", editor).click(); await settle();
 check(snapshot.resources.find(x => x.id === resource.id).revision === "r2", "Edit changed identity or lost revision");
 check(snapshot.resources.find(x => x.id === resource.id).uri === "/tmp/new-canonical-design.md" && snapshot.resources.find(x => x.id === resource.id).source.revision === "source-r2", "Reloaded edit lost newer URI/source metadata");
 row = document.querySelector('[data-workflow-resource="' + resource.id + '"]');
 button("Mark superseded", row).click(); await settle();
 check(document.querySelector('[data-workflow-resource="' + resource.id + '"]').textContent.includes("Superseded"), "Superseded state not visible");
 button("Propose decision").click(); await settle();
 editor = document.querySelector("[data-workflow-decision-editor]");
 await enter(field("Decision title", editor), "Use canonical design");
 await enter(field("Proposed change", editor), "Adopt only after explicit approval");
 button("Save proposal", editor).click(); await settle();
 const decision = snapshot.decisions.find(x => x.title === "Use canonical design");
 row = document.querySelector('[data-workflow-decision="' + decision.id + '"]');
 check(row.textContent.includes("Proposed"), "Proposal was silently effective");
 button("Retain alternative", row).click(); await settle();
 row = document.querySelector('[data-workflow-decision="' + decision.id + '"]');
 check(row.textContent.includes("Alternative"), "Alternative not retained");
 button("Adopt and continue", row).click(); await settle();
 check(calls.some(x => x.channel === IPC.invoke.projectWorkflowAction && x.input.kind === "adopt" && x.input.decisionId === decision.id), "Adoption did not reach runtime action");
 check(document.querySelector('[data-workflow-decision="' + decision.id + '"]').textContent.includes("Effective"), "Adopted state not visible");
 row = document.querySelector('[data-workflow-decision="alternative-1"]');
 button("Dismiss", row).click(); await settle();
 check(row.textContent.includes("Dismissed"), "Dismissed state not visible");
 const candidate = document.querySelector('[data-current-candidate="true"]');
 check(candidate.textContent.includes("commit-abc") && candidate.textContent.includes("isolated profile"), "Candidate identity incomplete");
 check(candidate.textContent.includes("Unit test") && candidate.textContent.includes("Deployment check") && candidate.textContent.includes("Not run") && candidate.textContent.includes("No live account"), "Evidence collapsed distinct verification limits");
 button("/tmp/result.html", candidate).click(); await settle();
 check(opened.some(x => x.kind === "artifact" && x.id === "candidate-1" && !Object.hasOwn(x, "uri")), "Result identity did not open");
 button("Report feedback", candidate).click(); await settle();
 editor = document.querySelector("[data-workflow-feedback-editor]");
 await enter(field("Environment", editor), "user macOS profile");
 await enter(field("Observation or counterexample", editor), "Still fails on existing project");
 button("Attach feedback", editor).click(); await settle();
 const feedback = snapshot.feedback[0];
 check(feedback.candidateId === "candidate-1" && feedback.candidateRevision === "commit-abc" && feedback.environment === "user macOS profile" && feedback.acceptanceId === "ac-1", "Feedback was not pinned to tested tuple");
 check(candidate.textContent.includes("Still fails on existing project"), "Feedback not visible");
 check(document.body.textContent.includes("Produced") && document.body.textContent.includes("Delivered") && document.body.textContent.includes("Consumed") && document.body.textContent.includes("Stale") && document.body.textContent.includes("Conflict"), "Delivery/consumption distinctions lost");
 check(document.body.textContent.includes("Outcome unknown") && document.body.textContent.includes("Effect unknown") && document.body.textContent.includes("Reconcile before retry"), "Unknown execution effects hidden");
 check(calls.every(x => x.input.projectId !== "project-other" && x.input.resource?.projectId !== "project-other"), "Unrelated project was mutated");
 show(); await settle();
 check(document.body.textContent.includes("SECONDARY-RESOURCE") && !document.body.textContent.includes("FOREIGN-RESOURCE"), "All-project context did not preserve project scope");
 return { passed: true, mutations: calls.filter(x => x.channel === IPC.invoke.projectWorkflowMutate).length };
};
`;

test("canonical context, explicit adoption, candidate feedback and truthful evidence user path", {
  skip:
    process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.workflow-context-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"development"' },
      alias: {
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(
      join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><div id="root"></div><script type="module" src="renderer.js"></script>',
    );
    await writeFile(
      join(temp, "main.cjs"),
      `const { app, BrowserWindow } = require("electron"); const path = require("node:path"); app.setPath("userData", path.join(__dirname, "profile")); app.whenReady().then(async () => { const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } }); try { await win.loadFile(path.join(__dirname, "index.html")); console.log("CONTEXT_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.contextProbe()"))); app.exit(0); } catch (error) { console.error(error?.stack ?? error); app.exit(1); } });`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      process.env.PI_WORKFLOW_TEST_ELECTRON ?? resolveElectronBinary(root).electronBinary,
      [join(temp, "main.cjs")],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output += chunk;
      });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output.slice(-6000));
    const result = output.split(/\r?\n/).find((line) => line.startsWith("CONTEXT_PROBE "));
    assert.ok(result, output.slice(-6000));
    assert.deepEqual(JSON.parse(result.slice("CONTEXT_PROBE ".length)), {
      passed: true,
      mutations: 7,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
