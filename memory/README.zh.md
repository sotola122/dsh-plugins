---
description: "Persistent agent memory: global and workspace stores, the memory tool, and injected snapshots."
kind: "package-reference"
---

# @anago-harness/memory

[English](README.md) | 中文

## 概述

`@anago-harness/memory` 为 agent 提供跨会话保留的记忆。它管理两个全局 Markdown 存储（`$DSH_HOME/memories/MEMORY.md` 保存 agent 自己的笔记，`USER.md` 保存用户画像），以及一个仓库级存储 `<projectRoot>/.dsh/memory/MEMORY.md`——后者只在 git 工作树内存在。`memory` 工具在写锁内对单个存储执行最多 8 条 add/patch/remove 操作，全部成功或全部不写。会话开始时通过 `agent/pre-step` 注入一次冻结的 `<memory-snapshot>`；子 agent 只读地获得 workspace 存储；`/memory` 负责列出、查看、预览并处理已暂存的写入。回合结束后，review 读取已完成的回合并提出新条目，且始终作为待批准的暂存操作。条目格式、内容扫描和加锁写入由 `@anago-harness/knowledge-common` 提供。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

`anago-core` bundle 会把 `memory` 行插入 host profile，因此无需手工挂载。空的 `config:` 块就是完整配置，因为每个默认值都是设计默认值。

```yaml
- insert:
    - id: memory
      name: '@anago-harness/memory'
      config:
        limits: { memory: 2200, user: 1375, workspace: 2200 }
        workspace: { enabled: true, manageGitignore: true }
        presets: { exclude: [] }
        writeApproval: ask       # default none; ask enables the prompt and staging
        pending: { maxPerStore: 50 }
        review: { enabled: true, everyTurns: 5, maxRunsPerSession: 4,
                  maxInputBytes: 16384, maxOutputTokens: 1024,
                  timeoutMs: 60000, includeHeadless: false }
        lockWaitMs: 5000
```

| 配置项 | 默认值 | 作用 |
|---|---|---|
| `limits.memory` | `2200` | `$DSH_HOME/memories/MEMORY.md` 的码点上限。 |
| `limits.user` | `1375` | `$DSH_HOME/memories/USER.md` 的码点上限。 |
| `limits.workspace` | `2200` | `.dsh/memory/MEMORY.md` 的码点上限。 |
| `workspace.enabled` | `true` | 设为 `false` 时退化为仅全局记忆；workspace 存储从注入、工具和 review 中消失。 |
| `workspace.manageGitignore` | `true` | 首次写入 workspace 前维护受管的 `.gitignore` 块。 |
| `presets.exclude` | `[]` | 排除注入、`memory` 工具和 review 的 agent preset id。 |
| `writeApproval` | `none` | 设为 `ask` 时按会话的有效审批策略先询问，策略为 `never` 时改为暂存。 |
| `pending.maxPerStore` | `50` | 每个存储的暂存文件上限；再暂存会返回 `MEMORY_PENDING_FULL`。 |
| `review.enabled` | `true` | 是否运行回合结束 review。 |
| `review.everyTurns` | `5` | 累积多少个已完成回合后运行一次。 |
| `review.maxRunsPerSession` | `4` | 每个会话的 review 尝试次数，失败也计入。 |
| `review.maxInputBytes` | `16384` | 发送给辅助调用的对话摘录上限。 |
| `review.maxOutputTokens` | `1024` | review 输出的 token 上限。 |
| `review.timeoutMs` | `60000` | 单次 review 调用的中止预算。 |
| `review.includeHeadless` | `false` | headless 运行是否允许 review。 |
| `lockWaitMs` | `5000` | 写锁等待预算（毫秒）；超时写入失败并返回 `MEMORY_LOCK_TIMEOUT`。 |

`presets.exclude` 同时作用于注入、`memory` 工具和 review 三个面；默认 `[]` 保持全部 preset（包括 `minimal`）。子 agent 另由 `delegationDepth > 0` 排除。

**写入位置。** `$DSH_HOME/memories/MEMORY.md` 与 `USER.md` 以 `0600` 创建，目录为 `0700`。workspace 存储是 `<projectRoot>/.dsh/memory/MEMORY.md`，从会话 header 的 `cwd` 解析；不是 git 工作树的目录没有 workspace 存储，也不提供非 git 的替代模式。只有满足三个前提后，workspace 存储才可注入、可写入：能解析出 git 根、`.dsh/memory/MEMORY.md` 已被忽略、且 `.dsh/memory` 下没有已跟踪文件。

**写入审批。** 当 `writeApproval: ask` 时，任何携带至少一条操作的 `memory` 调用都由会话的有效策略决定（`ctx.approval.overrideOf(session) ?? config.policy`；部署中没有审批服务时视为 `never`）。策略为 `ask` 时返回 `{kind:'ask'}`，并给出英文和日文提示；被允许的调用正常写入，拒绝、取消或无人应答则不写任何内容。策略为 `never` 时调用被放行，但该次执行被标记，工具改为把每条操作暂存到 `$DSH_HOME/memories/pending/`。

**回合结束 review。** 已完成回合（`reason.kind === 'completed'` 的 `turn/end`）会累积，review 在 `agent/status` 变为 idle 时排出：当 `completed - consumed >= everyTurns` 且仍有尝试次数时发起一次辅助调用。结果始终暂存（`source: 'review'`），review 自身从不应用任何更改。调用复用会话自己的 provider 与 model 路由，每个插件实例同时只跑一轮；由 `agent/disposed`、卸载插件与 `timeoutMs` 中止，卸载时还会等待该轮完成最终的暂存与旁路文件写入。从该 idle 状态到这一轮结算为止，插件持有 agent（`ctx.agents.hold`），因此会释放空闲 agent 的控制器（`releaseOnIdle`）无法在 review 进行到一半时销毁它；成功、失败与卸载都会释放该持有。派发前会把精确请求（路由、system、messages、token 上限与 reasoning effort）作为仅日志事件 `memory/review-request` 追加到会话日志；失败时写一条警告并消耗一次尝试。

**凭据与秘密。** 插件不保存自己的 API key、token 或任何凭据，也不会索要它们。每条条目在写入、批准、注入以及 review 的输入与输出时都会经过 `@anago-harness/knowledge-common` 的内容扫描；形似秘密的文本会替换为 `[REDACTED:<kind>]`，并在工具结果中报告被替换的种类。review 通过 `ctx.llm` 走会话已有的路由，因此不新增凭据、不新增端点；派发前会把精确请求作为仅日志事件 `memory/review-request` 追加到会话日志，响应本身不记录。暂存文件位于 `$DSH_HOME`（工作树之外）且权限为 `0600`，`workspace-write` 沙箱无法在其中放置文件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

三个存储共用一种格式：条目之间以只含 `§` 的一行分隔，开头可选一段 HTML 注释作为 header，每个存储各有码点上限。超过上限的写入会被整体拒绝并返回 `MEMORY_LIMIT_EXCEEDED`；拒绝信息会列出结果中的每条条目及其长度，便于模型在一次调用内合并。被手工编辑到超限的文件会完整注入，并在标题中注明 "over the limit"。

工具主体定位一个存储后，调用 `@anago-harness/knowledge-common` 的 `updateFileLocked`，并传入 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock` 与 `writeFileAtomic`：`mkdir(0700)` → 加锁 → 读取 → 应用 → 原子写入 `0600`。整批操作都在同一把锁内完成，因此一条操作被拒也不会留下写了一半的文件。暂存路径复用同一函数，只多一个守卫：在锁内复查暂存时记录的条目。

注入在 `agent/pre-step` 的 `next()` 之后运行。监听器取回 payload 中按引用相同的消息，跳过被拒绝的 step 和空的首次 batch；当被本批认领的或仍留在派生消息面上的、`source.kind === 'memory'` 的 `user/message` 存在时，认为快照已可见——被 compaction 遮蔽后，下一步会重新注入。快照是一条持久化的 user 消息，声明 `{kind:'memory', form:'snapshot', sections}`，用 `<memory-snapshot>` 而不是 `system-reminder` 包裹（记忆是参考资料而不是指令），并对每条条目转义以防提前闭合框架。子 agent（`delegationDepth > 0`）只读取 workspace 存储，`agent/created` 还会在子作用域内 restrict 掉 `memory` 工具；工具自身的 `MEMORY_READ_ONLY` 拒绝是这一尽力而为措施的最终保证。注入中的任何失败都按存储隔离并记录日志，因为监听器抛异常会终止回合。

内容扫描是手工写入、`bash` 写入或外部 agent 写入内容的唯一防线：memory 路径不对 `write`/`edit`/`bash` 设 deny，因为 `bash` 本来就能写。被拒绝的条目会从快照中剔除，并在小节文本中给出数量。

审批由 `tools/pre-execute` 监听器和记录执行对象的 `WeakSet` 组成。`PreToolDecision.allow` 没有“标记为暂存”的字段，而重新读取策略无法区分“被批准的 ask”和“never”；注册表把同一个执行对象同时交给 waterfall 和 `tool.execute`，因此标记精确且永不被消费。`/memory` 提供 `list`、`show`、`path`、`pending`、`approve`、`reject`、`gitignore`。没有 `gitignore remove`；要停用请设 `workspace.manageGitignore: false` 或 `workspace.enabled: false`。

review 由三个监听器组成而不是一个：`session/event` 统计已完成回合，`agent/status` 排出，`agent/disposed` 中止。刻意不使用 `agent/turn-stopping` 和 `runMaintenance`，以免 review 拖住回合或后续输入。每个 `apply` 创建自己的 runner，因此插件实例之间不共享单飞槽位；`ctx.effect` 的清理器会停止新回合、中止进行中的一轮，并等待其结算（包括调用后的暂存与旁路文件写入）。排出时会为整轮持有 agent：持有在 review 第一次 await 之前取得，在 drain 的 `finally` 中释放，并由清理器等待，因此空闲释放与卸载都不会留下未释放的持有，也不会让这一轮在写入中途被中止。派发前 runner 会把精确请求作为仅日志事件 `memory/review-request` 追加到日志。进度保存在 `$DSH_HOME/memories/review/<sha256(sessionId)>.json` 的旁路文件（`reviewRuns`、`consumedCompleted`、`fullNotified`、`lastOutcome`），resume 后继续沿用同一预算。摘录从 `deriveMessages()` 由新到旧遍历，只保留 `user` 与 `model` 的 text 块直到 `maxInputBytes`，并附上当前条目；输出必须是单个 JSON 对象、最多 4 条操作，并经过与工具相同的校验（扫描、分隔符、上限、重复、非 ASCII 提示）后才暂存。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件导出与监听器接线 |
| [`src/config.ts`](src/config.ts) | Schemastery 配置与 preset 过滤 |
| [`src/tool.ts`](src/tool.ts) | `memory` 工具的定义与执行 |
| [`src/entries.ts`](src/entries.ts) | 操作、上限与非 ASCII 提示 |
| [`src/store.ts`](src/store.ts) | 存储位置与加锁读改写 |
| [`src/workspace.ts`](src/workspace.ts) | git 根、忽略规则与受管 `.gitignore` 块 |
| [`src/inject.ts`](src/inject.ts) | `agent/pre-step` 快照监听器 |
| [`src/snapshot.ts`](src/snapshot.ts) | 框架、小节与快照消息 |
| [`src/approval.ts`](src/approval.ts) | `tools/pre-execute` 门与暂存标记 |
| [`src/pending.ts`](src/pending.ts) | 暂存文件、校验与批准 |
| [`src/command.ts`](src/command.ts) | `/memory` 命令 |
| [`src/review.ts`](src/review.ts) | 回合结束 review 的调度与调用 |
| [`src/review-input.ts`](src/review-input.ts) | 对话摘录组装与输出解析 |
| [`src/agents.ts`](src/agents.ts) | agent 的结构化视图 |
| [`src/errors.ts`](src/errors.ts) | 拒绝码与消息 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [fork 分组](../README.zh.md) — 本分组的包地图。
- [`@anago-harness/knowledge-common`](../knowledge-common/README.zh.md) — 本包消费的条目格式、内容扫描、原子更新与 git 辅助函数。
- [`anago-core`](../anago-core/README.zh.md) — 插入 `memory` 行的 bundle。

-----

<a id="model-experience"></a>
## 模型体验

### memory 工具与结果

#### 模型看到什么

[`memory` 工具 schema](src/tool.ts) 接受 `target`（`memory`、`user`、`workspace`）和最多 8 条操作（`add` 带 `text`；`patch` 带 `old_text` 与 `text`；`remove` 带 `old_text`）。只读时省略 `operations`。结果报告实际应用的内容、结果用量、`[REDACTED:<kind>]` 替换、非 ASCII 提示条目、暂存 id，以及每个拒绝对应的稳定错误码（`MEMORY_DUPLICATE`、`MEMORY_NOT_FOUND`、`MEMORY_NOT_FOUND_AMBIGUOUS`、`MEMORY_REJECTED`、`MEMORY_LIMIT_EXCEEDED`、`MEMORY_NO_WORKSPACE`、`MEMORY_NO_IGNORE_RULE`、`MEMORY_GITIGNORE_CONFLICT`、`MEMORY_TRACKED`、`MEMORY_READ_ONLY`、`MEMORY_PENDING_FULL`、`MEMORY_PENDING_UNKNOWN`、`MEMORY_PENDING_STALE`、`MEMORY_PENDING_ALL_LIMIT`、`MEMORY_INVALID_OPERATION`、`MEMORY_DISABLED`、`MEMORY_IO`）。子 agent 的工具作用域里没有该工具；即使仍被调用，也会收到 `MEMORY_READ_ONLY`。

#### Token 影响

每次请求都有固定的 schema 成本；每次调用产生一份紧凑结果。超限拒绝是最大的结果，因为它刻意重复每条条目及其码点长度，便于模型一次调用完成合并。

#### KV Cache 影响

插件作用域与定义不变时，schema 前缀稳定。调用与结果追加在可复用前缀之后，不会使更早的条目失效。

### 注入的快照

#### 模型看到什么

每个会话一次，在回合中第一条被认领的消息之后，模型会收到一条由 `<memory-snapshot>` 与 `</memory-snapshot>` 包裹的持久 user 消息。它以固定的“参考资料”前言开头，随后每个存储一节：`## Global memory (MEMORY.md)`、`## User profile (USER.md)`，在 git 工作树中还有 `## Workspace memory (.dsh/memory/MEMORY.md)`；每节给出码点用量、扫描后的条目，以及扫描拒绝的条目数量。子 agent 只收到 workspace 一节。

#### Token 影响

条件性开销；通常受 `limits.memory` + `limits.user` + `limits.workspace`（默认 5,775 码点）加框架与标题限制。被手工编辑到超限的存储会完整注入，并带有超限注记。每个会话只插入一次，除非被 compaction 遮蔽。

#### KV Cache 影响

快照是本回合被认领消息之后的一条 user 消息，因此对会话余下部分只追加。只要它仍在派生消息面上，resume 或后续 step 都不会重复插入；compaction 后的重新注入会出现在更靠后的位置。

### 回合结束 review

#### 模型看到什么

辅助调用看到固定的 system 指令和对话摘录；它的提议不会展示给对话。人通过 `/memory pending` 与 `/memory approve` 处理。因此除非之后的快照或工具读取反映了已批准的条目，模型看不到 review 的输出。

#### Token 影响

每次尝试一份输入摘录（默认最多 16 KiB）和最多 `maxOutputTokens`（1,024）输出，与对话自身的请求无关。

#### KV Cache 影响

不影响对话请求的前缀：review 有自己的请求，并在派发前记录为仅日志事件 `memory/review-request`，该事件不进入模型可见面。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下是移植后插件的当前性质，不是任务清单。

- **暂存批准不是原子的** — 每条被批准的操作都会在存储锁内重新校验并写入；某条操作在暂存后失效，不会回滚此前已批准的操作。`approve all` 的上限（20 条操作、64 KiB）会整体拒绝一批，但不构成原子性保证。
- **内容扫描是词法层面的** — `knowledge-common` 的规则能识别秘密形态和部分指令形态的文本，但不理解语义。手工编辑或经 `bash` 写入的条目不会经过写入过滤；注入时的扫描是唯一防线，它会剔除被拒条目并报告数量。
- **memory 路径不对 `write`/`edit`/`bash` 设 deny** — 人或外部 agent 可以编辑这些文件，这是有意为之；`bash` 本来就能写，设 deny 只会掩盖真正的边界。
- **已跟踪的 workspace 文件会被拒绝** — 已经跟踪 `.dsh/memory` 的仓库需要执行 `git rm --cached -r .dsh/memory`；已提交的内容仍留在历史中。
- **受管的 `.gitignore` 块只是一次普通编辑** — 它会出现在 `git status`，插件不会提交它；删掉它只会让下次写入重新生成。要停用应设 `workspace.manageGitignore: false`，而不是删除该块。
- **暂存文件未经验证** — 任何能写 `$DSH_HOME/memories/pending` 的人都能放入格式正确的操作；批准前请先读 `/memory pending`，并且 `/memory approve` 不能替代阅读正文。
- **review 没有独立路由** — review 始终使用会话的 provider 与 model；独立 reviewer 路由尚未实现。
- **review 失败不重试** — 错误、超时、解析失败或校验失败只记录警告，并消耗一次尝试。
- **headless 判定是服务探测加 profile 名回退** — 改名后且未发布 `headlessStartup` 的 headless profile 会被视为交互式，因此 `review.includeHeadless: false` 不会排除它。
- **本仓库没有真实组合测试** — 上游的真实 profile 集成测试没有移植；审批的 Web 部分（`/memory` 的补全与执行、`ctx.approval` 行为、审批界面中的日文提示）在此未经验证。
- **覆盖率不是 100%** — 移植后的单元测试保留了上游用例，但本包不声称满足仓库的逐文件覆盖率门槛。
- **生成的工具目录尚未列出 `memory` 工具** — `docs/tool-catalog.md` 由 `scripts/gen-tool-catalog.ts` 中的包列表生成，本次移植没有修改它；在完成该注册前，schema 以 `src/tool.ts` 为准。
- **受管块仍使用上游包名** — `knowledge-common` 生成 `# >>> dsh-memory (managed by @tep-hardware/dsh-memory)`，这样磁盘上已有的块保持兼容；改名需要迁移已有文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

从 `dsh-plugins/packages/dsh-memory` 移植而来。移植只改动了 import 说明符（`@anago-harness/knowledge-common`、显式 `.ts` 扩展名）、模块 JSDoc 名称，并从 `assertWithinLimit`/`limitExceededDetail` 删除了未使用的 `target` 参数；其余行为不变。`cordis.patch.yml` 有意不随包发布，因为 `anago-core` 拥有该行；`knowledge-common` 现在是 workspace 包，上游 `tsup` 的 `noExternal` 打包已无必要。在仓库根目录运行 `./node_modules/.bin/vitest run packages/fork/memory/tests`。

</details>
