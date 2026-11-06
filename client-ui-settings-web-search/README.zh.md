---
description: "Plugins 页面上的 Exa 与 Brave 搜索卡片：提供方选择、通过凭据服务保存的 API 密钥，以及每次搜索的结果上限。"
kind: "package-reference"
---

# @anago-harness/client-ui-settings-web-search

[English](README.md) | 中文

## 概述

在侧边栏打开 **Plugins**，选择 **Exa search** 或 **Brave Search**，即可决定 `web_search` 使用哪个提供方并保存其 API 密钥。密钥通过凭据域以 `EXA_API_KEY` 与 `BRAVE_API_KEY` 保存，不会写入配置文件；两张卡片读写同一个 `web.searchProvider` 字段，因此选择其一会清除另一项。卡片只在 Host 提供对应命名空间时出现，且在点击 **Save** 之前不写入任何内容。

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

在 Web 配置中挂载 `@anago-harness/anago-web`；它插入本包所需的唯一一行。

| 卡片 | 开关写入 | 密钥引用 | 其他字段 |
|---|---|---|---|
| Exa search | `web.searchProvider = exa` | `EXA_API_KEY` | `searchType` |
| Brave Search | `web.searchProvider = brave` | `BRAVE_API_KEY` | `maxResults`、`safesearch` |

开关位置与组合值相同（随附默认值为 `exa`）时，暂存的是重置而不是写入副本。无效的结果数量会阻止保存并保留草稿。由当前进程环境提供的密钥会将控件显示为禁用，因为凭据域无法覆盖环境变量。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

Node 半是空的 `apply`，仅让本包持有一个 Loader 行，使客户端模块系统为该裸说明符提供 `./client` 产物。浏览器半通过 `ctx.configForms.get` 绑定 `web`、`web-search-exa` 与 `web-search-brave`，并在 `ctx.configForms.whileServed` 下把每张卡片注册进 `plugins.item`。一个共享控制器按命名空间各持一个 `SettingsFormModel`，从 `web` 快照派生两个开关，并把密钥暂存为只写控件：写入走 `remote.credentials.set`，状态来自 `remote.credentials.describe`。控制器在 `credentials/reference-updated` 时重新读取。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [web-search-exa](../web-search-exa/README.zh.md) — Exa 卡片配置的提供方。
- [web-search-brave](../web-search-brave/README.zh.md) — Brave 卡片配置的提供方。
- [上游 web-search 卡片](../../client/ui-settings-web-search/README.zh.md) — 本包沿用其卡片形态。
- [credentials](../../credentials/README.zh.md) — 密钥写入的存储。

-----

<a id="model-experience"></a>
## 模型体验

无，卡片为人类配置提供方；模型可见的工具结果由提供方包拥有。

#### KV Cache 影响

无；本包不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 卡片只暴露提供方配置的一部分；`country`、`searchLang`、`uiLang`、`freshness`、`baseURL`、`timeoutMs` 仍留在配置 patch 中。
- 密钥字面值从不回读，因此页面无法判断已保存的密钥在提供方处是否仍然有效。
- 当基础组合仍含 DeepSeek 搜索行时，`anago-web` 会禁用上游的 DeepSeek 搜索卡片。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包位于 `packages/client/*` 之外，客户端包校验器不会检查它；其契约测试维持 `dsh.client` 声明、`./client` 导出与不使用 CSS Modules 的约束。
</details>
