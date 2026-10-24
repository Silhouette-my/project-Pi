#!/usr/bin/env node
/** Production Electron project overview and read-only structure journey.
 * Usage: node scripts/e2e-project-structure-ui.mjs [--output /absolute/evidence-dir]
 * Seeds durable state through the real Rust Host; all acceptance interactions use the real DOM.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repositoryRoot, assertDesktopBuild, resolveElectronBinary } from "./e2e/boot.mjs";
import { Host } from "./e2e/host.mjs";

const root = resolve(repositoryRoot());
assertDesktopBuild(root);
const sourceCommitAtRun = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const sourceChangesAtRun = execFileSync("git", ["status", "--short"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const builtCommitArg = process.argv.indexOf("--built-commit");
const builtCommit = builtCommitArg >= 0 ? process.argv[builtCommitArg + 1] : undefined;
if (builtCommitArg >= 0 && !builtCommit)
  throw new Error(
    "--built-commit requires the commit identifier used for the built Electron JavaScript",
  );
const hostBuiltCommitArg = process.argv.indexOf("--host-built-commit");
const hostBuiltCommit = hostBuiltCommitArg >= 0 ? process.argv[hostBuiltCommitArg + 1] : null;
if (hostBuiltCommitArg >= 0 && !hostBuiltCommit)
  throw new Error(
    "--host-built-commit requires the source commit used to build the Rust Host binary",
  );
const outputArg = process.argv.indexOf("--output");
const output =
  outputArg < 0
    ? await mkdtemp(join(tmpdir(), "pi-structure-ui-production-"))
    : resolve(process.argv[outputArg + 1]);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(output, "state-"));
const home = join(scratch, "home"),
  data = join(scratch, "data");
for (const path of [home, data]) await mkdir(path, { recursive: true });
const hostBinary =
  process.env.PI_DESKTOP_HOST_BIN || join(root, "target/debug/pi-desktop-host-core");
const appBinary = process.env.PI_DESKTOP_APP_BIN;
const electronBinary =
  appBinary || process.env.PI_DESKTOP_ELECTRON_BIN || resolveElectronBinary(root).electronBinary;
const json = JSON.stringify,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sequence = 0,
  projectId,
  main,
  page,
  frameClient,
  debugPort,
  child,
  log = "",
  finalSnapshot;
async function freePort() {
  const server = createNetServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function until(check, name, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${name}\n${log.slice(-5000)}`);
}
async function connect(port, type, predicate = () => true) {
  const target = await until(async () => {
    try {
      return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (item) =>
          item.type === type &&
          predicate(item) &&
          (type !== "page" ||
            (item.url.includes("/out/renderer/index.html") && !item.url.includes("surface="))),
      );
    } catch {
      return null;
    }
  }, `CDP ${type}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl),
    pending = new Map();
  await new Promise((done) => ws.addEventListener("open", done, { once: true }));
  ws.addEventListener("message", ({ data }) => {
    const msg = JSON.parse(String(data)),
      item = pending.get(msg.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(msg.id);
    msg.error ? item.reject(new Error(json(msg.error))) : item.resolve(msg.result);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout ${method}`));
        }, 30000);
      pending.set(id, { resolve, reject, timer });
      ws.send(json({ id, method, params }));
    });
  return {
    ws,
    call,
    evaluate: async (expression) => {
      const result = await call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(json(result.exceptionDetails));
      return result.result.value;
    },
  };
}
async function stopApp() {
  frameClient?.ws.close();
  main?.ws.close();
  page?.ws.close();
  main = page = undefined;
  if (!child || child.exitCode !== null) return;
  const current = child,
    exited = new Promise((done) => current.once("exit", done));
  try {
    process.kill(-current.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-current.pid, "SIGKILL");
    } catch {}
  }, 5000);
  await exited;
  clearTimeout(timer);
}
async function startApp() {
  const ports = [await freePort(), await freePort()];
  debugPort = ports[0];
  const env = {
    ...process.env,
    HOME: home,
    PI_DESKTOP_DATA_DIR: data,
    PI_DESKTOP_HOST_BIN: hostBinary,
    PI_DESKTOP_PLAN_UI_PROBE: "1",
    PI_DESKTOP_TEST_API_KEY: "local-fixture",
    PI_DESKTOP_TEST_BASE_URL: "http://127.0.0.1:9/v1",
    PI_DESKTOP_TEST_MODEL: "ui-fixture",
    ELECTRON_RENDERER_URL: "",
    PI_DESKTOP_START_MAXIMIZED: "0",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(
    electronBinary,
    [
      `--remote-debugging-port=${ports[0]}`,
      `--inspect=${ports[1]}`,
      `--user-data-dir=${join(scratch, "profile")}`,
      ...(appBinary ? [] : ["."]),
    ],
    { cwd: join(root, "apps/desktop"), env, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });
  main = await connect(ports[1], "node");
  page = await connect(ports[0], "page");
  await until(
    () =>
      page.evaluate(
        "!!window.piDesktop && !!document.querySelector('.app-shell:not(.is-booting)')",
      ),
    "React-ready renderer and preload",
  );
  await until(
    () => main.evaluate("typeof globalThis.__PI_DESKTOP_PLAN_UI_PROBE === 'function'"),
    "setup probe",
  );
}
const invoke = async (key, ...args) => {
  const result = await page.evaluate(
    `piDesktop.invoke(piDesktop.channels.invoke[${json(key)}],...${json(args)})`,
  );
  assert.equal(result.ok, true, `${key}: ${json(result)}`);
  return result.data;
};
const snapshot = () => invoke("projectWorkflowSnapshot", { projectId });
const mutate = async (kind, fields) =>
  invoke("projectWorkflowMutate", {
    kind,
    commandId: `ui-e2e-${++sequence}`,
    expectedRevision: (await snapshot()).revision,
    ...fields,
  });
const clickText = async (text, selector = "button") =>
  page.evaluate(
    `(() => { const el=[...document.querySelectorAll(${json(selector)})].find(x=>x.textContent?.trim().includes(${json(text)}) && !x.disabled); if(!el) return false; el.click(); return true })()`,
  );
const clickAria = async (label, selector = "button[aria-label]") =>
  page.evaluate(
    `(() => { const el=[...document.querySelectorAll(${json(selector)})].find(x=>x.getAttribute('aria-label')===${json(label)} && !x.disabled); if(!el) return false; el.click(); return true })()`,
  );
const fillByLabel = async (label, value) =>
  page.evaluate(
    `(() => { const labels=[...document.querySelectorAll('label')]; const label=labels.find(x=>x.textContent?.trim().startsWith(${json(label)})); const input=label?.querySelector('input,textarea,select') || (label?.htmlFor && document.getElementById(label.htmlFor)); if(!input) return false; const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value')?.set; setter?.call(input,${json(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); return true })()`,
  );
const fillControl = async (selector, value) =>
  page.evaluate(
    `(() => { const input=document.querySelector(${json(selector)}); if(!input) return false; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value').set.call(input,${json(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); return true })()`,
  );
const submitForm = async (selector) =>
  page.evaluate(
    `(() => { const form=document.querySelector(${json(selector)}); if(!form) return false; form.requestSubmit(); return true })()`,
  );
const capture = async (name) => {
  const shot = await page.call("Page.captureScreenshot", { format: "png" });
  await writeFile(join(output, name), Buffer.from(shot.data, "base64"));
};
const openProjectHome = () => page.evaluate(`(() => { const el=document.querySelector('[data-sidebar-project-group] .sidebar-project-cube'); if(!el) return false; el.click(); return true })()`);

const workspace = join(scratch, "structure-fixture");
const viewerSource = process.env.PI_ARCHIFY_FIXTURE_DIR;
if (!viewerSource)
  throw new Error(
    "PI_ARCHIFY_FIXTURE_DIR must identify the standard finalized Archify fixture directory",
  );
const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
const selectView = async (name) => {
  assert.ok(
    (await clickText(name, ".project-structure-heading button")) ||
      (await clickText(
        name === "Architecture" ? "架构" : name === "Git" ? "Git" : "对话树",
        ".project-structure-heading button",
      )),
  );
  await until(
    () =>
      page.evaluate(
        `!!document.querySelector('[data-project-structure="${name === "Git" ? "git" : name === "Architecture" ? "architecture" : "sessions"}"]')`,
      ),
    `${name} view`,
  );
};
async function openHome() {
  await page.evaluate(
    `(() => { const group=document.querySelector('[data-project-agent="'+${json(projectId)}+'"]')?.closest('[data-sidebar-project-group]');const toggle=group?.querySelector('.project-toggle');if(toggle?.getAttribute('aria-expanded')==='false')toggle.click(); })()`,
  );
  assert.ok(await openProjectHome());
  await until(
    () => page.evaluate("!!document.querySelector('[data-project-overview]')"),
    "project overview",
  );
}
try {
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(
    join(workspace, "src/fixture.ts"),
    "export const fixture = 1;\nexport const stable = true;\n",
  );
  git("init", "-b", "main");
  git("config", "user.name", "Structure Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("add", "src/fixture.ts");
  git("commit", "-m", "Initial source");
  git("checkout", "-b", "feature");
  await writeFile(join(workspace, "feature.txt"), "feature\n");
  git("add", "feature.txt");
  git("commit", "-m", "Feature branch");
  git("checkout", "main");
  await writeFile(join(workspace, "main.txt"), "main\n");
  git("add", "main.txt");
  git("commit", "-m", "Main branch");
  git("merge", "--no-ff", "feature", "-m", "Merge fixture feature");
  const head = git("rev-parse", "HEAD");
  const artifactPath = ".archify/architecture-viewer-fixture-20261021-01";
  await mkdir(join(workspace, artifactPath), { recursive: true });
  for (const name of ["candidate.json", "viewer-fixture.html"])
    await copyFile(join(viewerSource, name), join(workspace, artifactPath, name));
  await writeFile(
    join(workspace, ".archify/source-reference.json"),
    json({
      schema_version: 1,
      diagram_type: "architecture",
      meta: { title: "Current-source reference fixture", repository: { revision: head } },
      nodes: [{ id: "source", sources: [{ path: "src/fixture.ts", line: 1, end_line: 2 }] }],
    }),
  );
  await writeFile(
    join(workspace, "src/fixture.ts"),
    "export const fixture = 2;\nexport const stable = true;\n",
  );
  const seed = new Host(hostBinary, data, { env: { HOME: home }, quiet: true });
  try {
    await seed.start();
    projectId = (
      await seed.call("project.group.create", { name: "Project structure", folders: [workspace] })
    ).group.id;
  } finally {
    await seed.stop();
  }
  await startApp();
  const setup = await main.evaluate(
    `globalThis.__PI_DESKTOP_PLAN_UI_PROBE({operation:'liveSetup',workspace:${json(workspace)}})`,
  );
  assert.equal(setup.ok, true, json(setup));
  const createSession = async (title) => {
    const { session } = await invoke("sessionCreate", {
      projectPath: workspace,
      providerId: setup.providerId,
      modelId: setup.modelId,
    });
    await invoke("sessionRename", session.id, title);
    return session.id;
  };
  await invoke("sessionRename", setup.sessionId, "Main implementation");
  const branch = await createSession("Architecture exploration"),
    descendant = await createSession("Isolated question"),
    historical = await createSession("Unlinked historical discussion");
  const now = new Date().toISOString();
  await mutate("workstream.create", {
    workstream: {
      id: "structure-work",
      projectId,
      title: "Ship project structure",
      goal: "Keep real progress and relationships visible across sessions",
      acceptance: [
        { id: "accept", title: "Review project views", status: "pending", evidenceIds: [] },
      ],
      owner: { kind: "user", ref: "Project owner" },
      status: "ready",
      blocker: {
        reason: "Needs a product review",
        owner: "Project owner",
        resumeWhen: "Review the isolated candidate",
      },
      priority: 0,
      order: 0,
      dependencyIds: [],
      nextAction: "Inspect Sessions, Git and Architecture",
      mainSessionId: setup.sessionId,
      revision: 0,
      decisionRevision: 0,
      createdAt: now,
      updatedAt: now,
    },
  });
  for (const [sessionId, parentSessionId, relation, purpose, archived] of [
    [branch, setup.sessionId, "branch", "explore", false],
    [descendant, branch, "child", "ask", true],
  ])
    await mutate("conversation.link", {
      conversation: {
        sessionId,
        parentSessionId,
        relation,
        purpose,
        archived,
        projectId,
        workstreamId: "structure-work",
        sourceRevision: 0,
        visibility: "project",
        readContext: { resourceIds: [], includeDecisions: true, includeArtifacts: false },
        returnPolicy: purpose === "ask" ? "none" : "proposal",
        order: 0,
      },
    });
  await page.call("Page.reload");
  await until(
    () => page.evaluate("!!document.querySelector('.app-shell:not(.is-booting)')"),
    "renderer refreshed session inventory",
  );
  await page.evaluate("document.documentElement.dataset.theme='light'");
  await openHome();
  assert.ok(
    await page.evaluate(
      "document.querySelector('[data-project-overview]').textContent.includes('Needs a product review')",
    ),
  );
  assert.ok(
    await page.evaluate(
      "document.querySelector('[data-project-overview]').textContent.includes('0 / 1')",
    ),
  );
  await capture("project-overview.png");
  assert.ok((await clickText("Structure")) || (await clickText("项目结构")));
  await until(
    () => page.evaluate(`!!document.querySelector('[data-project-session-node="${descendant}"]')`),
    "child relationship",
  );
  assert.ok(
    await page.evaluate(
      `document.querySelector('[data-project-session-node="${branch}"] [data-project-session-node="${descendant}"]') !== null`,
    ),
  );
  assert.ok(
    await page.evaluate(
      `document.querySelector('[data-project-session-node="${historical}"]').textContent.includes('Unlinked historical discussion')`,
    ),
  );
  await page.evaluate(
    `document.querySelector('[data-project-session-node="${descendant}"] .project-session-node').click()`,
  );
  assert.ok(
    await page.evaluate(
      `document.querySelector('[data-project-session-detail="${descendant}"]').textContent.match(/Answers stay here|回答留在此处/)`,
    ),
  );
  await capture("project-session-tree.png");
  assert.ok(
    (await clickText("Open conversation", ".project-session-detail button")) ||
      (await clickText("打开对话", ".project-session-detail button")),
  );
  await until(
    () =>
      page.evaluate(
        `!!document.querySelector('[data-sidebar-session-row="${descendant}"][aria-current]') || document.querySelector('.conversation-topbar')?.textContent.includes('Isolated question')`,
      ),
    "opened exact child conversation",
  );
  await openHome();
  assert.ok((await clickText("Structure")) || (await clickText("项目结构")));
  await selectView("Git");
  await until(
    () => page.evaluate("document.querySelectorAll('[data-project-commit]').length===4"),
    "four real Git commits",
  );
  assert.equal(
    await page.evaluate("document.querySelectorAll('.project-git-graph path').length"),
    4,
    "merge graph has its two parent edges",
  );
  await until(
    () =>
      page.evaluate(
        "document.querySelector('.project-git-detail').textContent.includes('src/fixture.ts')",
      ),
    "working file diff loaded",
  );
  await page.evaluate(`document.querySelector('[data-project-commit="${head}"]').click()`);
  await until(
    () =>
      page.evaluate(
        "document.querySelector('.project-git-detail').textContent.includes('feature.txt')",
      ),
    "selected merge first-parent diff",
  );
  await capture("project-git-graph.png");
  await selectView("Architecture");
  await until(
    () => page.evaluate("!!document.querySelector('.project-architecture-frame')"),
    "standard Archify viewer iframe",
  );
  assert.equal(
    await page.evaluate(
      "document.querySelector('.project-architecture-frame').getAttribute('sandbox')",
    ),
    "allow-scripts",
  );
  assert.ok(
    await page.evaluate(
      "document.querySelector('.project-architecture-frame').src.startsWith('pi-visualize:')",
    ),
  );
  const { root: domRoot } = await page.call("DOM.getDocument");
  const { nodeId } = await page.call("DOM.querySelector", {
    nodeId: domRoot.nodeId,
    selector: ".project-architecture-frame",
  });
  const { node } = await page.call("DOM.describeNode", { nodeId });
  assert.ok(node.frameId, "preview iframe has a frame identity");
  frameClient = await connect(debugPort, "iframe", (target) => target.id === node.frameId);
  const frameEval = (expression) => frameClient.evaluate(expression);
  await until(
    () => frameEval("document.querySelectorAll('svg [data-node-id]').length >= 3"),
    "standard viewer SVG topology rendered",
  );
  const before = await frameEval("document.querySelector('svg').outerHTML");
  await frameEval(
    "document.querySelector('svg [data-node-id=fixtureReader]').dispatchEvent(new MouseEvent('click',{bubbles:true}))",
  );
  await until(
    () =>
      frameEval(
        "!!document.querySelector('svg[data-focus-active]') || document.querySelector('svg').outerHTML !== " +
          json(before),
      ),
    "viewer node selection changes rendered state",
  );
  assert.equal(
    await frameEval("(()=>{try{return !!parent.document.body}catch{return false}})()"),
    false,
    "sandbox must not access parent DOM",
  );
  await capture("project-archify-viewer.png");
  // The artifact picker is the shared menu select: open it, then choose the row.
  await page.evaluate(
    "document.querySelector('.project-architecture-picker .settings-menu-select-trigger').click()",
  );
  await until(
    () =>
      page.evaluate(
        "(()=>{const option=[...document.querySelectorAll('.settings-menu-select-option')].find(x=>x.textContent.includes('source-reference.json'));if(!option)return false;option.click();return true})()",
      ),
    "architecture artifact menu option",
  );
  await until(
    () =>
      page.evaluate(
        "document.querySelector('.project-architecture-meta').textContent.match(/Source has changed|源码已有变化/)",
      ),
    "generated/current-source distinction",
  );
  assert.ok(await clickText("src/fixture.ts:1", ".project-source-links button"));
  await until(
    () =>
      page.evaluate(
        "document.querySelector('[data-project-source]').textContent.includes('fixture = 2')",
      ),
    "current source line range",
  );
  await capture("project-architecture-source.png");
  const finalGit = await invoke("projectStructureGitSnapshot", { projectId });
  assert.equal(finalGit.repositories[0].head, head, "read-only views must not change HEAD");
  assert.equal(git("rev-parse", "HEAD"), head);
  await writeFile(
    join(output, "result.json"),
    json({
      ok: true,
      sourceCommitAtRun,
      sourceChangesAtRun,
      builtCommit,
      hostBuiltCommit,
      projectId,
      coverage: [
        "overview Host progress and blocker",
        "real child/branch tree and unlinked history",
        "exact session opening",
        "commit-parent DAG and merge diff",
        "standard finalized Archify viewer rendered in product sandbox with node selection",
        "opaque parent isolation",
        "stale generated revision and current source range",
        "read-only HEAD preservation",
      ],
      interaction: "production Electron DOM and isolated-frame CDP interactions; no model calls",
    }),
  );
  await Promise.all(
    ["failure.txt", "failure.png"].map((name) => rm(join(output, name), { force: true })),
  );
} catch (error) {
  await writeFile(
    join(output, "failure.txt"),
    String(error.stack ?? error) + "\n" + log.slice(-9000),
  );
  if (page) {
    try {
      await capture("failure.png");
    } catch {}
  }
  throw error;
} finally {
  await stopApp();
}
console.log(`Project structure UI passed: ${output}`);
