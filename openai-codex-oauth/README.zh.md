---
description: "通过 pi-ai OAuth 流程登录 OpenAI Codex（ChatGPT Plus/Pro），无需 API key 即可使用 Codex 模型。"
kind: "package-bundle"
---

# @anago-harness/openai-codex-oauth

[English](README.md) | 中文

## 概述

本插件通过 `llm-pi-ai` 已为其 `openai-codex` 目录提供方注册的浏览器 OAuth 流程，将 harness 安装登录到 OpenAI Codex。它不注册自己的流程：每条命令都针对 `llm-pi-ai/openai-codex` 凭据记录调用 `ctx.authorization.begin()`，因此 pi-ai 适配器仍是唯一的写入者，并由 pi-ai 在凭据存储内持续刷新令牌。

五条命令驱动它：`/codex-login` 启动浏览器流程并返回授权 URL，`/codex-code` 在需要时提交授权码或重定向 URL，`/codex-status` 报告已存储凭据状态与挂起的提示，`/codex-cancel` 撤销尝试，`/codex-logout` 删除凭据。

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
dsh plugin --profile <profile> add link:/absolute/path/to/packages/fork/openai-codex-oauth
```

该链接是已声明的依赖，后续 `dsh plugin` 运行会保留它。也可以安装打包副本（在本目录运行 `pnpm pack`，然后 `dsh plugin --profile <profile> add <tarball>`）。然后在 `dsh.profile.bundles` 中添加 `@anago-harness/openai-codex-oauth`。

在 Session 中登录：

1. 运行 `/codex-login`。
2. 在浏览器中打开打印的授权 URL。如果该浏览器在另一台机器上，先在该机器上运行打印出的 SSH 转发（`ssh -N -L 1455:127.0.0.1:1455 <user>@<host>`）。回调监听的是 harness 主机的 `127.0.0.1:1455`。尝试处于登录中时，`/codex-status` 会再次打印转发提示和该命令。
3. 在浏览器中完成登录。端口 1455 上的本地回调会自动完成登录。若端口 1455 已被 Codex CLI 占用，请从浏览器复制授权码或重定向 URL 并运行 `/codex-code <value>`。

然后在 Models 设置页添加模型路由：创建 id 恰好为 `openai-codex` 的提供方，API key 留空，并在撰写器的模型选择器中选择 OpenAI Codex 模型。该路由读取已提交的 `llm-pi-ai/openai-codex` 记录，pi-ai 会在令牌临近过期时刷新 OAuth 令牌。

`/codex-logout` 删除记录；已登录的 Session 在下次请求认证失败前仍可工作，再次登录即可恢复。

-----

<a id="understand-the-implementation"></a>
## 实现说明

插件注入 `authorization`、`commands` 和 `credentials`。唯一的授权调用是对 `credentialKey('llm-pi-ai', 'openai-codex')` 键执行 `ctx.authorization.begin({ key, method: 'oauth', interaction, signal })`；它从不注册流程，因此同时加载 pi-ai 适配器的配置对该键恰好只有一个流程。

pi-ai `openai-codex` 流程首先提出登录方式选择问题，提供 `browser` 和 `device_code`。本插件始终回答 `browser`；设备码登录特意不予使用。浏览器流程在 `http://127.0.0.1:1455/auth/callback` 上启动本地 OAuth 回调服务器，通知授权 URL，并让本地回调与粘贴提示竞速。由于命令无法流式传输且无法在稍后回答提示，`/codex-login` 在收到授权 URL 通知时立即结束。其成功文本把该 URL 放在第一行，然后说明在本机浏览器完成登录或先转发回调端口，把 `ssh -N -L 1455:127.0.0.1:1455 <user>@<host>` 单独成行，并以端口 1455 已被 Codex CLI 占用时的 `/codex-code` 行结束。`<user>` 取自 `userInfo().username`；该调用抛出时依次用 `USER`、`LOGNAME`、`user`。尝试处于登录中时，`/codex-status` 只再次打印转发提示和该命令。流程在插件中以 `AbortController` 继续，`/codex-cancel`、`/codex-logout` 和插件释放会连同 `ctx.authorization.cancel(key)` 一起中止它。

`/codex-code` 以去空格的输入回答单个挂起的粘贴提示，且不回显该值。如果浏览器回调赢得竞速，粘贴提示会以普通错误拒绝而非 `AuthorizationDeclinedError`，避免未处理的拒绝或记录人类拒绝。`/codex-status` 读取 `ctx.credentials.describeRecord(key)`、尝试阶段（`signing-in`、`authorized`、`cancelled` 或 `failed`）、等待中的 URL 以及 `/codex-code` 是否期望输入。`/codex-logout` 中止任何尝试并通过 `ctx.credentials.deleteRecord(key)` 删除记录。

-----

<a id="further-exploration"></a>
## 进一步探索

- [fork 组](../README.zh.md) — 本组的包地图。
- [`llm-pi-ai`](../../llm/llm-pi-ai/README.zh.md) — 注册 OpenAI Codex 流程并在请求时读取记录的适配器。
- [authorization 服务](../../credentials/authorization/README.zh.md) — 流程注册表与 `begin`/`cancel` 契约。

-----

<a id="model-experience"></a>
## 模型体验

无，因为插件只为人类获取主机凭据；它不注册提示段、工具 schema 或会话事件。

#### KV Cache 影响

无，因为插件不组装也不发送任何提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 命令只结算一次，因此授权 URL 出现在 `/codex-login` 结果中而不是实时流；尝试等待期间 `/codex-status` 会重新打印它。
- 插件只在 `llm-pi-ai` 提供该流程时启动它。缺少 `openai-codex` 目录提供方时，`/codex-login` 报告 `NO_FLOW`，而不会注册替代流程。
- 同一记录的第二次登录在进行中会被拒绝；请先完成它或运行 `/codex-cancel`。
- 插件仅选择浏览器登录流程；本插件不支持设备码登录。
- 本地浏览器回调需要端口 1455 空闲；如果 Codex CLI 占用了端口 1455，流程将回退到通过 `/codex-code` 手动粘贴。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

测试使用伪造的 `authorization`、`commands` 和 `credentials` 服务；`tests/plugin.spec.ts` 覆盖每条命令分支，包括非 Error 拒绝、粘贴撤回、竞态条件与释放。
</details>
