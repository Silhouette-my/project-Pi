import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkflowConversation, WorkflowWorkstream } from "@pi-desktop/shared";
import { Button, Checkbox, Field, Input, Select, Textarea } from "../../components/ui";
import { IconChevronRight } from "../../components/icons";
import { useProjectWorkflow, type WorkflowAction } from "./useProjectWorkflow";
import { useAppStore } from "../../stores/app-store";
import { normalizeProjectPath } from "../../lib/sidebar-session-groups";

const lines = (text: string) =>
  text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

export function WorkflowControls({
  workstream,
  projectPaths,
  onOpenSession,
  onOpenSide,
  onCreateSession,
}: {
  workstream: WorkflowWorkstream;
  projectPaths: string[];
  onOpenSession: (id: string) => Promise<void>;
  /** Opens a created side conversation beside the console instead of navigating away. */
  onOpenSide?: (id: string) => void;
  onCreateSession: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { snapshot, action, mutate, busy } = useProjectWorkflow();
  const sessions = useAppStore((state) => state.sessions);
  const providers = useAppStore((state) => state.providers);
  const [executionSessionId, setExecutionSessionId] = useState(workstream.mainSessionId ?? "");
  const executors = sessions.filter((session) => {
    const provider = providers.find((item) => item.id === session.providerId);
    const link = snapshot?.conversations.find((item) => item.sessionId === session.id);
    return (
      session.mode === "agent" &&
      session.source !== "remote" &&
      provider &&
      provider.apiStyle !== "chatgpt_conversation" &&
      projectPaths.some(
        (path) => normalizeProjectPath(path) === normalizeProjectPath(session.projectPath),
      ) &&
      (!link || link.workstreamId === workstream.id)
    );
  });
  const selectedExecutor = executors.find((item) => item.id === executionSessionId);
  const [panel, setPanel] = useState<"side" | "authority" | null>(null);
  const [purpose, setPurpose] = useState<WorkflowConversation["purpose"]>("ask");
  const [visibility, setVisibility] = useState<WorkflowConversation["visibility"]>("project");
  const [task, setTask] = useState("");
  const [selection, setSelection] = useState("");
  const [includeDecisions, setIncludeDecisions] = useState(false);
  const [includeArtifacts, setIncludeArtifacts] = useState(false);
  const [resourceIds, setResourceIds] = useState<string[]>([]);
  const [authorizationId, setAuthorizationId] = useState("");
  const [actions, setActions] = useState("implement\ncheck\ndocument");
  const [resources, setResources] = useState("");
  const [maxRuns, setMaxRuns] = useState(5);
  const [stopConditions, setStopConditions] = useState("");
  const scope = { projectId: workstream.projectId, workstreamId: workstream.id };
  const authorizations =
    snapshot?.authorizations.filter(
      (item) =>
        item.workstreamId === workstream.id &&
        !item.revoked &&
        (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()),
    ) ?? [];
  const selectedAuthorization =
    authorizations.find((item) => item.id === authorizationId) ?? authorizations[0];
  const run = async (intent: WorkflowAction) => {
    const result = await action(intent);
    if (result?.sessionId) await onOpenSession(result.sessionId);
    return result;
  };
  const createSide = async () => {
    const result = await action({
      kind: "side.create",
      ...scope,
      purpose,
      visibility,
      task: task.trim(),
      readContext: { selection: selection.trim(), resourceIds, includeDecisions, includeArtifacts },
      sourceSessionId: purpose === "work" ? selectedExecutor?.id : workstream.mainSessionId,
      ...(purpose === "work" && selectedAuthorization
        ? { authorizationId: selectedAuthorization.id }
        : {}),
    });
    if (result?.sessionId) {
      if (onOpenSide) onOpenSide(result.sessionId);
      else await onOpenSession(result.sessionId);
    }
    if (result) {
      setTask("");
      setPanel(null);
    }
  };
  const grant = async () => {
    const result = await mutate({
      kind: "authorization.grant",
      authorization: {
        id: crypto.randomUUID(),
        ...scope,
        actions: lines(actions),
        resources: lines(resources),
        source: { kind: "user", ref: "project-console" },
        permissionCeiling: "ask",
        maxRuns,
        stopConditions: lines(stopConditions),
        revoked: false,
      },
    });
    if (result) setPanel(null);
  };
  return (
    <section className="workflow-controls" aria-label={t("workflow.controls")}>
      <div className="workflow-control-row">
        <Field label={t("workflow.executionSession")}>
          <Select
            title={t("workflow.executionHint")}
            value={selectedExecutor?.id ?? ""}
            onChange={(event) => setExecutionSessionId(event.target.value)}
          >
            <option value="">{t("workflow.chooseExecutionSession")}</option>
            {executors.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title} · {session.modelId}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="ghost" disabled={busy} onClick={() => void onCreateSession()}>
          {t("workflow.newExecutionSession")}
        </Button>
      </div>
      {/* The four flows of PRODUCT P4 stay visible and labelled; operational
          controls follow at a lower visual weight. */}
      <div className="workflow-actions workflow-primary-actions">
        <Button
          variant="primary"
          title={!selectedAuthorization ? t("workflow.authorityRequired") : undefined}
          disabled={
            busy || !selectedAuthorization || !selectedExecutor || workstream.status === "executing"
          }
          onClick={() =>
            selectedAuthorization &&
            selectedExecutor &&
            void run({
              kind: "start",
              ...scope,
              authorizationId: selectedAuthorization.id,
              sessionId: selectedExecutor.id,
            })
          }
        >
          {t("workflow.start")}
        </Button>
        <Button
          disabled={busy}
          onClick={() => void run({ kind: "discuss", ...scope, pause: false })}
        >
          {t("workflow.discuss")}
        </Button>
        <Button
          disabled={busy}
          onClick={() => void run({ kind: "discuss", ...scope, pause: true })}
        >
          {t("workflow.pauseDiscuss")}
        </Button>
        <Button
          disabled={busy}
          aria-expanded={panel === "side"}
          onClick={() => setPanel(panel === "side" ? null : "side")}
        >
          {t("workflow.newSide")}
        </Button>
      </div>
      <div className="workflow-actions workflow-secondary-actions">
        {workstream.status === "paused" ? (
          <Button variant="ghost" disabled={busy} onClick={() => void run({ kind: "resume", ...scope })}>
            {t("workflow.resume")}
          </Button>
        ) : (
          <Button
            variant="ghost"
            disabled={
              busy || workstream.status === "completed" || workstream.status === "cancelled"
            }
            onClick={() => void run({ kind: "pause", ...scope })}
          >
            {t("workflow.pause")}
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={busy || workstream.status === "cancelled" || workstream.status === "completed"}
          onClick={() => void run({ kind: "cancel", ...scope })}
        >
          {t("workflow.cancelWork")}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          aria-expanded={panel === "authority"}
          onClick={() => setPanel(panel === "authority" ? null : "authority")}
        >
          {t("workflow.authority")}
        </Button>
      </div>
      {authorizations.length > 1 ? (
        <Field label={t("workflow.selectedAuthority")}>
          <Select
            value={selectedAuthorization?.id ?? ""}
            onChange={(event) => setAuthorizationId(event.target.value)}
          >
            {authorizations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.actions.join(", ")} · {item.maxRuns}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {selectedAuthorization && (
        <details className="workflow-authority-details">
          <summary><IconChevronRight size={12} className="project-disclosure-icon" />{t("workflow.selectedAuthority")}</summary>
          <dl>
            <dt>{t("workflow.allowedActions")}</dt>
            <dd>{selectedAuthorization.actions.join(", ")}</dd>
            <dt>{t("workflow.allowedResources")}</dt>
            <dd>{selectedAuthorization.resources.join("\n")}</dd>
            <dt>{t("workflow.maxRuns")}</dt>
            <dd>{selectedAuthorization.maxRuns}</dd>
            <dt>{t("workflow.stopConditions")}</dt>
            <dd>{selectedAuthorization.stopConditions.join("\n")}</dd>
          </dl>
          <Button
            disabled={busy}
            onClick={() =>
              void mutate({
                kind: "authorization.revoke",
                ...scope,
                authorizationId: selectedAuthorization.id,
              })
            }
          >
            {t("workflow.revokeAuthority")}
          </Button>
        </details>
      )}
      {panel === "side" && (
        <form
          className="workflow-form"
          data-workflow="side-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void createSide();
          }}
        >
          <h3>{t("workflow.newSide")}</h3>
          <div className="workflow-form-grid">
            <Field label={t("workflow.purpose")}>
              <Select
                title={t(`workflow.policies.${purpose}`)}
                value={purpose}
                onChange={(event) => {
                  const next = event.target.value as typeof purpose;
                  setPurpose(next);
                  setIncludeDecisions(next !== "ask");
                  setIncludeArtifacts(next === "work");
                }}
              >
                {(["ask", "explore", "work"] as const).map((item) => (
                  <option key={item} value={item}>
                    {t(`workflow.purposes.${item}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("workflow.visibility")}>
              <Select
                value={visibility}
                onChange={(event) => setVisibility(event.target.value as typeof visibility)}
              >
                <option value="project">{t("workflow.projectVisible")}</option>
                <option value="side_only">{t("workflow.sideOnly")}</option>
              </Select>
            </Field>
          </div>
          <Field label={t("workflow.assignment")}>
            <Textarea
              autoFocus
              required
              rows={3}
              value={task}
              onChange={(event) => setTask(event.target.value)}
            />
          </Field>
          <Field label={t("workflow.selection")}>
            <Textarea
              rows={2}
              value={selection}
              onChange={(event) => setSelection(event.target.value)}
            />
          </Field>
          <Checkbox
            label={t("workflow.includeDecisions")}
            checked={includeDecisions}
            onChange={(event) => setIncludeDecisions(event.target.checked)}
          />
          <Checkbox
            label={t("workflow.includeArtifacts")}
            checked={includeArtifacts}
            onChange={(event) => setIncludeArtifacts(event.target.checked)}
          />
          {snapshot?.resources
            .filter(
              (item) =>
                item.projectId === workstream.projectId &&
                item.state === "effective" &&
                (!item.workstreamId || item.workstreamId === workstream.id),
            )
            .map((item) => (
              <Checkbox
                key={item.id}
                label={item.label}
                checked={resourceIds.includes(item.id)}
                onChange={(event) =>
                  setResourceIds((ids) =>
                    event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id),
                  )
                }
              />
            ))}
          <div className="workflow-actions">
            <Button
              type="submit"
              variant="primary"
              disabled={
                busy ||
                !task.trim() ||
                (purpose === "work" && (!selectedAuthorization || !selectedExecutor))
              }
            >
              {t("workflow.createSide")}
            </Button>
            <Button type="button" onClick={() => setPanel(null)}>
              {t("workflow.close")}
            </Button>
          </div>
        </form>
      )}
      {panel === "authority" && (
        <form
          className="workflow-form"
          data-workflow="authorization-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void grant();
          }}
        >
          <h3>{t("workflow.authority")}</h3>
          <p className="workflow-muted">{t("workflow.authorityHint")}</p>
                    <Field label={t("workflow.allowedActions")}>
            <Textarea
              required
              rows={2}
              value={actions}
              onChange={(event) => setActions(event.target.value)}
            />
          </Field>
          <Field label={t("workflow.allowedResources")}>
            <Textarea
              required
              rows={2}
              value={resources}
              onChange={(event) => setResources(event.target.value)}
            />
          </Field>
          <Field label={t("workflow.maxRuns")}>
            <Input
              type="number"
              required
              min={1}
              step={1}
              value={maxRuns}
              onChange={(event) => setMaxRuns(Number(event.target.value))}
            />
          </Field>
          <Field label={t("workflow.stopConditions")}>
            <Textarea
              rows={2}
              value={stopConditions}
              onChange={(event) => setStopConditions(event.target.value)}
            />
          </Field>
          <div className="workflow-actions">
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !lines(actions).length || !lines(resources).length || maxRuns < 1}
            >
              {t("workflow.grant")}
            </Button>
            <Button type="button" onClick={() => setPanel(null)}>
              {t("workflow.close")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
