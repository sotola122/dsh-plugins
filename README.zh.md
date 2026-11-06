# dsh-plugins

[English](README.md) | 中文

Anago 的 fork 插件，供 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 使用。仓库根目录下的每个目录都是 `@anago-harness/` 作用域下的一个私有包。这些包不发布到 npm。

## 内容

| 包 | 增加的能力 |
|---|---|
| `anago-core` | fork 的提供方组合层：挂载 memory、wiki、response-language 与 web-search 插件，并禁用 DeepSeek 账户、遥测与搜索行 |
| `anago-web` | fork 的 Web UI 层：客户端 locale、内置的日语优先字体、会话共享，以及 web-search 设置卡片 |
| `client-ui-fonts-anago` | 内置的 UDEV Gothic、Noto Sans JP 与 Intel One Mono，以及把它们应用到界面文字、代码和终端的选择器 |
| `client-ui-session-share` | 浏览器窗口之间的会话共享 |
| `client-ui-settings-web-search` | fork 搜索提供方的设置卡片 |
| `ui-settings-usage` | 设置中的 **Usage** 节：GitHub Copilot 配额，以及其他提供方的已说明不支持状态 |
| `copilot-oauth` / `xai-oauth` / `openai-codex-oauth` | GitHub Copilot、xAI 与 OpenAI Codex 的登录流程 |
| `memory` | `memory` 工具及其存储 |
| `knowledge-common` | `memory` 与 `llm-wiki` 共用的知识存储 |
| `llm-wiki` | `llm-wiki` 的搜索与维护工具 |
| `response-language` | 回复语言的系统提示节 |
| `web-search-brave` / `web-search-exa` / `web-search-credentials` | fork 的网页搜索提供方及其凭证处理 |
| `fork-policy` | fork 的出站守卫 |
| `ui-settings-usage` | 设置中的提供方用量报告 |

## 如何使用

这些包以 `workspace:*` 依赖 DeepSeek Harness 的包，因为它们是在 `anago-harness` 检出**内部**开发的：该仓库把本仓库作为 git 子模块挂载在 `plugins/`，把 `plugins/*` 加入 pnpm workspace，并从自己的根目录构建和测试。因此在本仓库单独执行 `pnpm install` 故意无法解析 harness 包；构建或测试插件时使用 harness 检出。

## 修改插件

```sh
# inside an anago-harness checkout where this repository is the plugins/ submodule
pnpm install
node_modules/.bin/vitest run plugins/memory
node_modules/.bin/tsx scripts/verify-translation-pairing.ts
```

每个包保留自己的 README 对（`README.md`、`README.zh.md` 与 `README.i18n.yaml` 记录）、`tests/` 下的测试，以及——当它提供 Loader 行时——一份 `cordis.patch.yml`。

## 许可

MIT。见 [LICENSE](LICENSE)。
