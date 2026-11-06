---
description: "日语优先、可按界面通过配置和设置中的选择器调整的 Web UI 字体：UDEV Gothic 负责假名、汉字与全角形式，Intel One Mono 负责拉丁文字与代码，Noto Sans JP 作为覆盖更广的回退。"
kind: "package-reference"
---

# @anago-harness/client-ui-fonts-anago

[English](README.md) | 中文

## 概述

在 Web 配置中挂载本包，Anago 界面就会用日文字形绘制日文：UDEV Gothic 负责假名、汉字与全角形式，Intel One Mono 负责拉丁文字与代码，Noto Sans JP 覆盖其余字符。本包随附各字体的 woff2 文件及其 SIL OFL 许可证，并把配置中的 `text`、`code` 与 `terminal` 字体列表写为各界面的默认字体栈。在设置中，每个字体行提供下拉框，可选择内置字体、系统字体栈、默认值或“自定义”列表，已保存的列表排在该字体栈之前。这些字体的 woff2 约占 5.3 MiB。

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

在 Web 配置中挂载 `@anago-harness/anago-web`：它以 `anago-fonts` 插入本行，字体随其他浏览器行一同挂载。直接列出各行的组合可以自行加入同一条目：

```yaml
- insert:
    - id: anago-fonts
      name: '@anago-harness/client-ui-fonts-anago'
      config:
        text: "'Noto Sans JP', -apple-system, sans-serif"
        code: "'JetBrains Mono', monospace"
        terminal: "'Fira Mono', monospace"
```

浏览器半随后挂载一份样式表，并在插件生命周期内保留它。省略某个字段时沿用 `src/config.ts` 中的默认字体栈；设为 `''` 时该界面沿用 ui-theme 的内置字体栈。侧边栏终端以 `--dsh-font-family-terminal-default` 作为用户所选列表之后的字体栈。

| 字体族 | 文件 | 字重 | 绘制的字符 | 大小 |
|---|---|---|---|---|
| UDEV Gothic | `udev-gothic-regular.woff2` | 400 | 假名、CJK 表意文字、全角形式 | 1.7 MiB |
| Noto Sans JP | `noto-sans-jp-latin.woff2`、`noto-sans-jp-kana.woff2`、`noto-sans-jp-kanji.woff2` | 100–900 | 拉丁文字、假名、CJK 表意文字 | 3.6 MiB |
| Intel One Mono | `intel-one-mono-latin.woff2`、`intel-one-mono-latin-ext.woff2`、`intel-one-mono-symbols.woff2` | 300–700 | 拉丁文字、标点、制表符 | 41 KiB |

UDEV Gothic 是未经修改的上游字体，仅从 TTF 转换为 WOFF2，名字表与字形保持不变，因此随包字体族与指定字体一致。它的 `unicode-range` 不包含拉丁文字，因此正文中的拉丁字符落到 Noto Sans JP，代码中的拉丁字符落到 Intel One Mono；代码字体栈在上游的中文优先项之前列出了两个日文字体，代码片段因此不会回退到中文字形。用户在设置中保存的字体列表仍然排在最前，因为 `base.css` 在 `body` 上把该列表组合在被覆盖的默认值之前。

### 在设置中选择字体

挂载本插件后，设置 → 通用中的正文、代码与终端字体行会显示下拉框。每个选项保存下表中的列表：

| 选项 | 正文 | 代码与终端 |
|---|---|---|
| 默认 | `''` | `''` |
| UDEV Gothic | `"UDEV Gothic", "Noto Sans JP", sans-serif` | `"UDEV Gothic", monospace` |
| Noto Sans JP | `"Noto Sans JP", sans-serif` | 不提供 |
| Intel One Mono | 不提供 | `"Intel One Mono", "UDEV Gothic", monospace` |
| `system-ui`、`sans-serif`、`serif` | 该关键字 | 不提供 |
| `ui-monospace` | 不提供 | `ui-monospace, monospace` |
| `monospace` | `monospace` | `monospace` |
| 自定义… | 你输入的列表 | 你输入的列表 |

“默认”会移除用户列表，因此该行显示配置中的字体栈；配置把该界面设为 `''` 时显示 ui-theme 的内置字体栈。“自定义”在输入框失焦或按下 Enter 提交之前不写入任何内容。

所选项以 CSS 字体列表的形式保存在 ui-theme 现有的 `textFontFamily`、`codeFontFamily` 与 `terminalFontFamily` 设置中，因此选择器不新增设置项，启动脚本也能在插件加载前应用该列表。之前保存的列表继续有效：`''` 显示“默认”，与目录列表相同的列表显示对应字体，其他列表显示“自定义”并把列表放在输入框中。卸载本插件后，每一行恢复为 ui-theme 的文本输入框。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

Node 半注册 Loader 行，并通过 `webserver/index-inject` 把校验后的列表作为 `globalThis.__DSH_ANAGO_FONT_CONFIG__` 注入每个页面，因此浏览器半不需要设置服务。浏览器半导入 `src/styles/fonts.css?inline`，把其中的 `__DSH_FONT_*__` 占位符替换为导入的字体字节，追加配置列表对应的 `:root:root` 块，并通过 `ctx.effect` 追加一个 `<style data-plugin="…">`；释放时该标签被移除。

字体字节以 data URL 形式到达，因为客户端包没有字体路由：Host 只为 `client.*.js` 分块提供 `/plugins/<package>/`，相对的 `url()` 会得到 404。`tsdown.config.ts` 增加一个插件，把 `*.woff2` 导入转成 `data:font/woff2;base64,…`，`src/client/font-assets.ts` 把每个文件映射到它的占位符。样式表采用注入而不是链接，原因相同：`apps/web` 只导入 ui-theme 的 `brand-font.css`，本包不修改该入口。

Token 覆盖使用 `:root:root`，因此无需依赖样式表顺序即可胜过 ui-theme 的 `:root` 默认值。样式表还在 `body` 与 `#root` 上设置 `font-family: var(--dsw-font-family)`，未声明字体族的组件因此继承正文栈；代码块保留 `--ds-font-family-code`，侧边栏终端读取 `--dsh-font-family-terminal-default`，两者都解析到配置的列表。用户选择的字体列表仍然排在最前，因为 `base.css` 在 `body` 上把该列表组合在这些默认值之前。

`src/client/font-catalog.ts` 是唯一的目录：每个条目记录 id、显示名称、随包文件，以及每个界面对应的一个规范化 CSS 字体列表；某界面没有列表时不提供该字体。浏览器半把 `FontFamilyPicker` 注册到 ui-theme 的 `settings.theme.font-family` 链式插槽，其 `select` 把该界面的选项交给选择器，因此 ui-theme 不读取目录。这项注册等待 `slots` 与 `locale` 服务；样式表无需它们即可挂载。挂载时还会通过 `document.fonts` 加载 Intel One Mono 的拉丁文件，因为 xterm 在打开或字体选项变化时测量单元格，而不是在 Web 字体加载完成时测量。

字体的来源、字形数量、字宽与文件哈希记录在 `src/fonts/fonts.json`；许可证与文件同目录，为 `UDEV-Gothic-OFL.txt`、`Noto-Sans-JP-OFL.txt` 与 `Intel-One-Mono-OFL.txt`。Noto Sans JP 用 `pyftsubset --flavor=woff2` 按范围切分，Intel One Mono 原样随包。UDEV Gothic 保留上游名称与字形，仅容器由 TTF 变为 WOFF2，浏览器中的应用范围由 CSS `unicode-range` 限定。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-theme](../../client/ui-theme/README.zh.md) — 拥有本包所覆盖的 token 默认值、字体设置以及选择器所填充插槽的包。
- [anago-web](../anago-web/README.zh.md) — 应当插入本行的浏览器 bundle。
- [fork 分组](../README.zh.md) — 本分组的包地图。
- [项目指南](../../../PROJECT_GUIDELINE.md) — 第 6.4 节规定了字体角色与终端检查。

-----

<a id="model-experience"></a>
## 模型体验

### 不参与模型上下文

#### 模型所见

无。本包只向浏览器文档注入 `@font-face` 规则与字体族 token；它不注册提示词段落、工具、会话事件或任何模型可见文本。

#### Token 影响

无。字体文件与样式表从不进入模型请求；它们只改变浏览器绘制既有文本的方式。

#### KV Cache 影响

无。本包不添加请求前缀，也不改写请求字段，因此不会移动已缓存的前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 客户端包把每个字体以 base64 内联，因此 5.0 MiB 的 woff2 会让 `client.js` 增长到约 6.7 MiB；如果 Host 提供字体路由，浏览器就能按范围按需获取。
- UDEV Gothic 只随附 400 字重，因此加粗的日文渲染为合成粗体；Noto Sans JP 仅在它未覆盖的字符上提供真实字重。
- UDEV Gothic 的 `unicode-range` 不包含拉丁文字，因此它的选择器选项在正文中用 Noto Sans JP 绘制拉丁文字，在代码与终端中用系统等宽字体绘制。
- 选择器按完全相同的文本识别已保存的列表，因此修改目录中的列表后，之前的选择会显示为“自定义”，但仍能正常渲染。
- 本包仅属于本 fork，不发布到 npm。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

上游来源：GitHub release 中的 UDEV Gothic v2.2.0 `UDEVGothic-Regular.ttf`、`notofonts/noto-cjk` 的 Noto Sans JP 变量字体 `NotoSansJP-VF.ttf`，以及 `@fontsource-variable/intel-one-mono` 5.3.0 tarball 中的 Intel One Mono 变量 woff2 文件。UDEV 与 Noto 的文件按范围切分子集：假名与全角形式、CJK 表意文字，以及仅 Noto 包含的拉丁文字。Intel One Mono 原样随包。

重新生成时，用 fontTools 的 `pyftsubset` 配合记录范围内的 `--unicodes`、`--flavor=woff2` 与 `--drop-tables+=DSIG`，UDEV Gothic 则直接载入上游 TTF，设置 `flavor = 'woff2'` 后保存，不改动名字表；然后重新记录 `src/fonts/fonts.json` 中的字节数、哈希与字宽。测试会重算每个哈希，因此改动字体却不更新度量会导致测试失败。

字体文件测试刻意保持为文件级静态检查：它们读取样式表、许可证、清单与字体二进制，而不导入浏览器半，因此无需浏览器即可运行。选择器的测试在 jsdom 下渲染，`tests/picker-composition.client.spec.tsx` 挂载 ui-theme、ui-settings 与真实的插槽注册表，只替换 Host 设置传输。`全角` 检查断言终端字体把全角字形的步进恰好推进为半角字形步进的两倍，这正是 xterm 测量的单元格比例。

</details>
