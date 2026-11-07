# dsh-plugins

English | [中文](README.zh.md)

Anago fork plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Every directory at the repository root is one private package under the `@anago-harness/` scope. The packages are not published to npm.

## Contents

| Package | What it adds |
|---|---|
| `anago-core` | The fork's provider composition layer: mounts the memory, wiki, response-language, and web-search plugins, and disables the DeepSeek account, telemetry, and search rows |
| `anago-web` | The fork's Web UI layer: client locale, the bundled Japanese-first fonts, session sharing, and the web-search settings card |
| `client-ui-fonts-anago` | Bundled UDEV Gothic, Noto Sans JP, and Intel One Mono faces plus a picker that applies them to the interface text, code, and terminal |
| `client-ui-session-share` | Session sharing between browser windows |
| `client-ui-settings-web-search` | Settings card for the fork's search providers |
| `ui-settings-usage` | Settings **Usage** section: GitHub Copilot, OpenAI Codex, xAI, and OpenCode Go usage |
| `copilot-oauth` / `xai-oauth` / `openai-codex-oauth` | Sign-in flows for the GitHub Copilot, xAI, and OpenAI Codex providers |
| `memory` | The `memory` tool and its storage |
| `knowledge-common` | Shared knowledge storage used by `memory` and `llm-wiki` |
| `llm-wiki` | The `llm-wiki` search and maintenance tools |
| `response-language` | The reply-language system-prompt section |
| `web-search-brave` / `web-search-exa` / `web-search-credentials` | The fork's web search providers and their credential handling |
| `fork-policy` | The fork's egress guard |
| `ui-settings-usage` | Provider usage reporting in Settings |

## How these are consumed

The packages depend on DeepSeek Harness packages with `workspace:*`, because they are developed **inside** an `anago-harness` checkout: that repository mounts this one as a git submodule at `plugins/`, adds `plugins/*` to its pnpm workspace, and builds and tests everything from its root. A standalone `pnpm install` in this repository therefore does not resolve the harness packages on purpose; use a harness checkout to build or test a plugin.

## Working on a plugin

```sh
# inside an anago-harness checkout where this repository is the plugins/ submodule
pnpm install
node_modules/.bin/vitest run plugins/memory
node_modules/.bin/tsx scripts/verify-translation-pairing.ts
```

Each package keeps its own README pair (`README.md`, `README.zh.md`, and the `README.i18n.yaml` record), tests under `tests/`, and — where it ships a Loader row — a `cordis.patch.yml`.

## License

MIT. See [LICENSE](LICENSE).
