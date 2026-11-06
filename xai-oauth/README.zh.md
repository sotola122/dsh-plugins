---
description: "通过 pi-ai OAuth 流程登录 xAI（SuperGrok / X Premium），无需 API key 即可使用 xAI 模型。"
kind: "package-bundle"
---

# @anago-harness/xai-oauth

[English](README.md) | 中文

## 概述

本插件通过 `llm-pi-ai` 已为其 `xai` 目录提供方注册的设备码 OAuth 流程，将 harness 安装登录到 xAI。它不注册自己的流程：每条命令都针对 `llm-pi-ai/xai` 凭据记录调用 `ctx.authorization.begin()`，因此 pi-ai 适配器仍是唯一的写入者，并由 pi-ai 在凭据存储内持续刷新令牌。

四条命令驱动它：`/xai-login` 启动设备流程并打印验证页面和代码，`/xai-status` 报告已存储的凭据并重新打印等待中的页面，`/xai-cancel` 撤销进行中的尝试，`/xai-logout` 删除凭据。

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
dsh plugin --profile <profile> add link:/absolute/path/to/packages/fork/xai-oauth
```

该链接是已声明的依赖，后续 `dsh plugin` 运行会保留它。也可以安装打包副本（在本目录运行 `pnpm pack`，然后 `dsh plugin --profile <profile> add <tarball>`）。

在 Session 中登录：

1. 运行 `/xai-login`。
2. 打开打印的验证 URL 并输入打印的代码。
3. 在浏览器中授权。命令在后台继续轮询；运行 `/xai-status` 可再次查看等待中的页面或确认结果。

然后在 Models 设置页添加模型路由：创建 id 恰好为 `xai` 的提供方，API key 留空（空 key 会存储一个无引用的原生认证配置），并在撰写器的模型选择器中选择 xAI 模型。该路由读取已提交的 `llm-pi-ai/xai` 记录，pi-ai 会在令牌临近过期时刷新 OAuth 令牌。

`/xai-logout` 删除记录；已登录的 Session 在下次请求认证失败前仍可工作，再次登录即可恢复。

-----

<a id="understand-the-implementation"></a>
## 实现说明

插件注入 `authorization`、`commands` 和 `credentials`。唯一的授权调用是对 `credentialKey('llm-pi-ai', 'xai')` 键执行 `ctx.authorization.begin({ key, method: 'oauth', interaction, signal })`；它从不注册流程，因此同时加载 pi-ai 适配器的配置对该键恰好只有一个流程。

xAI 授权是无提问的设备码流程。插件的 interaction 记录每条通知，在出现携带页面或代码的通知时立即结束命令，并以明确错误拒绝任何提问而不是挂起。命令返回后流程仍在插件中以 `AbortController` 继续，`/xai-cancel`、`/xai-logout` 和插件释放会连同 `ctx.authorization.cancel(key)` 一起中止它。

`/xai-status` 只读取 `ctx.credentials.describeRecord(key)`（存在性、类型、可写性）和自己的通知历史；它从不读取记录的值。`/xai-logout` 通过 `ctx.credentials.deleteRecord(key)` 删除记录。

-----

<a id="further-exploration"></a>
## 进一步探索

- [fork 组](../README.zh.md) — 本组的包地图。
- [`llm-pi-ai`](../../llm/llm-pi-ai/README.zh.md) — 注册 xAI 流程并在请求时读取记录的适配器。
- [authorization 服务](../../credentials/authorization/README.zh.md) — 流程注册表与 `begin`/`cancel` 契约。

-----

<a id="model-experience"></a>
## 模型体验

无，因为插件只为人类获取主机凭据；它不注册提示段、工具 schema 或会话事件。

#### KV Cache 影响

无，因为插件不组装也不发送任何提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 命令只结算一次，因此验证页面出现在 `/xai-login` 结果中而不是实时流；尝试等待期间 `/xai-status` 会重新打印它。
- 插件只在 `llm-pi-ai` 提供该流程时启动它。缺少 `xai` 目录提供方时，`/xai-login` 报告 `NO_FLOW`，而不会注册替代流程。
- 同一记录的第二次登录在进行中会被拒绝；请先完成它或运行 `/xai-cancel`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

测试使用伪造的 `authorization`、`commands` 和 `credentials` 服务；`tests/plugin.spec.ts` 覆盖每条命令分支，包括非 Error 拒绝与释放。
</details>
