---
description: "记忆与 LLM wiki 插件共享的知识库原语：扫描、条目框架、原子写入、包含判定、摘要、git 探测与托管 .gitignore 区块。"
kind: "package-library"
---

# @anago-harness/knowledge-common

[English](README.md) | 中文

## 概述

用本库实现与记忆、wiki 插件相同安全规则的、基于文件的持久知识库。它扫描文本中的秘密与非 ASCII 比例，用分隔行组织条目，在锁内原子写入文件，检查目标在符号链接之后仍位于根目录内，为 raw 源计算摘要，探测 git 状态，并维护带标记的 `.gitignore` 区块。两个产生副作用的接口（原子写入与 git）由调用方注入。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

由拥有知识库的插件消费；本包不注册任何内容，只依赖 Node 内置模块。

| 领域 | 入口 |
|---|---|
| 扫描 | `scanText`、`redactSecrets`、`nonAsciiRatio`、`NON_ASCII_WARN_RATIO`、`escapeFrameTagClosers` |
| 条目 | `parseDocument`、`serializeDocument`、`documentChars`、`isDuplicateEntry`、`isDelimiterLine`、`normalizeForMatch`、`countCodePoints` |
| 原子更新 | `updateFileLocked`、`readTextFileIfExists`、`PRIVATE_FILE_MODE`、`PRIVATE_DIRECTORY_MODE`、`SHARED_FILE_MODE` |
| 包含判定 | `resolveContainedTarget` |
| 审批 | `createApprovalGate`、`resolveEffectivePolicy`、`ApprovalPolicy`、`ApprovalServiceLike`、`ApprovalPrompt` |
| 注入 | `appendClaimedMessage`、`samePayload` |
| 摘要 | 对 frontmatter 之后的正文计算 sha256 |
| git | `resolveGitRoots`、忽略与跟踪文件探测 |
| `.gitignore` | 幂等的标记区块追加或替换，保留 CRLF |

两个接口是结构化的：`updateFileLocked` 接受 `{ withFileLock, writeFileAtomic }`，git 助手接受 `{ run }`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

文本规范化先移除格式字符，再做 NFKC、压缩空白、小写化，然后匹配。条目框架使用仅含分隔符的行，并按码点计数。原子写入创建私有目录、取文件锁、读取、更新并替换文件；任一步失败都保留原内容。包含判定先解析最深的已存在祖先再拼接缺失部分，然后比较真实路径，因此 `..` 与符号链接无法逃出根目录。摘要覆盖 frontmatter 之后的正文，避免自引用。`.gitignore` 区块按标记定位、原地替换，并保持文件原有的 CRLF 风格。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [memory](../memory/README.zh.md) — 基于本库的全局与工作区存储。
- [llm-wiki](../llm-wiki/README.zh.md) — 基于本包的项目与全局 wiki 存储。
- [atomic write](../../util/atomic-write/README.zh.md) — 调用方注入的锁与原子替换接口。

-----

<a id="model-experience"></a>
## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- git 助手会执行 `git` 可执行文件；没有 git 的调用方必须注入报告仓库缺失的 runner。
- 扫描器是启发式的，非 ASCII 比例阈值固定为 `0.1`，不能按调用方配置。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

自私有插件套件移植；除包名外公开 API 未变。
</details>
