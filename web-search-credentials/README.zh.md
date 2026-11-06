---
description: "fork 的 Web 搜索提供方共享的 API 密钥解析与消息约简：凭据读取器、统一的查找顺序，以及密钥替换。"
kind: "package-library"
---

# @anago-harness/web-search-credentials

[English](README.md) | 中文

## 概述

从需要为每次操作解析 API 密钥的 `ctx.web` 搜索提供方使用本库。它构建两个惰性凭据读取器——credentials 服务与启动环境——并按文档规定的顺序查找：先看配置中的直写值，再看 credentials 服务，最后看启动环境。各提供方传入自己的 `WebError` 工厂，因此消息与错误码仍归提供方所有，而查找顺序与取消检查只在这里实现一次。它还导出 `redactSecret` 与 `boundedProviderDetail`，供提供方在异常文本或响应正文进入 `WebError` 消息之前做了断。本包不注册任何内容，由 `web-search-brave` 与 `web-search-exa` 消费。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在把配置段投影为提供方每次操作的选项时调用 `createCredentialReaders`，在需要密钥的操作里调用 `resolveCredentialValue`。

```ts ignore-check
const readers = createCredentialReaders(ctx, apiKeyEnv)
const options = { apiKey, apiKeyEnv, ...readers, baseURL }

const key = await resolveCredentialValue(options, signal, {
  aborted: abortedSignal => new WebError('search aborted', 'WEB_ABORTED', { cause: abortedSignal.reason }),
  resolutionFailure: (cause, reference) => new WebError(`could not resolve "${reference}"`, 'WEB_PROVIDER_ERROR', { cause }),
  missing: reference => new WebError(`no API key for "${reference}"`, 'WEB_PROVIDER_CREDENTIAL_MISSING'),
})
```

两个读取器都保持惰性，因此插件加载后保存或更换的密钥会作用到下一次操作。`resolveCredentialValue` 返回非空密钥，或抛出调用方提供的三种错误之一；它从不把密钥值写进消息。

在消息里引用异常文本或响应正文的提供方必须先做约简，并使用该次操作解析出的密钥：

```ts ignore-check
const detail = boundedProviderDetail(redactSecret(String(error), key), 200)
```

`redactSecret` 把密钥本身及其标准 base64（带填充与不带填充）与 base64url 编码替换为 `[REDACTED]`；密钥为空或缺失时原样返回文本，因此在凭据解析之前报告的失败仍可安全约简。`boundedProviderDetail` 去掉控制字符、合并空白、把单行截到给定上限，并且不会切断 `[REDACTED]` 标记。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

`createCredentialReaders` 闭包捕获引用名。credentials 读取器先检查 `isCredentialRefName`：不在引用文法内的名字不可能存有记录，因此读作“未设置”，由缺少凭据的路径报告，而不是抛错。随后每次调用都读取 `ctx.get('credentials')`，所以稍后注册的服务也能被发现，并返回存储值。环境读取器向 `launchEnvironmentOf(ctx)` 查询同名变量，并把空值视为不存在。

`resolveCredentialValue` 是共享顺序：非空直写值、取消检查、credentials 读取（失败时再检查取消）、非空解析值、取消检查、非空环境值，最后是调用方的 `missing` 错误。取消信号总是优先于服务失败，因此取消不会被报告成凭据问题。不缓存任何内容，解析出的密钥只返回、不保留。

`redactSecret` 用密钥本身、其标准 base64（带填充与不带填充）与 base64url 编码拼出一个正则分支组，一次扫描替换全部匹配，因此替换出的标记不会再被扫描。`boundedProviderDetail` 先归一化控制字符与空白再截断；当截断点落在 `[REDACTED]` 标记内部或代理对中间时，它会回退而不是切开。

| 文件 | 职责 |
| --- | --- |
| [`src/readers.ts`](src/readers.ts) | `createCredentialReaders` 与 `CredentialReaders`。 |
| [`src/lookup.ts`](src/lookup.ts) | `resolveCredentialValue`、`CredentialSources` 与 `CredentialLookupErrors`。 |
| [`src/sanitize.ts`](src/sanitize.ts) | `redactSecret`、`boundedProviderDetail` 与 `REDACTED`。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [web-search-brave](../web-search-brave/README.zh.md) — 读取直写密钥、credentials 服务与启动环境的 Brave 提供方。
- [web-search-exa](../web-search-exa/README.zh.md) — 共享同一查找顺序的 Exa 提供方。
- [credentials](../../credentials/credentials/README.zh.md) — 引用文法与 credentials 服务。
- [launch environment](../../util/launch-environment/README.zh.md) — 第二个读取器使用的启动时冻结环境。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 本库只读直写值、credentials 服务与启动环境三种来源；使用其他来源的提供方需要在调用前自行解析。
- 错误文案属于调用方提供方，因此消息变更在提供方侧完成，不在这里。
- 不在凭据引用文法内的引用名读作未设置；credentials 读取器不会把该名字报告为格式错误。
- 约简器只识别密钥本身及其 base64 与 base64url 编码。其他编码，或提到提供方无法解析的密钥的文本，只做限长，不做替换。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

从 Brave 与 Exa 提供方中重复的凭据读取闭包和查找序列抽取而来；各提供方保留自己的判定与消息。
</details>
