# ChatGPT chat 模式提示词 — 打磨交接文档

（给负责打磨提示词的 agent。工程接入已全部完成并测试通过，你只需要产出文案。）

## 背景一句话

PI-Desktop 新增了 ChatGPT 消费端 chat 模式（走用户 ChatGPT 账号配额）。该模式**没有任何本地工具**，所以桌面 agent 的系统提示词（工具规则、scratch、delegation 等）被整体替换为一小段"聊天指令"。这段文案的质量由你负责。

## 你要知道的核心事实

1. **你写的文案就是 system 消息的全部**。它逐字成为唯一的 system 段，不会有任何其他内容拼接（没有项目指令、没有 skills、没有工具说明）。写完即所见。
2. 三种状态：
   - **默认**：内置默认文案（当前占位，等你替换，见下）；
   - **无**：完全不发送 system 消息（纯 ChatGPT 网页行为）；
   - **预设**：用户选择的预设文件内容，逐字发送。
3. 当前内置默认（占位，待你打磨）在 `packages/agent-runtime/src/mode-prompts.ts:12-13`：
   > You are PI-Desktop in chat mode. Answer in the user's language. Be concise, direct, and actionable.

## 预设文件规则（用户侧）

- 目录：`<工作区>/.pi/chat-instructions/<id>.md`（项目级）和 `~/.pi/agent/chat-instructions/<id>.md`（全局级）；同名时项目级覆盖全局级。
- 预设 id = 文件名（去 `.md`）；只识别 `.md`；保留名 `none` 不作为文件预设。
- 内容上限 64 KiB（超出按 UTF-8 截断）——实际应远小于此，见约束。
- UI：chat 模式会话的 composer 工具条上有"聊天指令"下拉（默认 / 无 / 各预设），按会话持久化。

## 硬性约束（写文案时必须遵守）

- **不得引用任何本地工具**。模型不会收到工具声明，也永远无法调用 Read/Edit/Bash/Task 之类；写"你可以使用 X 工具"是无效指令。服务端能力（网页搜索、connector 等）由 ChatGPT 账号侧决定，可以以"如可用则……"的方式轻提，不要断言。
- **长度即成本**：system 段计入每次请求的 prefill 与账号配额。建议每个预设控制在几百 token 内，内置默认更应极短。
- **不依赖具体模型名**：服务端可能静默降智（执行模型 ≠ 请求模型），文案不要写"你是 GPT-x"或对特定模型行为做假设。
- 语言跟随、简洁度这类行为可以在文案里规定；思考深度（instant/low/…/extra_high）由桌面端选择器控制，与文案无关，不要写进文案。
- 文案是纯文本 Markdown，无模板语法、无变量插值。

## 需要你交付的东西

1. **内置默认文案**（替换上面的占位；英文源码，可双语意识——它要求模型跟随用户语言）。要求：极短、定义"聊天模式下的 PI-Desktop"身份、语言跟随、简洁直接；不要出现 "coding agent" 或任何工具措辞。
2. **三个示例预设**（中文为主，用户场景）：
   - `technical-discussion.md` — 严谨的技术架构讨论：权衡、取舍、量化、指出风险与反例，不空泛附和；
   - `q-and-a.md` — 解答问题：先给结论再给推理，区分事实/推断/不确定，长度与问题复杂度匹配；
   - `casual-chat.md` — 日常聊天：口语、简短、不端着，不主动展开技术内容。
   每个文件可直接放入 `~/.pi/agent/chat-instructions/` 使用；文件名即上述 id（可改，改了就同步说明）。

## 本地怎么验证（如果你能跑环境）

把预设文件放进 `~/.pi/agent/chat-instructions/`，在 chat 模式会话的"聊天指令"下拉里选中，下一条消息即生效（切换会重建一次远端会话并重放历史，属预期）。工程侧行为有单测覆盖：`packages/agent-runtime/src/chat-instructions.test.ts`、`chat-instructions-runtime.test.ts`。

## 工程侧现状（无需你改动）

发现/解析：`packages/agent-runtime/src/chat-instructions.ts`；组装门控：`runtime.ts` composeSystemPrompt（chatgpt_conversation 分支）；传输编码：`chatInstructions` undefined=内置默认 / ""=无 / 其他=逐字预设；UI 与持久化已接入。文案定稿后由主会话替换 `mode-prompts.ts` 常量并把示例预设放进仓库示例目录（如需）。
