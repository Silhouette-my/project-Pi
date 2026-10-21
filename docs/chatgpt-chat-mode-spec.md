# ChatGPT Chat 模式实现规格（apiStyle `chatgpt_conversation`）

> 交接规格文档。协议逆向已完成并实测验证，本文自包含：按此实现不需要再做任何逆向工作。
> 撰写日期：2026-10-19。对应仓库版本：v0.21.0-beta.4（589e5803a）。

## 0. 流程要求（先读仓库规则）

实现前必读 `AGENTS.md`（权威策略）与 `docs/spec/00-baseline.md`。本任务相关的硬性要求：

- **Worktree 隔离**：不在主检出或 `main` 上开发。`git fetch origin main` 后
  `git worktree add -b feat/chatgpt-chat-mode ../PI-Desktop-worktrees/chatgpt-chat-mode origin/main`。
- **验证命令**（按仓库验证表）：`pnpm --filter @pi-desktop/desktop typecheck`、`pnpm typecheck`、
  `pnpm -r --if-present test`；不跑无关的全量检查。
- **新功能的测试底线**：实现 + 用户路径与关键行为测试 + i18n/docs/changelog；
  "typecheck 过了"不是跳过测试的理由。
- **真实 provider 不是默认测试环境**：需要真实账号的 E2E（登录、真实对话、WebCodex 调用）由用户手动做，
  实现方只交付自动化部分并如实标注 NOT RUN 与原因。
- **E2E 场景命名**：语义化 ID，如 `E2E-PROVIDER-chatgpt-chat-login-and-stream`。
- **ADR 提示**：本设计新增"主进程 view 代发请求"的跨进程模式（类似 ADR 0019 的先例）。是否补一条
  ADR 由维护者决定；若补，放 `docs/adr/`。
- 架构边界不变：agent 执行仍在 sidecar，view 归主进程所有，Shared 只放跨边界契约。

## 1. 目标与动机

新增一种 provider apiStyle `chatgpt_conversation`，走 ChatGPT 消费端聊天后端
（`POST https://chatgpt.com/backend-api/conversation`，SSE），使用用户的 ChatGPT 订阅配额，
**不消耗 Codex 配额**。与现有 `openai_codex_responses` 并存，按会话选用。

UI 要求：完全融入 PI-Desktop 现有聊天界面，不出现任何嵌入式网页。唯一新增 UI 是设置里的
provider 选项 + 一次性"登录 ChatGPT"按钮。

## 2. 已验证事实（直接采用，勿重新探测）

### 2.1 认证与端点
- 消费端 GET 端点（`/backend-api/conversations`、`/backend-api/models`）用现有 Codex OAuth token 即可 200。
- 但 **POST `/backend-api/conversation` 有设备风控**：非浏览器登录会话上下文一律 403
  `"Unusual activity has been detected from your device. Try again later."`。
  实测排除项（全部仍 403）：合法 Sentinel token（`token('chat')`，~4.4KB）、完整 OAI-* 头、
  对齐的 oai-did、全新持久 partition、2 小时冷却。结论：**必须从已登录的 chatgpt.com 浏览器会话内发请求**。

### 2.2 Cloudflare
- curl/Node fetch 会被 CF managed challenge（`cf-mitigated: challenge`）；**Electron 的 Chromium 栈
  （net.request 与 renderer fetch）全部通过**，无需处理。

### 2.3 请求体（实测被后端接受，schema 正确）
新会话（省略 `parent_message_id`）：
```json
{ "action": "next",
  "messages": [{ "id": "<uuid>", "author": {"role": "user"},
    "content": {"content_type": "text", "parts": ["<用户输入>"]}, "metadata": {} }],
  "conversation_id": null, "model": "gpt-6", "requested_default_model": "gpt-6",
  "client_prepare_state": "N/A", "timezone_offset_min": 480, "timezone": "Asia/Shanghai",
  "history_and_training_disabled": false, "is_do_not_remember": false,
  "force_paragen": false, "reset_rate_limits": false,
  "supports_buffering": true, "supported_encodings": ["v1"] }
```
续聊：带 `conversation_id` + `parent_message_id`（上一条 assistant 消息 id，从 SSE 响应取），
`messages` 只放新增的 user 消息。

### 2.4 请求头（在页面上下文内 fetch 时）
登录后的 chatgpt.com 页面自带真实 Sentinel SDK，直接用页面的
`window.SentinelSDK.token('conversation')` 作为 `OpenAI-Sentinel-Token`。
**flow 字面量必须是 `conversation`**——Sentinel token 与 flow 绑定，风控会校验；
用其他 flow（如 `chat`）会得到合法 token 但 POST 返回 403。
证据：官方 bundle `completion.submit.request.stream_setup.sentinel_timing` 处调
`SentinelSDK.token('conversation')`。其余：
```
Content-Type: application/json
Accept: text/event-stream
x-openai-web-frontend: core_web
OAI-Product-Sku: chatgpt_web
OAI-Client-Version / OAI-Client-Build-Number: 取页面自身请求的当前值（可从页面网络请求观察）
OAI-Session-Id: <随机 uuid>
OAI-Device-Id: 与 oai-did cookie 一致
OAI-Language: <界面语言>
credentials: 'include'
```
（不需要 Authorization——cookie 会话即凭据。）

### 2.5 登录判定
在 view 内 `GET /backend-api/me` 返回 200 = 已登录。持久 partition 保证登录跨重启保留。

### 2.6 模型
v1 用静态目录（`gpt-6`，来自 `/backend-api/models` 的 `default_model_slug`）。动态拉取留作后续。

### 2.7 账号侧 MCP connector（WebCodex 等）——原生保留，无需客户端模拟
- connector 注册在 ChatGPT 账号侧，工具执行发生在 ChatGPT 服务端（后端 → WebCodex Server → 用户机器 Runner）。
  从登录会话发的请求默认可用账号已启用的 connector。
- 显式选择（可选，v1 可不发）：user 消息 `metadata.selected_mcp_sources`（数组，条目含 `status`，
  如 `"ONLY_ME"`）；`@` 提及用 `metadata.invoked_resource`。证据：官方 bundle 请求构造器
  `completion.submit.build_request_params.prompt_message` 处。
- 响应侧工具事件：SSE 元数据含 `tools_used`、`last_tool_used`、`mcp_events`、elicitation
  （`codex_mcp_elicitation`）。adapter 必须解析为工具活动事件供 UI 展示（"正在调用 WebCodex…"），
  未知事件类型安全忽略。

### 2.8 已否决的替代路线（勿再尝试）
- **纯协议自发 POST（无浏览器）**：设备风控过不去。2025-2026 存活的同类项目（如 chatgpt2api）靠
  持续追 Sentinel 握手 + CF clearance + 账号池 + 代理轮换维持，不适合单用户桌面应用。
- **提示词模拟工具**：不需要——用户的工具是账号侧 connector（见 2.7）。

## 3. 架构（三个部件，全部复用现有机制）

```
React 聊天 UI（现有，零改动）
   ↑ AgentEventEnvelope（现有 agent.event 通道）
sidecar（agent-runtime，Node 子进程）
   ├─ 新 adapter chatgpt-conversation.ts：实现 ProviderStreams；构造 2.3 请求体；
   │    经 host RPC 发请求；SSE 分块经 host.notification 推回 → 转 pi-ai 事件流
   ↓ host RPC "chatgpt.conversation.open" / ".cancel"
主进程（Electron main）
   └─ 新模块 chatgpt-chat-view.ts：隐藏 WebContentsView（持久 partition "persist:chatgpt-chat"）
        在页面上下文内 fetch + 读 SSE，逐块回传主进程
```

要点：
- 不新增 HTTP 服务器、不新增协议子系统：流式走现有 notification 机制（`agent.event` 同款）。
- WebContentsView 不 attach 到窗口时 webContents 仍可正常 fetch；仅登录时临时 attach 全尺寸供用户登录。
- 参考现有模式：`apps/desktop/electron/main/browser-view.ts`（WebContentsView + 持久 partition，ADR 0019）、
  `apps/desktop/electron/main/plugin-view-host.ts`（per-partition session）。

## 4. 挂载点与改动清单（file:line 基于 v0.21.0-beta.4）

新增：
- `apps/desktop/electron/main/chatgpt-chat-view.ts` — view 生命周期、status/login/logout、
  conversationOpen/cancel；给该 view 一个最小 preload 暴露 `window.__piBridge.send(payload)` → ipcMain。
- `packages/agent-runtime/src/chatgpt-conversation.ts` — ProviderStreams adapter（见 §5 签名说明）。
- 单元测试：请求体构造、SSE 解析、parent 映射、工具事件解析。

修改：
- `packages/shared/src/protocol.ts` — 新通道：renderer→main invoke（`chatgptChat.status/login/logout`）；
  sidecar→main host RPC（`chatgpt.conversation.open/cancel`）；main→sidecar notification
  （`chatgpt.conversation.chunk/end/error`）。renderer 通道加入 `IPC_WHITELIST`（:496）。
- `apps/desktop/electron/main/agent-sidecar.ts` — `HOST_PROXY_ALLOWED`（:51-78）加两个 RPC。
- `packages/agent-runtime/src/provider-binding.ts` — `apiBindingForStyle`（:160）注册
  （`defaultBaseUrl: https://chatgpt.com/backend-api`）；`:234 isOpenAiStyle` 分组酌情。
- `packages/shared/src/model-catalog.ts` — `API_STYLES`（:23）加 `chatgpt_conversation`。
- `apps/desktop/src/components/settings/provider-api-style.ts` — label、加入 CUSTOM 列表（非 account-only）。
- `apps/desktop/src/components/settings/ProviderConnectionFields.tsx`（:222 表单）— 该 style 不显示 API key
  输入，显示"登录 ChatGPT"按钮 + 登录状态（调 `chatgptChat.status`）。
- `packages/i18n/src/locales/*/index.ts` — 所有语言补 key。
- `packages/shared/src/model-config-import.ts`（:86）、`packages/shared/src/provider-endpoint.ts`（:227）— 映射。
- 不需要改 `electron/main/oauth.ts`（无 OAuth 流程，凭据= view 的 cookie 会话）。
- host-core 的 providers 表对 api_style 无枚举校验（自由字符串），Rust 侧不用改。

## 5. adapter 契约（ProviderStreams）

- 精确签名以 `pnpm install` 后 `node_modules/@earendil-works/pi-ai` 的 dist 类型为准
  （仓库有 `patches/@earendil-works__pi-ai@1.1.0.patch` 可参考改了什么）。
- 现成范例：`provider-binding.ts:499-519` `createExtensionAgentModels` 直接传 `stream: ProviderStreams`。
- 会话连续性：维护 pi 会话 → `{conversationId, lastParentId}` 映射，只发新增 user 消息；
  映射丢失（重启等）回退为新建会话重放历史（实现从简，注释说明）。
- 取消：sidecar 调 `chatgpt.conversation.cancel` → 主进程在页内 abort fetch。

## 6. 验证清单

自动：
1. `pnpm install`（环境见 §7）；
2. 仓库 typecheck 脚本（见 package.json）；
3. 新 adapter 单元测试通过（agent-runtime 已有测试基建，参考 stream-coalescer 测试）。

手动（需真实账号，实现者无法代做）：
1. 设置 → 添加 provider → 选 "ChatGPT（订阅 chat）" → 点登录 → 在浮层里完成 web 登录 → 状态变已登录；
2. 新会话选该 provider，发一句话，流式回复出现在现有转录 UI；
3. 多轮续聊（验证 parent 映射）；重启应用后免登录直接可用；
4. 启用 WebCodex 的账号：让模型读本地文件，确认工具被调用且 UI 有工具活动展示；
5. 确认该会话不消耗 Codex 额度（对照 platform.openai.com 或 Codex 用量页）。

## 7. 环境备注（中国网络）

- 代理：`export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897`
- Electron 二进制镜像：`export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
- 不改 `crates/`，无需 Rust 工具链。

## 8. 风险与注意

- **账号风控**：即使真实浏览器自动化也有账号级 "Suspicious Activity" 报告（codex-chatgpt-web #312/#317）。
  人驱动的对话频率天然低，风险小；但不要做后台自动发请求。
- **协议漂移**：Sentinel SDK 路径带版本（如 `/sentinel/20260219f9f6/sdk.js`）、OAI-* 头字段会演进。
  本设计把请求发在页面上下文内，页面自带 SDK 与 cookie，漂移面最小；若后端 4xx 突增，先对照
  网页版实际请求（DevTools Network）再修字段。
- **新会话首条消息**：`parent_message_id` 必须省略（客户端会剥掉 `client-created-root`），带上会 422。
- 隐藏 view 加载的是完整 chatgpt.com 应用页（有内存开销），这是过风控的必要代价，与同类项目
  （Proxima 等）一致。

## 附录 A：可复现探测脚本（Electron，验证 2.1/2.3/2.4）

在任意空目录 `npm i electron` 后存为 `probe.js` 运行 `npx electron probe.js`
（需先手动准备 `token.txt`/`account.txt` 仅用于 GET 验证；POST 部分不依赖它们）：

```js
const { app, BrowserWindow, session } = require('electron');
const sleep = ms => new Promise(r => setTimeout(r, ms));
setTimeout(() => app.quit(), 170000);
app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:probe');
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses } });
  await win.loadURL('https://chatgpt.com/');
  await sleep(6000);
  const out = await win.webContents.executeJavaScript(`(async () => {
    const log = [];
    const race = (p, ms, v) => Promise.race([p, new Promise(r => setTimeout(() => r(v), ms))]);
    let did = (document.cookie.match(/oai-did=([^;]+)/) || [])[1];
    if (!did) { did = crypto.randomUUID(); document.cookie = 'oai-did=' + did + '; path=/; max-age=31536000'; }
    const st = await new Promise(res => {
      const s = document.createElement('script');
      s.src = '/backend-api/sentinel/sdk.js';
      s.onload = () => res('bootstrap-loaded'); s.onerror = () => res('bootstrap-error');
      document.head.appendChild(s); setTimeout(() => res('bootstrap-timeout'), 10000);
    });
    log.push(st);
    const S = window.SentinelSDK;
    let tok = null;
    try { await race(S.init('calpico_init'), 12000, 'init-timeout'); } catch (e) {}
    try { tok = await race(S.token('conversation'), 15000, null); } catch (e) {}
    log.push('token:' + (typeof tok === 'string' ? 'len' + tok.length : String(tok)));
    const headers = {
      'Content-Type': 'application/json', 'Accept': 'text/event-stream',
      'x-openai-web-frontend': 'core_web', 'OAI-Product-Sku': 'chatgpt_web',
      'OAI-Client-Version': '2026.1019.00', 'OAI-Client-Build-Number': '4119082837',
      'OAI-Session-Id': crypto.randomUUID(), 'OAI-Device-Id': did, 'OAI-Language': 'zh-CN',
    };
    if (typeof tok === 'string' && tok.length > 20) headers['OpenAI-Sentinel-Token'] = tok;
    const body = { action: 'next',
      messages: [{ id: crypto.randomUUID(), author: { role: 'user' },
        content: { content_type: 'text', parts: ['Reply with exactly: PONG'] }, metadata: {} }],
      conversation_id: null, model: 'gpt-6', requested_default_model: 'gpt-6', client_prepare_state: 'N/A',
      timezone_offset_min: 480, timezone: 'Asia/Shanghai', history_and_training_disabled: false,
      is_do_not_remember: false, force_paragen: false, reset_rate_limits: false,
      supports_buffering: true, supported_encodings: ['v1'] };
    const r = await fetch('/backend-api/conversation', { method: 'POST', headers, credentials: 'include', body: JSON.stringify(body) });
    const text = await r.text();
    return JSON.stringify({ log, status: r.status, cf: r.headers.get('cf-mitigated') || 'none',
      first: text.slice(0, 300), pong: text.includes('PONG') }, null, 1);
  })()`);
  console.log('[result]', out);
  app.quit();
});
```

预期：未登录 → 403 风控（证明 2.1）；已登录（先在该窗口手动登录）→ 200 + `pong: true`（证明整条链路）。

## 附录 B：证据位置（临时，可能已清理）

- 探测工程：`/tmp/pi-probe/probeapp/main*.js`（main8.js 为最终版）；输出 `/tmp/pi-probe/final*.txt`
- 官方 bundle：`/tmp/pi-web/`（`8b34dbc2-*.js` = 会话请求构造器；`4813494d-*.js` = 头/Sentinel/工具事件；
  `sentinel-*.js` = Sentinel SDK）
- 关键 grep 锚点：`client_prepare_state`（请求体）、`completion.submit.build_request_params.prompt_message`
  （消息 metadata / selected_mcp_sources）、`selected_mcp_sources`、`mcp_events`、`tools_used`
