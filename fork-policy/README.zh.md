---
description: "拒绝 harness 自行发起的、指向 denylist 主机的连接的 Node 出站守卫。"
kind: "package-library"
---

# @anago-harness/fork-policy

[English](README.md) | 中文

## 概述

`@anago-harness/fork-policy` 为 harness 自行联系的主机安装 Node 出站守卫，并提供启动组合器应用的 profile patch 列表。守卫拒绝 `denylist.json` 中的主机上的 TCP 连接、DNS 查询和代理请求目标。用户选择的端点，包括 `api.deepseek.com`，保持允许。导入本包即安装守卫。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

从启动 profile 的进程导入本包。导入会在插件运行前安装守卫，启动组合器会展开这些 patch 列表。

```ts
import { forkDefaultPatches, forkLockPatches, guard } from '@anago-harness/fork-policy'

const defaults = forkDefaultPatches([])
const locks = forkLockPatches([])
guard.verdict('platform.deepseek.com')
```

`forkDefaultPatches` 与 `forkLockPatches` 目前返回空列表。规范化后的主机名被拒绝时，`guard.verdict(host)` 返回原因字符串；连接可以继续时返回 `undefined`。`api.deepseek.com` 不被拒绝。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

守卫在加载它的进程中修补 `net.Socket` 的 connect 与 write、DNS 查询，以及子进程的 `NODE_OPTIONS`。匹配使用 ASCII 主机名：精确主机，以及列出的后缀及其子域。环回名称和 IP 地址不被拒绝。没有环境变量可以关闭 denylist。设置 `DSH_FORK_EGRESS_LOG` 时，每次拒绝追加一行 JSON。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 安装守卫并导出空的 profile patch 列表 |
| [`egress-guard.cjs`](egress-guard.cjs) | 套接字、DNS 与子进程拒绝 |
| [`denylist.json`](denylist.json) | 守卫拒绝的主机与后缀 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [启动包](../../boot/app-boot/README.zh.md) — `readProfilePatches` 导入本包。
- [项目指南](../../../PROJECT_GUIDELINE.md) — denylist 与静态扫描。

-----

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制是守卫在宿主进程中运行时的属性。

- **主机名，而非地址** — 只提供 IP 地址的连接不会被拒绝。对 denylist 主机的名称查询会被拒绝；即使自定义 lookup 返回本地地址，仍携带 denylist 主机名的 connect 也会被拒绝。
- **代理请求行** — 代理连接上的第一个请求行会跨多次写入重组。后续请求只在请求行位于一次写入的开头时才会被检查。
- **测试运行器中的子进程预加载** — 设置了 `VITEST` 时，守卫不修改 `NODE_OPTIONS`。denylist 仍作用于加载了本包的进程。未设置 `VITEST` 的生产进程通过 `NODE_OPTIONS` 把守卫传给 Node 子进程。
- **加载 app boot 的进程** — 守卫通过导入 `@deepseek-ai/dsh-app-boot` 的 profile 组合器安装。从未加载该模块的 Node 进程不会安装守卫。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
