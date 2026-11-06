---
description: "设置页面的用量部分：显示 GitHub Copilot 配额，并说明其他 LLM 提供方为何不受支持。"
kind: "package-bundle"
---

# @anago-harness/ui-settings-usage

[English](README.md) | 中文

## 概述

打开**设置**并选择**用量**，每个 LLM 提供方显示一行：名称、状态（读取中、可用、不支持或失败）、提供方报告的数值，以及没有数值时的简短原因。GitHub Copilot 配额通过已存储的 OAuth 授权读取。OpenAI Codex、xAI 和 OpenCode Go 显示为不支持并附上依据，因为它们的适配器没有定义用量接口。页面只在打开或选择**刷新**时发送请求，因此离线的 Host 只会在此页面显示失败的行，其他功能不受影响。

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

从本检出把该捆绑包安装到 Web 配置，然后把 `@anago-harness/ui-settings-usage` 加入 `dsh.profile.bundles`：

```sh
dsh plugin --profile <profile> add link:/absolute/path/to/packages/fork/ui-settings-usage
```

随附模板不会挂载它。Copilot 行需要先通过 [`copilot-oauth`](../copilot-oauth/README.zh.md)（`/copilot-login`）登录；未登录时该行会报告尚未登录。

| 提供方 | 行内容 | 来源 |
|---|---|---|
| `github-copilot` | 套餐、各配额的额度与重置时间 | `GET https://api.github.com/copilot_internal/user`，企业版授权为 `https://api.<domain>/copilot_internal/user`，使用 `llm-pi-ai/github-copilot` 记录的 `refresh` 令牌 |
| `openai-codex` | 不支持 | 适配器只从失败的请求中读取 `plan_type` 和 `resets_at`，没有定义用量接口 |
| `xai` | 不支持 | 适配器定义了模型 API 和登录流程，但没有定义用量接口 |
| `opencode-go` | 不支持 | 适配器只定义了 `OPENCODE_API_KEY` 引用，没有定义用量接口 |

所有字段都是可选的，默认值无需配置即可工作。在配置的 patch 中设置该行；更改在 Host 下次加载该行时生效。

```yaml
- id: ui-settings-usage
  name: '@anago-harness/ui-settings-usage'
  config:
    timeoutMs: 5000
    copilot:
      enabled: true
      endpoint: https://proxy.corp.example/copilot_internal/user
```

| 字段 | 默认值 | 作用 |
|---|---|---|
| `timeoutMs` | `10000` | 每个提供方请求的时间上限，包含响应正文。取值为 1 到 120000 的整数 |
| `copilot.enabled` | `true` | `false` 时该行报告为不支持，不读取凭据，也不发送请求 |
| `copilot.endpoint` | 由授权推导 | 替换配额 URL。必须是 `https`，或回环主机上的 `http`，且不带查询参数；其他值会在加载该行时失败 |

| 失败原因 | 含义 |
|---|---|
| `not-signed-in` | 没有存储 OAuth 授权 |
| `credential-unusable` | 记录无法读取、缺少令牌或包含无效的企业域名 |
| `unauthorized` | 提供方返回 401 或 403 |
| `rate-limited` | 提供方返回 429 |
| `http-error` | 提供方返回其他非成功状态，状态码显示在行内 |
| `timeout` | 超过 `timeoutMs` |
| `network` | 没有收到 HTTP 响应，或提供方返回了重定向 |
| `invalid-response` | 响应不是 JSON，或不含可识别的用量字段 |
| `host-unavailable` | 浏览器无法访问 `providerUsage` Remote |

-----

<a id="understand-the-implementation"></a>
## 实现说明

Host 部分是 `ProviderUsageService`，一个暴露 `providerUsage/report` 的 `TypertRemoteService`。它注入 `credentials` 并在每次调用时读取记录，因此刷新后的授权无需重启即可用于下一次读取。`readCopilotUsage` 把每种失败都转换为带封闭原因代码的行，只有调用方取消才会拒绝；因此 Copilot 读取失败不会影响其他行。

提供方的文本不会传到浏览器：响应解析器只复制套餐、重置日期和数值配额字段，失败代码不带消息。日志只记录提供方和代码。令牌只出现在 `Authorization` 请求头中，并且请求设置了 `redirect: 'error'`，因此重定向无法把它带到其他主机。

浏览器部分挂载生成的 `./remote` 贡献，然后在 `remote.providerUsage` 可用期间注册 id 为 `usage` 的 `settings.section` 条目。`UsageController` 同一时间只持有一次读取：较新的读取会中止较旧的读取，关闭该部分会中止进行中的读取。

-----

<a id="further-exploration"></a>
## 进一步探索

- [fork 组](../README.zh.md) — 本组的包地图。
- [`copilot-oauth`](../copilot-oauth/README.zh.md) — 产生本包所读取授权的登录命令。
- [`llm-pi-ai`](../../llm/llm-pi-ai/README.zh.md) — 拥有并刷新该记录的适配器。
- [Typert 协议](../../typert/protocol/README.zh.md) — Host 方法如何成为该部分调用的 Remote。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该部分只向人类显示提供方配额；它不注册提示段、工具 schema 或会话事件。

#### KV Cache 影响

无；本包不组装也不发送任何模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `copilot_internal/user` 是未公开文档的 GitHub API。测试使用预期字段的固定样例，而不是真实响应，因此响应不同时会显示为 `invalid-response` 或缺少数值，而不是错误的数值。
- 不读取 `COPILOT_GITHUB_TOKEN` 环境变量值或 API 密钥记录；这类配置会报告 `not-signed-in`。
- 所有行同时完成，因此在 Copilot 读取结束或达到 `timeoutMs` 之前，每一行都显示为读取中。
- 不支持的提供方在确认其用量接口之前保持现状。要添加时，需要在 `src/copilot.ts` 旁增加读取器、按提供方的配置字段，以及 `report` 中对应的行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

`src/client/index.ts` 导入只在 `lib/` 中生成的 Remote 贡献，因此它被排除在覆盖率之外，源码测试以替身贡献调用 `mountUsage`。Host 测试针对临时回环端口上的伪 HTTP 服务器运行。
</details>
