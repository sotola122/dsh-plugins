---
description: "Brave Search provider for the ctx.web capability seam."
kind: "package-reference"
---

# @anago-harness/web-search-brave

[English](README.md) | 中文

## 概述

`@anago-harness/web-search-brave` 向 DSH 的 Web 能力 seam（`ctx.web`）注册一个 id 为 `brave` 的搜索提供方。一次搜索就是对 Brave Search API 的一次 `GET /res/v1/web/search` 请求；不经过 MCP 服务器，也不额外启动进程。

提供方在每次搜索时重新读取 `Volatile` 配置并重新解析凭据，因此配置变更或新密钥会作用到下一次搜索，而不需要重新注册提供方。模型可见的 `web_search` 工具属于 `@deepseek-ai/dsh-tool-web`；`anago-core` 捆绑包通过把 `web.searchProvider` 设为 `brave` 来选择本提供方。

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

行由捆绑包持有，因此本包没有 `cordis.patch.yml`。加入插件行，并在 `web` 行中选择它：

```yaml
- id: web-search-brave
  name: '@anago-harness/web-search-brave'
  config:
    apiKeyEnv: BRAVE_API_KEY
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: brave
    fetchProvider: http
```

下表中的所有字段都是可选的，都可以在 `web-search-brave` 行上覆盖。

### 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `apiKey` | （未设置） | 直写的 Brave Search API 密钥，`role: secret`；推荐使用 `apiKeyEnv`，避免密钥进入配置文件。 |
| `apiKeyEnv` | `BRAVE_API_KEY` | 凭据引用名，`role: credential-ref`；credentials 服务和启动环境都使用该名称。 |
| `baseURL` | `https://api.search.brave.com` | 基础 URL；会追加 `/res/v1/web/search`。可用于代理或测试端点。 |
| `country` | `JP` | `country` 参数；空字符串表示不发送。 |
| `searchLang` | `jp` | `search_lang` 参数（Brave 的日语代码是 `jp`）。 |
| `uiLang` | `ja-JP` | `ui_lang` 参数。 |
| `safesearch` | `moderate` | `off`、`moderate` 或 `strict`。 |
| `freshness` | （未设置） | `pd`、`pw`、`pm`、`py` 或 `YYYY-MM-DDtoYYYY-MM-DD`；未设置时不发送。 |
| `timeoutMs` | `10000` | 提供方侧超时。启动时校验一次，每次搜索再校验一次；非法值抛错，不做截断。上限为 `30000`，即 `web_search` 工具自身的截止时间。 |
| `maxResults` | `8` | 请求数量的上限。取 `request.maxResults ?? 8` 与 `maxResults` 的较小值，再夹到 Brave 的 `1..20` 范围，作为 `count` 发送。 |

请求会发送 `q`（DSH 查询）、`count`、`country`、`search_lang`、`ui_lang`、`safesearch`、`freshness`，以及固定的 `text_decorations=false`、`spellcheck=true`、`result_filter=web`。不会发送 `offset`、`extra_snippets` 或 `summary`。查询超过 400 个字符或 50 个词时，在发送前以 `WEB_PROVIDER_ERROR` 拒绝，报文只报告大小，不回显查询内容。

### API 密钥处理

密钥在每次搜索时按以下顺序解析：

1. 非空的配置 `apiKey`。
2. 当 `apiKeyEnv` 是合法引用名且 credentials 服务存在时，调用 `ctx.credentials.resolve(credentialRef(apiKeyEnv))`。
3. 启动环境中的 `launchEnvironmentOf(ctx).get(apiKeyEnv)`。

推荐使用第 2 或第 3 条路径：从 Web 搜索设置卡片保存密钥，或在启动环境中导出 `BRAVE_API_KEY`。替换密钥不需要重启 DSH，下一次搜索会使用新值。保存的空值按未设置处理，与 credentials seam 的规则一致。

### 错误代码

| 情况 | 代码 | 报文方针 |
| --- | --- | --- |
| 所有来源都没有密钥 | `WEB_PROVIDER_CREDENTIAL_MISSING` | 只指出引用名和三个可存放密钥的位置，绝不包含值。 |
| HTTP 401 / 403，或令牌形状的提供方代码 | `WEB_PROVIDER_ERROR` | 提示密钥缺失、无效或无权使用；正文最多 200 字符摘要，且密钥已替换。 |
| HTTP 400 / 422，或校验形状的提供方代码 | `WEB_PROVIDER_ERROR` | 说明实际发送的配置派生参数（`count`、`country` 等）。 |
| HTTP 429，或限流/配额提供方代码 | `WEB_PROVIDER_ERROR` | 建议等待后重试；提供方从不自动重试。 |
| HTTP 5xx | `WEB_PROVIDER_ERROR` | 报告提供方侧失败并给出端点。 |
| 传输失败 | `WEB_PROVIDER_ERROR` | 在 `cause` 中携带原因，给出 `baseURL` 与端点，并从异常文本中替换密钥。 |
| 成功响应正文不是 JSON | `WEB_PROVIDER_ERROR` | 最多 200 字符的单行摘要，且密钥已替换。 |
| 提供方超时 | `WEB_PROVIDER_ERROR` | 给出 `timeoutMs` 和端点。 |
| 调用方取消 | `WEB_ABORTED` | 不含额外细节。 |
| 无匹配 | （不是错误） | 返回 `{ sources: [], truncated: false }`；工具渲染 "No results found."。 |

凡取自异常或响应正文的片段，都会用该次搜索解析出的密钥经 `@anago-harness/web-search-credentials` 的 `redactSecret` 与 `boundedProviderDetail` 约简：密钥本身及其 base64 与 base64url 编码先变为 `[REDACTED]`，再截到 200 字符。因此，即使代理、网关或提供方回显请求头或密钥，也无法把它们写进消息。`cause` 对象仍保留未替换的失败供日志使用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

| 文件 | 作用 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | 插件入口：`Volatile` 配置 schema、启动时超时校验、通过 `ctx.effect` 注册提供方，以及每次搜索的选项投影。 |
| [`src/provider.ts`](src/provider.ts) | `BraveSearchProvider`：每次搜索解析密钥、组合取消信号、发送请求并分类 HTTP 结果。 |
| [`src/request.ts`](src/request.ts) | 纯请求规划：查询上限、数量夹取、URL 与请求头构造。 |
| [`src/map.ts`](src/map.ts) | 纯响应映射到 `WebSearchSource`。 |
| [`src/errors.ts`](src/errors.ts) | 为每类失败构造 `WebError`，并从不可信文本中替换密钥。 |

`available()` 只返回 `URL.canParse(baseURL)`。它有意不要求本地可见密钥：credentials 服务是异步的，无法在同步的选择路径中读取；若在那里要求密钥，只存在于 credentials 中的密钥就会变得不可用。缺少密钥的失败改在搜索时暴露。注册通过 `ctx.effect` 完成，卸载插件会移除提供方。

提供方不持有可变状态。每次操作都会快照配置、重新解析凭据，并把调用方信号与 `AbortSignal.timeout(timeoutMs)` 组合成一个信号传给 `fetch`，因此并发的 `web_search` 查询不会互相干扰。请求使用 `redirect: 'error'`，避免订阅令牌跟随重定向。没有 URL 的结果会被丢弃，重复 URL 只保留一次，`page_age` 映射为 `publishedAt`，缺失时回退到 `age`；没有可用 highlight 的结果不会被凭空编造。

本提供方返回的 `truncated` 恒为 `false`。`maxResults` 上限由 seam 持有，seam 在裁剪 sources 时设置 `truncated`；Brave 不返回总数，因此“整页返回”不能证明提供方自己做了截断。

-----

<a id="further-exploration"></a>
## 进一步探索

- [fork 分组](../README.zh.md) — 本分组的包地图。
- [web 服务](../../web/web/README.zh.md) — 本插件注册所依赖的注册表和提供方选择规则。
- [tool-web](../../web/tool-web/README.zh.md) — 渲染这些 source 的模型可见 `web_search` 工具。

-----

<a id="model-experience"></a>
## 模型体验

间接通过 `@deepseek-ai/dsh-tool-web` 体现：模型看到本提供方按 `maxResults` 限制的 URL、标题、摘要和发布日期，或者在工具的错误包装下看到 `WebError` 失败文本。不会添加生成式答案，因为 Brave Web Search API 只返回 source。

#### KV Cache 影响

提供方自身不增加请求前缀；缓存影响由搜索工具拥有，结果集变化只改变追加的工具结果。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅 Web 结果。** 图片、新闻、视频、本地 POI、summarizer 输出、分页和自动重试不在范围内。
- **端点契约来自上游 MCP 实现。** 字段名（`page_age`、`age`）和参数取自本地 `@brave/brave-search-mcp-server` 源码，尚未与在线 Brave 文档重新核对。
- **日语优先的默认值。** `country=JP`、`search_lang=jp`、`ui_lang=ja-JP` 是部署默认值，不是 API 要求；其他语言环境应覆盖。
- **没有包自有的显示元数据。** 本移植省略 `icon.svg` 和 `locale/*.json`；显示图标由 `anago-core`/`anago-web` 捆绑包持有，标签由设置卡片持有。
- **没有移植 `cordis.patch.yml`。** 行由 `anago-core` 持有；只安装本包不会注册任何内容。
- **fork 中的上游 422 令牌代码优先级目前只有单元测试覆盖。** 单元套件固定了该行为，但真实密钥的端到端运行不在目标测试套件中。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本移植保持与源插件相同的行为和测试逻辑。它把模块 JSDoc 标签中的包名改为新包名，给相对导入加上显式 `.ts` 说明符，并把测试从 `*.test.ts` 重命名为 `*.spec.ts`。源 `cordis.patch.yml`、`icon.svg` 和 `locale/*.json` 有意未复制，因为这些表面由捆绑包和设置卡片持有。
</details>
