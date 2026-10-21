# 项目工作流状态

> **翻译说明：** 本页对应 [英文源规格](/spec/02-architecture/project-workflow-state)。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

## 用途与所有权

项目工作流在不替换现有逻辑项目或会话模型的前提下，增加持久化、以项目为中心的 workstream。Rust `host-core` 独占 SQLite 状态，并校验项目、会话和消息身份。Electron Main 负责路由类型化 API 并连接 runtime；Node runtime 负责执行选择与生命周期；Renderer 负责呈现和用户交互。Renderer 不直接访问 SQLite，也不执行 Agent 工作；此领域不是插件 API。

每个工作流 `projectId` 都引用现有的 `ProjectGroupRecord.id`。会话和消息 ID 及其转录存储保持原义。工作流文件夹只影响导航：移动会话不会改变其项目绑定、工作区、上下文或权限。该状态为增量扩展，不会创建第二套项目身份或会话层级。

## 持久化聚合与修订契约

存储 schema v25 新增工作流聚合和命令账本；v26 新增持久化 Run 范围和回合绑定，并保留旧队列行。聚合存放版本为 1 的快照；新存储读取为 revision 0。每条类型化命令都在一个 SQLite 事务中应用，并通过全局 `expectedRevision` 比较并交换。成功命令只增加一次 revision，并在同一事务中记录 command ID 和结果。以相同 command ID 和输入重放会确认原命令结果并返回当前权威快照，revision 不增加；同 ID 不同输入或过期 revision 会产生冲突。调用方冲突后先刷新，不覆盖较新的快照。

快照可按项目或 workstream 筛选，但保留全局 revision。变更事件标明已提交 revision、命令和受影响范围；消费者应重新加载权威快照，而不是把事件当成替换状态。现有项目组、会话、消息及其 ID 仍是规范来源。

## 类型化边界

`packages/shared/src/project-workflow.ts` 定义版本化记录、schema、命令、结果、事件和 ports。公开 API 提供 `snapshot`、`mutate`、`action`、`search`、`openReference` 和 `onChanged`。Renderer 写入只接受 `ProjectWorkflowUserCommand`；runtime 专属的状态迁移、运行观察和交付修改只能通过可信 host port 进入。Main 校验白名单 IPC 负载，并为显式动作调用 runtime port。Rust RPC 负责持久化快照、修改和搜索。

快照记录 workstream 及其验收条件、负责人、依赖、阻塞项、下一步和候选产物；会话关系与可见性；带来源的资源与决策；显式授权；运行及观察到的副作用；候选产物、证据、反馈和结果交付。命令按能力分别定义，不存在任意状态替换命令。

## 工作流不变量

- 提案只有在带来源的显式采纳后才会成为有效决策；采纳会推进 workstream 的 decision revision。
- Run 启动时记录 workstream revision、decision revision 和授权。后续决策会隔离与之冲突的旧结果；过期交付可以保留为证据，但不能覆盖有效状态。
- 授权记录用户来源、操作/资源范围、权限上限、运行次数预算和停止条件。它不能超出已有 host 或工具权限；会话转录或模型提案不是授权来源。
- Run 结束不等于 workstream 验收。证据绑定精确的候选版本、环境和验收项。只有显式更新验收状态，且每个条件都有当前候选的通过证据，workstream 才能完成。
- 当前候选改变后，已满足的验收项重新打开；已完成工作流的验收失效时恢复 ready，历史证据保留。
- 结果的已生成、已交付、已消费是不同状态。消费时记录结果已集成、保留、过期或冲突。
- 外部副作用不明时保留 `unknown` 状态供协调，不重放该动作。暂停、取消、阻塞和等待用户状态仅作用于相关工作；无关工作保持独立。
- 启动时先观察并持久化所有已有 Run，再派发已授权续步。恢复期间到达的终止通知会保留并排空，之后才开放公共操作。恢复失败时不派发；重试保留已接受 checkpoint 的精确下一步和范围。

## 绑定运行回合的工具权限

`session.beginTurn` 接受可选的 `workflowRunId`。Host 校验活动 Run、会话、项目、决策修订和用户授权，再把资源范围绑定到真实回合。初始派发资源不可被后续工具回执扩大；队列持久化保留该身份。

Host 在权限准入前及实际执行前检查绑定回合的权限。`Write` 和 `Edit` 只能写入捕获的输出资源；`Read` 还可读取有效规范资源及相关产物/交付输入，但不会获得其写权限。原 Host/工具权限仍然适用。前台 `Bash` 需要对具体命令单独批准一次，即使处于 Auto 或已有会话授权也一样。Shell 的影响可能超出捕获的路径，权限卡须明确说明此边界；Host 在进程准入时重新校验绑定与授权。其他未受控工具、后台及委派执行在副作用前返回 `WORKFLOW_RESOURCE_DENIED`。路径授权不等于进程沙箱。没有工作流绑定的普通回合保持原行为。

## 打开已记录引用

`openReference` 无需活动会话即可打开记录中的 artifact 或 resource，并返回 URI 与记录的 revision。对于本地路径，Main 会解析真实路径，并要求它位于该项目组已登记根目录内。HTTP(S) 引用使用现有 host URL gate。工作流记录只是引用，不授予文件系统或网络访问权限。

## 相关契约

- [项目工作流 MVP 产品契约](../../../project-workflow-mvp/PRODUCT.md)
- [项目工作流共享接口交接](../../../project-workflow-mvp/CONTRACT.md)
- [ADR：持久化项目工作流状态](../../../adr/project-workflow-durable-state.md)
