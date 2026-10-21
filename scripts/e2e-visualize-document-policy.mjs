#!/usr/bin/env node
/** Packaged document-policy probe. All HTTPS is intercepted; no provider is used. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
assert(args.has("--app") && args.has("--output"), "Use --app /path/PI-Desktop.app --output /path/evidence");
const appPath = resolve(args.get("--app"));
const output = resolve(args.get("--output"));
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(output, "isolated-policy-"));
for (const name of ["home", "data", "profile"]) await mkdir(join(scratch, name));
const executable = join(appPath, "Contents/MacOS", execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", join(appPath, "Contents/Info.plist")], { encoding: "utf8" }).trim());
const portServer = createServer();
await new Promise((ok) => portServer.listen(0, "127.0.0.1", ok));
const port = portServer.address().port;
await new Promise((ok) => portServer.close(ok));
const env = { ...process.env, HOME: join(scratch, "home"), PI_DESKTOP_DATA_DIR: join(scratch, "data"), ELECTRON_RENDERER_URL: "", PI_DESKTOP_START_MAXIMIZED: "0" };
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(scratch, "profile")}`], { cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
let appLog = "";
app.stdout.on("data", (value) => { appLog += value; });
app.stderr.on("data", (value) => { appLog += value; });
const events = [];
const intercepted = [];
let ws;
let sequence = 0;
const pending = new Map();
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
const allowedUrl = "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js";
const blockedUrl = "https://blocked.invalid/pi-visualize-policy.js";
const token = "pi-visualize-document-policy";
const fixtureJs = `window.__cdnLoaded=true;parent.postMessage({probe:${JSON.stringify(token)},kind:"cdn-loaded"},"*");`;
function call(method, params = {}, sessionId) {
  return new Promise((ok, fail) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); fail(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { ok, fail, timer });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
try {
  let target;
  const deadline = Date.now() + 20000;
  while (!target && Date.now() < deadline) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === "page" && item.url.includes("/out/renderer/index.html") && !item.url.includes("surface=")); } catch {}
    if (!target) await pause(100);
  }
  assert(target, "packaged renderer target missing");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok) => ws.addEventListener("open", ok, { once: true }));
  ws.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); pending.delete(message.id);
      message.error ? request.fail(new Error(JSON.stringify(message.error))) : request.ok(message.result);
      return;
    }
    if (message.method === "Target.attachedToTarget") {
      const id = message.params.sessionId;
      void (async () => {
        await call("Fetch.enable", { patterns: [{ urlPattern: "https://*" }] }, id);
        await call("Runtime.runIfWaitingForDebugger", {}, id);
      })().catch((error) => events.push({ attachmentError: String(error) }));
    } else if (message.method === "Fetch.requestPaused") {
      const { requestId, request } = message.params;
      intercepted.push({ url: request.url, sessionId: message.sessionId ?? "parent" });
      const operation = request.url === allowedUrl
        ? call("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/javascript" }], body: Buffer.from(fixtureJs).toString("base64") }, message.sessionId)
        : call("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, message.sessionId);
      void operation.catch((error) => events.push({ interceptionError: String(error) }));
    } else if (["Runtime.exceptionThrown", "Log.entryAdded"].includes(message.method)) events.push(message);
  });
  await call("Runtime.enable");
  await call("Runtime.runIfWaitingForDebugger");
  await call("Page.enable");
  await call("Log.enable");
  await call("Fetch.enable", { patterns: [{ urlPattern: "https://*" }] });
  await call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await call("Page.reload", { ignoreCache: true });
  const readyDeadline = Date.now() + 20000;
  while (Date.now() < readyDeadline && !(await evaluate("!!document.body && document.readyState === 'complete'"))) await pause(100);
  const fragment = `<!doctype html><html><body><h1>policy fixture</h1><script>
const report=(kind,extra={})=>parent.postMessage({probe:${JSON.stringify(token)},kind,...extra},"*");
addEventListener("securitypolicyviolation",e=>report("child-violation",{blockedURI:e.blockedURI,directive:e.effectiveDirective,policy:e.originalPolicy}));
try { parent.document.body; report("parent-access-allowed"); } catch { report("parent-access-denied"); }
addEventListener("message",e=>{if(e.source===parent&&e.data?.probe===${JSON.stringify(token)}&&e.data.type==="report")report("snapshot",{intact:document.body.innerText.includes("policy fixture")});});
</script><script src="${allowedUrl}"></script><script src="${blockedUrl}"></script></body></html>`;
  await evaluate(`(() => {
    window.__policyMessages=[]; window.__mainPolicyViolations=[];
    addEventListener('message',e=>{if(e.data?.probe===${JSON.stringify(token)})window.__policyMessages.push(e.data)});
    addEventListener('securitypolicyviolation',e=>window.__mainPolicyViolations.push({blockedURI:e.blockedURI,directive:e.effectiveDirective,policy:e.originalPolicy}));
    const frame=document.createElement('iframe'); frame.id='visualize-policy-probe'; frame.sandbox='allow-scripts'; frame.style.cssText='position:fixed;inset:40px;width:800px;height:500px;background:white;z-index:99999';
    let initialized=false; frame.onload=()=>{if(initialized)return;initialized=true;frame.contentWindow.postMessage({source:'pi-visualize-host',type:'initialize',document:${JSON.stringify(fragment)}},'*')};
    frame.src='pi-visualize://frame/index.html'; document.body.append(frame);
    const mainScript=document.createElement('script');mainScript.src=${JSON.stringify(allowedUrl)};document.head.append(mainScript);
  })()`);
  let result;
  const proofDeadline = Date.now() + 15000;
  while (Date.now() < proofDeadline) {
    result = await evaluate("({messages:window.__policyMessages,mainViolations:window.__mainPolicyViolations,mainCdnExecuted:window.__cdnLoaded===true})");
    if (result.messages.some((item) => item.kind === "cdn-loaded") && result.messages.some((item) => item.kind === "child-violation" && item.blockedURI.includes("blocked.invalid"))) break;
    await pause(100);
  }
  assert(result.messages.some((item) => item.kind === "cdn-loaded"), "allowed CDN fixture did not execute in frame");
  assert(result.messages.some((item) => item.kind === "parent-access-denied"), "frame accessed parent DOM");
  assert(result.messages.some((item) => item.kind === "child-violation" && item.blockedURI.includes("blocked.invalid")), "unlisted origin was not denied by frame CSP");
  assert(result.mainViolations.some((item) => item.blockedURI === allowedUrl), "main renderer unexpectedly trusts CDN script");
  assert.equal(result.mainCdnExecuted, false);
  assert.equal(intercepted.filter((item) => item.url === allowedUrl).length, 1, "only the frame may request the CDN fixture");
  assert(!intercepted.some((item) => item.url === blockedUrl), "unlisted script escaped CSP before interception");
  await evaluate(`(() => { const frame=document.querySelector('#visualize-policy-probe');frame.contentWindow.postMessage({source:'pi-visualize-host',type:'initialize',document:'<p>overwritten</p>'},'*');frame.contentWindow.postMessage({probe:${JSON.stringify(token)},type:'report'},'*');})()`);
  const snapshotDeadline = Date.now() + 3000;
  while (Date.now() < snapshotDeadline && !(await evaluate("window.__policyMessages.some(x=>x.kind==='snapshot')"))) await pause(50);
  result = await evaluate("({messages:window.__policyMessages,mainViolations:window.__mainPolicyViolations,mainCdnExecuted:window.__cdnLoaded===true,frameUrl:document.querySelector('#visualize-policy-probe').src})");
  assert(result.messages.some((item) => item.kind === "snapshot" && item.intact), "repeated initialization replaced the frame document");
  const screenshot = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(join(output, "policy-frame.png"), Buffer.from(screenshot.data, "base64"));
  await writeFile(join(output, "result.json"), JSON.stringify({ ok: true, appPath, scratch, result, intercepted, events }, null, 2));
  console.log("PASS packaged visualize document policy: CDN fixture executes only in sandbox; unlisted origin and parent access denied; initialization is one-shot");
} catch (error) {
  await writeFile(join(output, "failure.json"), JSON.stringify({ error: String(error), stack: error.stack, appLog, events, intercepted }, null, 2));
  throw error;
} finally {
  ws?.close();
  if (app.exitCode === null) {
    const exited = new Promise((ok) => app.once("exit", ok));
    try { process.kill(-app.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    const timer = setTimeout(() => { try { process.kill(-app.pid, "SIGKILL"); } catch {} }, 5000);
    await exited; clearTimeout(timer);
  }
}
