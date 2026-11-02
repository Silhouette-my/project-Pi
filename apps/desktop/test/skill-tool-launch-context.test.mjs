import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { AgentSidecar } = await import("../../../packages/host-runtime/src/agent-sidecar.ts");
const { createSkillTool } = await import("../electron/main/runtime/skill-tool.ts");
const VISUALIZE = "pi-desktop/visualize";

function fixture(t) {
  const source = `
    const rl = require('node:readline').createInterface({ input: process.stdin });
    const pending = new Map();
    let sequence = 0;
    rl.on('line', line => {
      const request = JSON.parse(line);
      if (request.method === 'loadSkill') {
        const id = 'skill-' + ++sequence;
        pending.set(id, request.id);
        console.log(JSON.stringify({ id, method: 'host.proxy', params: {
          method: 'tools.execute', params: {
            sessionId: request.params.sessionId, toolCallId: id,
            toolName: 'Skill', mode: 'agent',
            visualizationsDir: '/model-forged-directory',
            args: { id: '${VISUALIZE}', visualizationsDir: '/model-forged-directory' }
          }
        }}));
      } else if (pending.has(request.id)) {
        const id = pending.get(request.id);
        pending.delete(request.id);
        console.log(JSON.stringify({ id, result: request.result, error: request.error }));
      } else if (request.method) {
        console.log(JSON.stringify({ id: request.id, result: { accepted: true } }));
      }
    });`;
  const sidecar = new AgentSidecar({
    launch: { command: process.execPath, args: ["-e", source] },
    onStderr: () => {},
  });
  t.after(() => sidecar.dispose());
  let disabled = [];
  sidecar.setLocalTool("Skill", createSkillTool({
    sessionProjects: new Map(),
    disabledBuiltinSkills: async () => disabled,
    loadUserSkillBody: async () => null,
    activeUserSkills: async () => [],
    plugins: { loadSkillBody() { throw new Error("Unknown skill"); }, getSkills: () => [] },
    pluginActiveInProject: () => true,
  }));
  return { sidecar, disable() { disabled = [VISUALIZE]; } };
}

test("on-demand Skill uses each session's captured launch contract over real stdio", async (t) => {
  const { sidecar, disable } = fixture(t);
  for (const method of ["agent.prompt", "agent.compact", "agent.executeApprovedPlan"]) {
    for (const enabled of [false, true]) {
      for (const remote of [false, true]) {
        const sessionId = `${method}-${enabled}-${remote}`;
        await sidecar.call(method, {
          sessionId,
          ...(enabled ? { visualizationsDir: `/synthetic/gen-ui/${sessionId}` } : {}),
          ...(remote ? { remoteWorkspace: { hostKey: "fixture", path: "/remote" } } : {}),
        });
        const result = await sidecar.call("loadSkill", { sessionId });
        assert.equal(result.ok, true);
        assert.match(result.content, enabled && !remote ? /::visualize\{"path":/ : /```visualize/);
      }
    }
  }

  // Other-session launches and model-provided context cannot switch this
  // runtime's skill. Its next launch is the point where the format changes.
  const sessionId = "agent.prompt-true-false";
  assert.match((await sidecar.call("loadSkill", { sessionId })).content, /::visualize\{"path":/);
  await sidecar.call("agent.prompt", { sessionId });
  assert.match((await sidecar.call("loadSkill", { sessionId })).content, /```visualize/);

  await sidecar.call("agent.prompt", { sessionId, visualizationsDir: "/synthetic/gen-ui" });
  await sidecar.call("agent.disposeSession", { sessionId });
  assert.match((await sidecar.call("loadSkill", { sessionId })).content, /```visualize/);

  await sidecar.call("agent.prompt", { sessionId, visualizationsDir: "/synthetic/gen-ui" });
  disable();
  const refused = await sidecar.call("loadSkill", { sessionId });
  assert.equal(refused.ok, false);
  assert.equal(refused.isError, true);
  assert.match(refused.content, /disabled in Settings/);
});
