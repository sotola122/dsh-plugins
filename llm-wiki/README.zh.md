---
description: "LLM wiki: project and global wiki stores with write, search, and lint tools plus a skill."
kind: "package-reference"
---

# @anago-harness/llm-wiki

[English](README.md) | 中文

## 概述

`llm-wiki` 为会话提供一个随仓库存放、可搜索的持久 wiki，以及一个由用户指定、用于跨项目共享知识的第二个 wiki。模型用 `wiki_search` 查找两个 wiki 已有的内容，用 `wiki_lint` 检查链接、目录和 `raw/` 摘要，用 `wiki_write` 写入全局 wiki；项目 wiki 仍使用普通的 `write` 与 `edit` 工具。`raw/` 原始资料保持不可变，`/wiki status`、`lint`、`reindex`、`repo set`、`repo unset` 和 `commit` 负责检查与维护。随包发布的 `anago-core` 行以 `global.pagesDir: concepts` 挂载本插件。

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

在组合中挂载本插件，把 `global.repo` 指向一个仓库，或者让用户运行 `/wiki repo set`，然后让模型通过三个工具工作。常见路径不需要项目侧准备：任何 git worktree 在首次向 `.dsh/wiki/` 写入页面时就获得一个项目 wiki。

### 两个 wiki、两条写入路径

| | 项目 wiki | 全局 wiki |
| --- | --- | --- |
| 位置 | `<checkout>/.dsh/wiki/` | 用户指定的仓库顶层 |
| 页面 | `pages/<slug>.md` | `<global.pagesDir>/<slug>.md`（默认 `pages`，随包行中为 `concepts`） |
| 写入方式 | `write` 与 `edit` | 仅 `wiki_write`；在该仓库内 `write` 和 `edit` 会以 `WIKI_READ_ONLY` 被拒绝 |
| `raw/` | 允许新建文件；已存在的原始资料会以 `WIKI_RAW_IMMUTABLE` 被拒绝 | `wiki_write` 创建原始资料、记录摘要，并拒绝已存在的文件 |
| 提交者 | 当 `.dsh/wiki.yml` 设置 `commit: true` 时，由分支的拉取请求提交 | 用户通过 `/wiki commit [message]` 提交 |

项目 wiki 的根来自在会话工作目录中运行 `git rev-parse --show-toplevel` 的结果。在该根之下的子目录中启动的会话可以读取 wiki，但不能写入；要在仓库根启动 `dsh` 才能编辑它。已提交的 wiki 跟随分支，因此这里写入的页面属于当前分支，并随其拉取请求一起流转。

在指定仓库之前，全局 wiki 处于禁用状态。`/wiki repo set <path>` 会校验路径（绝对路径或 `~/...`、必须是已存在的 git 仓库顶层、不得与会话工作目录或 `$DSH_HOME` 重叠），在缺失时创建骨架，并把选择记录到 `$DSH_HOME/llm-wiki-state/repo.json`；`/wiki repo unset` 向该文件写入 `{"disabled":true}`。该 sidecar 优先于配置中的 `global.repo`。

### 挂载配置

```yaml
- name: '@anago-harness/llm-wiki'
  config:
    notice: true
    global:
      repo: ''
      pagesDir: concepts
    writeApproval: none
```

本包没有 `dsh.bundle.patch`，因此作为插件行挂载；由 `anago-core` 这类 bundle 拥有该行以及任何预设分层。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `notice` | `true` | 通过 `agent/pre-step` 为每个会话注入一条存在通知。 |
| `global.repo` | `''` | 存放全局 wiki 的仓库；为空则禁用。sidecar 优先。 |
| `global.pagesDir` | `'pages'` | 全局仓库顶层下的一个目录名；`concepts` 适合已有的知识仓库。 |
| `writeApproval` | `'none'` | `ask` 在会话的有效审批策略为 `ask` 时让 `wiki_write` 询问；策略为 `never` 时会以 `WIKI_APPROVAL_UNAVAILABLE` 拒绝写入，因为无人能够批准。 |
| `write.maxPageBytes` | `65536` | 单个页面、`index.md` 或 `WIKI.md` 的上限。 |
| `write.maxRawBytes` | `262144` | 单个 `raw/` 原始资料的上限。 |
| `search.maxPages` | `5000` | 每个 wiki 根索引的页面数；更旧的页面会被丢弃并报告为 `truncated`。 |
| `search.maxPageBytes` | `65536` | 索引拒绝读取的页面大小。 |
| `search.maxPostingBytes` | `67108864` | 每个 wiki 根保留的 posting 字节数。 |
| `lint.checks` | `['links','index','raw']` | `wiki_lint` 与 `/wiki lint` 的默认检查；显式参数优先。 |

### 工具与命令

`wiki_search` 用 BM25 查询两个 wiki 的页面目录，最多返回八条命中，并附带一段引用摘录。命中中的 `path` 已经是 `wiki_write` 接受的路径形式。`wiki_lint` 在 `project`、`global` 或 `all` 上运行配置的检查：`links` 解析 `[[slug]]`、`[[global:slug]]`、`[[index]]`、路径形式和 `raw/` 原始资料；`index` 比较 `index.md` 与页面目录；`raw` 重新计算每个记录的 SHA-256。`wiki_write` 写入全局 wiki：完整内容或一处唯一的 `edit`、页面目录、`raw/`、`index.md` 和 `WIKI.md` 路径、为原始资料计算摘要、大小上限、注入扫描，以及在文件锁下的原子替换。

`/wiki` 从对话中提供同样的维护操作：`status` 打印两个根、页面数、写入模式和警告；`lint [links,index,raw]` 运行指定的检查或配置的默认值；`reindex` 重建两个搜索索引；`repo set <path>` 与 `repo unset` 管理全局 wiki；`commit [message]` 只暂存并提交页面目录、`raw/`、`index.md` 和 `WIKI.md`，且从不推送。

### raw/ 写入保护

`tools/pre-execute` 策略只检查 `write` 和 `edit` 的 `file_path`，且只检查 wiki 下的路径。已存在的项目 wiki `raw/` 文件会以 `WIKI_RAW_IMMUTABLE` 被拒绝；新的带日期原始资料则允许创建。已接受的全局仓库内的任何 `write` 或 `edit` 都会以 `WIKI_READ_ONLY` 被拒绝，因此全局 wiki 无法绕过 `wiki_write` 的路径规则、摘要记录、大小上限或扫描。`read` 从不被阻止。相对工具路径按会话的当前工作目录解析，因此 `cd` 之后的判定与实际写入的目标一致。检查会规范化父目录，因此 `..` 和符号链接的父目录无法逃出 `raw/`；检查与重命名之间的竞态仍然存在，而 `bash` 不在此策略范围内。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

插件是一个 Cordis 入口（`src/index.ts`），注册三个工具、一个 `/wiki` 命令、跨三个事件的四个监听器注册，以及 wiki 技能。它注入 `tools`、`skills` 和 `commands`；审批服务与工作目录服务按调用读取，缺失的审批服务视为 `never`，因此没有审批服务的部署会以 `WIKI_APPROVAL_UNAVAILABLE` 拒绝 `ask` 写入，而不是未经批准就写入。

根解析是非对称的。项目 wiki 通过在会话工作目录中运行 `git rev-parse --show-toplevel` 找到，可写性是包含关系测试：`<checkout>/.dsh/wiki` 必须位于该目录之内。全局 wiki 每个会话解析一次，在指定或会话变化前缓存，并针对仓库顶层、`$DSH_HOME` 和会话工作目录进行校验；重叠会为该会话禁用它，而不是在别处拒绝访问。

搜索索引是进程内的，每个 wiki 根一份。首次搜索遍历页面目录、解析 frontmatter 与正文，并构建 BM25 posting；之后的搜索对每个页面执行 `lstat`，只重新解析发生变化的文件，而两秒内的第二次搜索连目录遍历都会跳过。没有任何内容被持久化，`/wiki reindex` 会丢弃缓存的索引。

写入全局 wiki 会获取文件锁、创建父目录，并原子地替换文件。`raw/` 写入会计算 frontmatter 之后正文的 SHA-256 并记录；已存在的原始资料在任何写入之前就被拒绝。`.dsh/wiki.yml` 解析器读取 `commit`、容忍 `version` 键、对其他键发出警告，并把无法解析的文件视为 `commit: false`，因为克隆的仓库可能植入该文件。

| 文件 | 职责 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | 插件入口：导出 `name`、`inject`、`Config` 和 `apply`；注册工具、监听器、命令、技能 |
| [`src/paths.ts`](src/paths.ts) | 目录与链接语法、页面目录校验 |
| [`src/inspect.ts`](src/inspect.ts) | checkout 根、`.dsh/wiki.yml`、ignore 状态、只读规则 |
| [`src/global.ts`](src/global.ts) | 全局仓库校验、sidecar、骨架、每会话状态 |
| [`src/write.ts`](src/write.ts) | `wiki_write` 路径规则、摘要、上限、原子写入 |
| [`src/search.ts`](src/search.ts) | 分词、BM25 索引、增量刷新 |
| [`src/lint.ts`](src/lint.ts) | 链接、目录和 raw 摘要检查 |
| [`src/guard.ts`](src/guard.ts) | `tools/pre-execute` 的 raw 与全局 wiki 策略 |
| [`src/command.ts`](src/command.ts) | `/wiki status`、`lint`、`reindex`、`repo`、`commit` |
| [`SKILL.md`](SKILL.md) | 模型按需加载的规约 |

技能是一个注册项，其正文在插件加载时从 `SKILL.md` 读取；frontmatter 会被剥离，因此目录条目以字段形式携带 `name`、`description` 和 `whenToUse`。本包不附带 patch 文件：bundle 拥有各自的行。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [fork 分组](../README.zh.md) — 包地图与随包发布的 profile bundle。
- [knowledge-common](../knowledge-common/README.zh.md) — 本插件使用的共享原子写入、git、扫描和路径辅助模块。
- [anago-core](../anago-core/README.zh.md) — 以 `global.pagesDir: concepts` 挂载本插件的 bundle 行。
- [架构](../../../docs/architecture.zh.md) — 插件、注册表和工具策略如何组合在一起。
- [工具目录](../../../docs/tool-catalog.zh.md) — `wiki_search`、`wiki_lint` 和 `wiki_write` 的生成描述。

-----

<a id="model-experience"></a>
## 模型体验

### wiki 工具与存在通知

#### 模型看到什么

`wiki_search`、`wiki_lint` 和 `wiki_write` 的工具定义，通过 `agent/pre-step` 在第一步注入的一条存在通知，以及仅在模型加载时才出现的 `llm-wiki` 技能。

#### Token 影响

三个工具定义和一行通知在每个会话中固定；页面正文只在模型读取后才进入请求，一次搜索最多返回八条命中，每条附带 160 个字符的摘录。

#### KV Cache 影响

工具定义和通知占据稳定的前缀：通知只插入一次并在后续步骤复用，读取之前不会注入任何 wiki 内容，因此后续步骤复用同一缓存前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

机械检查与写入策略为部署和评审留下以下约束。

- 构建必须把 `SKILL.md` 放在 `lib/` 旁边：`src/skill.ts` 在插件加载时读取它，文件缺失会让加载失败，而不是静默注册空技能。
- 项目 wiki 的保护是 `write` 和 `edit` 上的策略，不是沙箱：`bash` 仍可修改 `.dsh/wiki`，而在包含检查与重命名之间被替换的路径分量不会被重新检查。
- 搜索索引是进程内的，并在加载时重建；`truncated: true` 报告被丢弃的页面，但不会让搜索失败，进程之间不持久化任何内容。
- 工作目录与 wiki 仓库重叠的会话会禁用全局 wiki，因此在该仓库内启动的会话无法通过 `wiki_write` 写入 wiki。
- `wiki_lint` 只检查链接、目录和 raw 摘要。孤立页面、重复页面、过期页面以及页面是否属实仍属于评审工作。
- raw 摘要检查比较记录的 `sha256` 与当前正文；它证明文件发生了变化，但不证明是谁改的，也不证明来源可信。
- 没有自动提交或推送：`/wiki commit` 只提交四个 pathspec，保留其他已暂存文件，且只有人能从对话中运行它。
- 移植只有单元测试和伪上下文覆盖；对技能目录、通知渲染和命令补全的实际 `dsh web` 回路检查仍未完成。
- 本包有意不附带 `cordis.patch.yml`：`anago-core` 拥有该行，其 `global.pagesDir: concepts` 意味着把页面放在 `pages/` 下的仓库必须覆盖该字段。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

移植自 `/data_1/git_workspace/dsh-plugins/packages/dsh-llm-wiki` 的 `@tep-hardware/dsh-llm-wiki` 0.1.0。相对导入使用显式 `.ts` 说明符，共享库导入改为 `@anago-harness/knowledge-common`，模块 JSDoc 使用 fork 包名。未复制 `cordis.patch.yml`；`anago-core` 行拥有挂载并设置 `global.pagesDir: concepts`。`SKILL.md` 位于包根，`src/skill.ts` 用 `new URL('../SKILL.md', import.meta.url)` 解析它，测试期间从 `src/`、生产构建从 `lib/` 得到的都是同一文件。测试：`./node_modules/.bin/vitest run packages/fork/llm-wiki/tests`（13 个文件，318 个测试）。

</details>
