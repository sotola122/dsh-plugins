---
description: "当另一个 DSH 进程持有会话的写入租约时，把该会话的输入区显示为只读：本文说明轮询如何加上 lock-all 阻塞，以及哪些状态会清除它。"
kind: "package-reference"
---

# @anago-harness/client-ui-session-share

[English](README.md) | 中文

## 概述

当另一个 DSH 进程持有某个会话的写入租约时，Web UI 不应成为第二个写入者。本包为本浏览器列出的会话轮询 Host 的归属结果，并把被其他进程持有的会话显示为只读：输入区被阻塞，所有会续启 Agent 的控件同样禁用。对方释放租约、会话离开目录，或页面卸载时，阻塞会被清除。在这里打开会话从不取得写入归属，也不会启动 Agent。

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

在 Web 配置中挂载 `@anago-harness/anago-web`；它插入本包所需的唯一一行，浏览器半通过会话、会话界面与本地化服务取得其余依赖。

| 行 | 包 |
|---|---|
| `ui-session-share` | `@anago-harness/client-ui-session-share` |

| 字段 | 默认值 | 含义 |
|---|---|---|
| `ownerPollMs` | `1000` | 本页面列出的会话之间执行归属探测的间隔毫秒数。 |

该 `Config` 由浏览器半声明；行本身不携带配置。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

Node 半是空的 `apply`，仅让本包持有一个 Loader 行，使客户端模块系统为该裸说明符提供 `./client` 产物。浏览器半注册 `sessionShare` 字典并启动一个 `SessionOwnershipWatcher`：它订阅 `ctx.sessions.list`，对前 200 个列出的 id 调用 `ctx.remote.session.ownership`，并通过 `ctx.conversation.blocks` 写入阻塞。`held-elsewhere` 结果会加上 `{ reason: t('composer.heldElsewhere'), lock: 'all' }`；其他结果会清除该 watcher 自己加上的阻塞，watcher 保留自己加过阻塞的 id 集合，因此其他插件拥有的阻塞不会被误清。同一时间只运行一次探测；探测失败时保留上次已知的归属，并在每段连续失败中只警告一次；插件卸载时清除全部已加阻塞并停止计时器。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [anago-web](../anago-web/README.zh.md) — 插入该行的 bundle。
- [session-controller](../../api/session-controller/README.zh.md) — Host 归属探测与浏览器会话服务。
- [ui-conversation](../../client/ui-conversation/README.zh.md) — 本插件写入的输入区阻塞注册表。
- [插件设计](../../../ANAGO_PLUGINS_DESIGN.md) — 包拆分与共享规则。

-----

<a id="model-experience"></a>
## 模型体验

无，本插件只为人类加上浏览器输入区阻塞；它不注册提示词段落、工具 schema 或会话事件。

#### KV Cache 影响

无；本包不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `ownerPollMs` 是浏览器半 `Config` 的默认值；客户端入口当前收不到行配置，因此配置无法更改该间隔。
- 阻塞只是提示：写入租约仍由 Host 拒绝，因此在首次探测完成前抢发的提示会报错，而不是被拦截。
- 每次轮询最多探测 200 个列出的会话；超出该前缀的会话保持上次已知状态。
- `unknown` 结果表示探测无法判断，会清除阻塞；因此 Host 探测的瞬时故障会让输入区短暂显示为可写，直到下一次轮询成功。RPC 失败则保留上次状态。
- 已加上的阻塞保留加上时所用语言的文案；切换语言不会改写它，直到该会话状态再次变化。
- 本包不附带真实组合测试；挂载 `anago-web` 的 Web 配置才是组合路径，端到端检查属于 Web 测试通道。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包位于 `packages/client/*` 之外，客户端包校验器不会检查它；其清单测试维持 `dsh.client` 声明、`./client` 导出、schemastery 仅作为开发期浏览器依赖，以及不使用 CSS Modules 的约束。浏览器半针对真实本地化服务与脚本化的归属 Remote 进行验证。
</details>
