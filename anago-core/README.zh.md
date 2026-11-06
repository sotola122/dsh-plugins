---
description: "anago 配置的主机能力层：记忆、LLM wiki、日语响应指令，以及 Exa 与 Brave 搜索提供方。"
kind: "package-bundle"
---

# @anago-harness/anago-core

[English](README.md) | 中文

## 概述

anago 配置的主机能力层：记忆、LLM wiki、日语响应指令，以及 Exa 与 Brave 搜索提供方。 本包不携带运行时代码，其实质是 `cordis.patch.yml`，由 manifest 的 `dsh.bundle.patch` 字段声明。

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

在上游捆绑包之后挂载。它还会把默认搜索提供方固定为 `exa`，并重申 `fetchProvider: http`，因为行 patch 会整体替换 `config`。

| 行 | 包 |
|---|---|
| `memory` | `@anago-harness/memory` |
| `llm-wiki` | `@anago-harness/llm-wiki` |
| `response-language` | `@anago-harness/response-language` |
| `web-search-exa` | `@anago-harness/web-search-exa` |
| `web-search-brave` | `@anago-harness/web-search-brave` |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

配置组合器读取本捆绑包的 patch，在上游捆绑包层之后应用，然后再应用配置自身的 patch。非 insert 条目会整体替换目标行的 `config`。行仍可在 Plugins 页面切换；在 `cordis.patch.yml` 中用 `- id: <row>` 与 `disabled: true` 关闭某一行。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [fork 分组](../README.zh.md) — 本分组的包地图。
- [捆绑插件设计](../../../ANAGO_PLUGINS_DESIGN.md) — 包划分与设置卡片。

-----

<a id="model-experience"></a>
## 模型体验

间接：通过每个被插入的行所属的包，由它拥有该行的模型面向行为。

#### KV Cache 影响

捆绑包自身不增加请求前缀；各插入行所属的包拥有任何缓存影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 本捆绑包仅属于本 fork，不发布到 npm。
- 其行就是普通配置行；删除捆绑包会同时删除它挂载的全部能力。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。
</details>
