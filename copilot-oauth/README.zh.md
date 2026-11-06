---
description: "通过 pi-ai OAuth 流程登录 GitHub Copilot，无需 COPILOT_GITHUB_TOKEN 即可使用 Copilot 模型。"
kind: "package-bundle"
---

# @anago-harness/copilot-oauth

[English](README.md) | 中文

## 概述

本插件通过 `llm-pi-ai` 已为其 `github-copilot` 目录提供方注册的设备码 OAuth 流程，将 harness 安装登录到 GitHub Copilot。它不注册自己的流程：每条命令都针对 `llm-pi-ai/github-copilot` 凭据记录调用 `ctx.authorization.begin()`，因此 pi-ai 适配器仍是唯一的写入者，并由 pi-ai 在凭据存储内持续刷新令牌。

四条命令驱动它：`/copilot-login` 启动设备流程并打印验证页面和代码，`/copilot-status` 报告已存储的凭据并重新打印等待中的页面，`/copilot-cancel` 撤销进行中的尝试，`/copilot-logout` 删除凭据。

## 目录

- [使用此包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发者注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

从本检出安装该捆绑包：

```sh
dsh plugin --profile <profile> add link:<repo>/packages/fork/copilot-oauth
```

该链接是已声明的依赖，后续 `dsh plugin` 运行会保留它。也可以安装打包副本（在本目录运行 `pnpm pack`，然后 `dsh plugin --profile <profile> add <tarball>`）。

在 Session 中登录：

1. 对 github.com 运行 `/copilot-login`，对企业版运行 `/copilot-login company.ghe.com`。
2. 打开打印的验证 URL 并输入打印的代码。
3. 在浏览器中授权。命令在后台继续轮询；运行 `/copilot-status` 可再次查看等待中的页面或确认结果。

然后在 Models 设置页添加模型路由：创建 id 恰好为 `github-copilot` 的提供方，令牌字段留空，并在撰写器的模型选择器中选择 Copilot 模型。该路由读取已提交的 `llm-pi-ai/github-copilot` 记录。该记录的 `availableModelIds` 在请求时过滤 Copilot 模型列表，pi-ai 会在令牌临近过期时刷新 OAuth 令牌。

`/copilot-logout` 删除记录；已登录的 Session 在下次请求认证失败前仍可工作，再次登录即可恢复。

-----

<a id="understand-the-implementation"></a>
## 实现说明

插件注入 `authorization`、`commands` 和 `credentials`。唯一的授权调用是对 `credentialKey('llm-pi-ai', 'github-copilot')` 键执行 `ctx.authorization.begin({ key, method: 'oauth', interaction, signal })`；它从不注册流程，因此同时加载 pi-ai 适配器的配置对该键恰好只有一个流程。`/copilot-login` 先调用 `ctx.authorization.describe(key)`，返回 undefined 时即停止。

Copilot 授权先问一个文本问题（GitHub Enterprise 的 URL 或域名），然后进入设备码流程。空白参数以空字符串回答该问题，流程将其接受为 github.com；非空白参数会先 trim 再作为答案。`select` 问题仅在参数等于某个选项的 id 或 label 时作答。答案返回给流程，不写入日志。插件的 interaction 记录每条通知，在出现携带页面或代码的通知时立即结束命令，命令返回后流程仍在插件中以 `AbortController` 继续，`/copilot-cancel`、`/copilot-logout` 和插件释放会连同 `ctx.authorization.cancel(key)` 一起中止它。

`/copilot-status` 只读取 `ctx.credentials.describeRecord(key)`（存在性、类型、可写性）和自己的通知历史；它从不读取记录的值。`/copilot-logout` 通过 `ctx.credentials.deleteRecord(key)` 删除记录。

-----

<a id="further-exploration"></a>
## 进一步探索

- [fork 组](../README.zh.md) — 本组的包地图。
- [`llm-pi-ai`](../../llm/llm-pi-ai/README.zh.md) — 注册 GitHub Copilot 流程并在请求时读取记录的适配器。
- [authorization 服务](../../credentials/authorization/README.zh.md) — 流程注册表与 `begin`/`cancel` 契约。

-----

<a id="model-experience"></a>
## 模型体验

无，因为插件只为人类获取主机凭据；它不注册提示段、工具 schema 或会话事件。

#### KV Cache 影响

无，因为插件不组装也不发送任何提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 命令只结算一次，因此验证页面出现在 `/copilot-login` 结果中而不是实时流；尝试等待期间 `/copilot-status` 会重新打印它。该结果的第一行带有验证 URL 和代码，因为紧凑的命令行只显示第一行。
- 插件只在 `llm-pi-ai` 提供该流程时启动它。缺少 `github-copilot` 目录提供方时，`/copilot-login` 报告没有注册 Copilot OAuth 流程，而不会注册替代流程。
- 同一记录的第二次登录在进行中会被拒绝；请先完成它或运行 `/copilot-cancel`。
- 该命令不能显示交互式选择器。`select` 问题仅在登录参数等于某个选项的 id 或 label 时作答。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

测试使用伪造的 `authorization`、`commands` 和 `credentials` 服务；`tests/plugin.spec.ts` 覆盖每条命令分支，包括企业版提示、缺失的流程描述、非 Error 拒绝与释放。
</details>
