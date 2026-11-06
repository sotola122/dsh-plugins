---
description: "Fixed Japanese-response instruction injected as a global system-prompt section."
kind: "package-reference"
---

# @anago-harness/response-language

[English](README.md) | 中文

## 概述

TODO：移植上游插件的概述。

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

TODO：移植上游用法章节。

-----

<a id="understand-the-implementation"></a>
## 理解实现

TODO：移植上游实现说明。

-----

<a id="further-exploration"></a>
## 进一步探索

- [fork 分组](../README.zh.md) — 本分组的包地图。

-----

<a id="model-experience"></a>
## 模型体验

### 日语响应指令

#### 模型看到什么

一个系统提示段落（`response-language`，系统提示的最后位置），固定文本以 `Always write your replies to the user in Japanese (日本語)` 开头；另有一个运行时上下文提醒（`response-language:runtime`，上下文最后位置），在每次请求中重复。该提醒会把此前非日语的助手消息、工具输出、摘要或记忆笔记明确列为应忽略的先例，从而在回复偏离后重新锚定语言。子代理与没有 agent 的组装得到空文本，渲染时被丢弃。

#### Token 影响

standard、ptc、cordis 预设的主代理每次请求固定约 60 token；`minimal` 与委派子代理没有该段落。

#### KV Cache 影响

该段落属于稳定的提示前缀，可跨轮缓存。切换 `enabled` 会改变一次前缀，之后的请求复用新前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- TODO：记录移植缺口。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。
</details>
