---
description: "设置页面的用量部分：显示 GitHub Copilot、OpenAI Codex、xAI 和 OpenCode Go 的用量，并通过拥有该登录的流程续期已过期的登录。"
kind: "package-bundle"
---

# @anago-harness/ui-settings-usage

[English](README.md) | 中文

## 概述

打开**设置**并选择**用量**，每个 LLM 提供方显示一行：名称、状态（读取中、可用、不支持、需要登录或失败）、提供方报告的套餐、使用率、剩余额度和重置时间，以及没有数值时的简短原因。已过期的 OAuth 令牌会在读取前通过模型请求所用的同一路径续期；无法续期时，该行会提示登录，页面绝不会自行发起登录。页面只在打开或选择**刷新**时发送请求，并复用最近 30 秒内的读取结果，因此重复点击不会到达提供方。

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
dsh plugin --profile <profile> add link:/absolute/path/to/plugins/ui-settings-usage
```

随附模板不会挂载它。没有已存储凭据的行会提示提供凭据：通过 [`copilot-oauth`](../copilot-oauth/README.zh.md)（`/copilot-login`）、[`openai-codex-oauth`](../openai-codex-oauth/README.zh.md)（`/codex-login`）或 [`xai-oauth`](../xai-oauth/README.zh.md)（`/xai-login`）登录，并在模型页面保存 OpenCode Go 密钥。

| 提供方 | 行内容 | 来源 |
|---|---|---|
| `github-copilot` | 套餐、各配额的额度与使用率、重置时间 | `GET https://api.github.com/copilot_internal/user`，企业版授权为 `https://api.<domain>/copilot_internal/user`，使用 `llm-pi-ai/github-copilot` 记录的 `refresh` 令牌 |
| `openai-codex` | 套餐、支出限额（已用、上限、剩余、使用率、重置时间）、账号报告时的速率限制窗口，以及点数 | `GET https://chatgpt.com/backend-api/wham/usage`，使用 `llm-pi-ai/openai-codex` 记录的 `access` 令牌和 `accountId` |
| `xai` | 套餐内点数的使用率与重置时间、按需支出与上限，以及预付余额 | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`，使用 `llm-pi-ai/xai` 记录的 `access` 令牌 |
| `opencode-go` | 滚动、每周和每月窗口的使用率与重置时间 | `GET https://opencode.ai/zen/go/v1/usage`，使用在 `opencodeGo.apiKeyEnvs` 中找到的第一个密钥，其次是 `llm-pi-ai/opencode-go` 记录 |

所有字段都是可选的，默认值无需配置即可工作。在配置的 patch 中设置该行；更改在 Host 下次加载该行时生效。

```yaml
- id: ui-settings-usage
  name: '@anago-harness/ui-settings-usage'
  config:
    timeoutMs: 5000
    minRefreshIntervalMs: 60000
    copilot:
      enabled: true
      endpoint: https://proxy.corp.example/copilot_internal/user
    xai:
      enabled: false
    opencodeGo:
      apiKeyEnvs: [OPENCODE_GO_API_KEY]
```

| 字段 | 默认值 | 作用 |
|---|---|---|
| `timeoutMs` | `10000` | 单个提供方读取的时间上限，包含令牌续期和响应正文。取值为 1 到 120000 的整数 |
| `minRefreshIntervalMs` | `30000` | 一次读取结果用于回答之后的打开和刷新、而不发送新请求的时长。取值为 0 到 3600000 的整数；`0` 表示每次都读取。凭据变更会提前结束该时长 |
| `copilot.enabled`、`openaiCodex.enabled`、`xai.enabled`、`opencodeGo.enabled` | `true` | `false` 时该行报告为不支持，不读取凭据，也不发送请求 |
| `copilot.endpoint`、`openaiCodex.endpoint`、`xai.endpoint`、`opencodeGo.endpoint` | 内置 | 替换用量 URL。必须是 `https`，或回环主机上的 `http`，且不带查询参数；其他值会在加载该行时失败。xAI 读取会向其添加 `format=credits` |
| `opencodeGo.apiKeyEnvs` | `[OPENCODE_GO_API_KEY, OPENCODE_API_KEY]` | 保存密钥的凭据引用，先于已存储记录按顺序尝试 |

| 登录状态 | 含义 |
|---|---|
| `not-signed-in` | 没有存储凭据 |
| `token-expired` | 令牌已过期，且此配置没有续期路径：未挂载 `authorization` 服务，或没有流程为该记录提供续期 |
| `renewal-failed` | 令牌已过期且续期失败；已存储的记录会保留，因此超过 `minRefreshIntervalMs` 后**刷新**会重试 |
| `token-rejected` | 提供方返回 401 |

| 失败原因 | 含义 |
|---|---|
| `credential-unusable` | 记录无法读取、缺少令牌、过期时间或 Codex 账号，或包含无效的企业域名 |
| `forbidden` | 提供方返回 403 |
| `rate-limited` | 提供方返回 429 |
| `http-error` | 提供方返回其他非成功状态，状态码显示在行内 |
| `timeout` | 超过 `timeoutMs` |
| `network` | 没有收到 HTTP 响应，或提供方返回了重定向 |
| `invalid-response` | 响应不是 JSON，或不含可识别的用量字段 |
| `host-unavailable` | 浏览器无法访问 `providerUsage` Remote |

-----

<a id="understand-the-implementation"></a>
## 实现说明

Host 部分是 `ProviderUsageService`，一个暴露 `providerUsage/report` 的 `TypertRemoteService`。它注入 `credentials`，每次读取时都读取各记录，并把每种提供方失败都转换为带封闭原因代码的行，因此一个提供方失败不会影响其他行。同一时间只运行一次读取，所有调用方共享它。调用方取消只会停止该调用方的等待，读取仍会完成，下一次打开可以复用；卸载插件会停止它。结果保留 `minRefreshIntervalMs`，除非触发 `credentials/record-updated` 或 `credentials/reference-updated`，这同样防止保留在变更之前开始的读取。

令牌续期通过 `ctx.authorization.renew(key, signal)` 进行，并用 `ctx.get` 查找，因为组合可能未挂载该服务。`llm-pi-ai` 在它已为每个 OAuth 提供方拥有的流程上注册续期：它调用 pi-ai 的 `Models.getAuth()`，即模型请求所做的调用，因此由 pi-ai 决定授权是否到期，并在凭据存储的锁下刷新。本插件不包含刷新逻辑，也不写入记录。在续期期间达到时间上限的读取会报告 `timeout`；续期本身仍会完成并提交，因为签发方可能已经轮换了令牌。尚未过期的令牌在提前续期失败时仍可使用。Copilot 读取无需续期：它使用 `refresh` 中长期有效的 GitHub 令牌授权，绝不使用短期的 `access` 代理令牌。

提供方的文本不会传到浏览器：各响应解析器只复制套餐、重置时间和数值用量字段，失败代码不带消息。响应中的账号标识符绝不会被读取。日志只记录提供方和代码，续期错误也因同样的原因被丢弃。令牌只出现在请求头中，并且每个请求都设置了 `redirect: 'error'`，因此重定向无法把它带到其他主机。

浏览器部分挂载生成的 `./remote` 贡献，然后在 `remote.providerUsage` 可用期间注册 id 为 `usage` 的 `settings.section` 条目。`UsageController` 同一时间只持有一次读取：较新的读取会中止较旧的读取，关闭该部分会中止进行中的读取。该部分会显示这些行的读取时间，以便识别被复用的数值。

-----

<a id="further-exploration"></a>
## 进一步探索

- [fork 组](../README.zh.md) — 本组的包地图。
- [`copilot-oauth`](../copilot-oauth/README.zh.md)、[`openai-codex-oauth`](../openai-codex-oauth/README.zh.md) 和 [`xai-oauth`](../xai-oauth/README.zh.md) — 产生本包所读取授权的登录命令。
- [`llm-pi-ai`](../../packages/llm/llm-pi-ai/README.zh.md) — 拥有并刷新这些记录的适配器。
- [`dsh-authorization`](../../packages/credentials/authorization/README.zh.md) — 续期所经过的 seam。
- [Typert 协议](../../packages/typert/protocol/README.zh.md) — Host 方法如何成为该部分调用的 Remote。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该部分只向人类显示提供方用量；它不注册提示段、工具 schema 或会话事件。

#### KV Cache 影响

无；本包不组装也不发送任何模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 这四个端点都是未公开文档的提供方 API。测试使用固定样例，而不是真实响应，因此响应不同时会显示为 `invalid-response` 或缺少数值，而不是错误的数值。
- xAI 字段名来自第三方客户端的文档（`vct-core` `GrokCreditsConfig`），而非实际观察到的响应，货币取自该文档的美元示例。
- OpenCode Go 的 `percent` 被视为已用份额，依据是该字段位于 `usage` 之下；提供方没有文档说明。
- 不读取 `COPILOT_GITHUB_TOKEN`；这类配置会报告 `not-signed-in`。
- 所有行同时完成，因此在最慢的提供方结束或达到 `timeoutMs` 之前，每一行都显示为读取中。
- 失败的行与其他行一样保留 `minRefreshIntervalMs`，因此网络失败后的重试可能需要等待这么久。
- 未显示：Codex 的 `additional_rate_limits` 和 `model_usage`、OpenCode Go 窗口的 `status`，以及计费端点不提供的 xAI 套餐。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

`src/client/index.ts` 导入只在 `lib/` 中生成的 Remote 贡献，因此它被排除在覆盖率之外，源码测试以替身贡献调用 `mountUsage`。Host 测试针对临时回环端口上的伪 HTTP 服务器运行，`tests/support.ts` 会让请求任何其他主机的测试失败。
</details>
