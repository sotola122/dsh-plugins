---
description: "Japanese-first Web UI fonts configurable per interface from the profile and a Settings picker: UDEV Gothic for kana, kanji, and full-width forms, Intel One Mono for Latin and code, and Noto Sans JP as the broad fallback."
kind: "package-reference"
---

# @anago-harness/client-ui-fonts-anago

English | [中文](README.zh.md)

## Summary

Mount this package in a Web profile and the Anago UI draws Japanese with Japanese glyph shapes: UDEV Gothic for kana, kanji, and full-width forms, Intel One Mono for Latin and code, and Noto Sans JP for the rest. The package ships the woff2 faces with their SIL OFL licenses and writes the profile's `text`, `code`, and `terminal` lists as each interface's default stack. In Settings, each font row offers a drop-down of bundled fonts, system stacks, the default, and a Custom list, and the saved list leads that stack. The faces cost about 5.3 MiB of woff2.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@anago-harness/anago-web` in a Web profile: it inserts this row as `anago-fonts`, so the fonts mount with the other browser rows. A composition that lists rows directly can add the same entry:

```yaml
- insert:
    - id: anago-fonts
      name: '@anago-harness/client-ui-fonts-anago'
      config:
        text: "'Noto Sans JP', -apple-system, sans-serif"
        code: "'JetBrains Mono', monospace"
        terminal: "'Fira Mono', monospace"
```

The browser half then mounts one stylesheet and keeps it for the plugin lifetime. Omitting a field keeps the stack shipped in `src/config.ts`; `''` keeps ui-theme's built-in stack for that interface. The sidebar terminal uses `--dsh-font-family-terminal-default` as the stack behind a user-selected list.

| Family | Files | Weight | Drawn characters | Size |
|---|---|---|---|---|
| UDEV Gothic | `udev-gothic-regular.woff2` | 400 | Kana, CJK ideographs, full-width forms | 1.7 MiB |
| Noto Sans JP | `noto-sans-jp-latin.woff2`, `noto-sans-jp-kana.woff2`, `noto-sans-jp-kanji.woff2` | 100–900 | Latin, kana, CJK ideographs | 3.6 MiB |
| Intel One Mono | `intel-one-mono-latin.woff2`, `intel-one-mono-latin-ext.woff2`, `intel-one-mono-symbols.woff2` | 300–700 | Latin, punctuation, box drawing | 41 KiB |

UDEV Gothic is the unmodified upstream font, converted from TTF to WOFF2 with its name table and glyphs untouched, so the shipped family and the specified font agree. Its `unicode-range` stops before Latin, so Latin text falls through to Noto Sans JP and code Latin to Intel One Mono; the code stack names both Japanese faces ahead of the upstream Chinese-first entries, so a code span never falls back to Chinese glyphs. A font list the user saves in Settings leads the stack, because `base.css` composes that list ahead of the overridden defaults on `body`.

### Choose a font in Settings

While this plugin is mounted, the text, code, and terminal rows in Settings → General show a drop-down. Each option saves the list below:

| Option | Text | Code and terminal |
|---|---|---|
| Default | `''` | `''` |
| UDEV Gothic | `"UDEV Gothic", "Noto Sans JP", sans-serif` | `"UDEV Gothic", monospace` |
| Noto Sans JP | `"Noto Sans JP", sans-serif` | Not offered |
| Intel One Mono | Not offered | `"Intel One Mono", "UDEV Gothic", monospace` |
| `system-ui`, `sans-serif`, `serif` | The keyword | Not offered |
| `ui-monospace` | Not offered | `ui-monospace, monospace` |
| `monospace` | `monospace` | `monospace` |
| Custom… | The list you enter | The list you enter |

Default removes the user's list, so the row shows the profile's stack, or ui-theme's built-in stack when the profile sets that interface to `''`. Custom writes nothing until its field commits on blur or Enter.

A selection is stored as its CSS font list in ui-theme's existing `textFontFamily`, `codeFontFamily`, and `terminalFontFamily` settings, so the picker adds no settings key and the boot script applies the list before plugins load. A list saved earlier keeps working: `''` shows Default, a list equal to a catalog list shows that font, and any other list shows Custom with the list in its field. Unloading the plugin returns each row to ui-theme's text field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The node half registers the Loader row and embeds the validated lists in every page as `globalThis.__DSH_ANAGO_FONT_CONFIG__` through `webserver/index-inject`, so the browser half needs no settings service. The browser half imports `src/styles/fonts.css?inline`, replaces its `__DSH_FONT_*__` placeholders with the imported font bytes, appends the `:root:root` block for the configured lists, and adds one `<style data-plugin="…">` through `ctx.effect`; disposal removes the tag.

The font bytes arrive as data URLs because the client bundle has no font route: the Host serves `/plugins/<package>/` only for `client.*.js` chunks, so a relative `url()` would 404. `tsdown.config.ts` adds one plugin that turns a `*.woff2` import into `data:font/woff2;base64,…`, and `src/client/font-assets.ts` maps each file to its placeholder. The stylesheet is injected, not linked, for the same reason: `apps/web` imports only ui-theme's `brand-font.css`, which this package does not modify.

The token override uses `:root:root` so it beats ui-theme's `:root` defaults without depending on stylesheet order. The stylesheet also sets `font-family: var(--dsw-font-family)` on `body` and `#root`, so components that declare no family inherit the text stack; code blocks keep `--ds-font-family-code` and the sidebar terminal reads `--dsh-font-family-terminal-default`, so both resolve the configured list. A user-selected list still leads because `base.css` composes it ahead of these defaults on `body`.

`src/client/font-catalog.ts` is the one catalog: each entry names its id, display name, shipped files, and one normalized CSS font list per interface, and an interface without a list does not offer that font. The browser half registers `FontFamilyPicker` into ui-theme's `settings.theme.font-family` chain slot, whose `select` hands the picker that interface's options, so ui-theme does not read the catalog. That registration waits for the `slots` and `locale` services; the stylesheet mounts without them. Mounting also loads the Latin file of Intel One Mono through `document.fonts`, because xterm measures its cell when it opens or its font option changes, not when a web font finishes loading.

Font sources, glyph counts, advances, and file hashes live in `src/fonts/fonts.json`; the licenses sit beside them as `UDEV-Gothic-OFL.txt`, `Noto-Sans-JP-OFL.txt`, and `Intel-One-Mono-OFL.txt`. Noto Sans JP was subset per range with `pyftsubset --flavor=woff2` and Intel One Mono ships unchanged. UDEV Gothic keeps its upstream name and glyphs; only the container changed (TTF to WOFF2), and the CSS `unicode-range` restricts where the browser applies it.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-theme](../../client/ui-theme/README.md) — the package that owns the token defaults this one overrides, the font settings, and the slot the picker fills.
- [anago-web](../anago-web/README.md) — the browser bundle that should insert this row.
- [fork group](../README.md) — the package map for this group.
- [Project guideline](../../../PROJECT_GUIDELINE.md) — section 6.4 specifies the font roles and the terminal check.

-----

<a id="model-experience"></a>
## Model Experience

### No model-context contribution

#### What the model sees

Nothing. The package injects `@font-face` rules and font-family tokens into the browser document; it registers no prompt section, tool, session event, or model-visible text.

#### Token effect

None. The font files and the stylesheet never enter a model request; they change only how existing text is painted in the browser.

#### KV Cache effect

None. The package adds no request prefix and rewrites no request field, so it cannot shift a cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The client bundle inlines every face as base64, so `client.js` grows to about 6.7 MiB for 5.0 MiB of woff2; a Host font route would let the browser fetch ranges on demand.
- UDEV Gothic ships at weight 400 only, so bold Japanese text renders as synthetic bold; Noto Sans JP supplies real weights only for the characters it does not cover.
- UDEV Gothic's `unicode-range` stops before Latin, so its picker option draws Latin with Noto Sans JP in text and with the system monospace font in code and the terminal.
- The picker recognizes a saved list by exact text, so changing a list in the catalog shows earlier selections as Custom; they keep rendering.
- The package is private to this fork and is not published to npm.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Upstream sources: UDEV Gothic v2.2.0 `UDEVGothic-Regular.ttf` from its GitHub release, Noto Sans JP variable `NotoSansJP-VF.ttf` from `notofonts/noto-cjk`, and Intel One Mono variable woff2 files from the `@fontsource-variable/intel-one-mono` 5.3.0 tarball. Noto Sans JP was subset per range: kana and full-width forms, CJK ideographs, and Latin. UDEV Gothic was converted without subsetting, and the browser is restricted through the CSS `unicode-range` instead. Intel One Mono ships unchanged.

To regenerate, run `pyftsubset` from fontTools with `--unicodes` for the recorded ranges, `--flavor=woff2`, and `--drop-tables+=DSIG`, for UDEV Gothic load the upstream TTF, set `flavor = 'woff2'`, and save it without touching the name table; then re-record bytes, hashes, and advances in `src/fonts/fonts.json`. The tests recompute each hash, so an edited font without a metrics update fails.

The font-file tests stay file-static on purpose: they read the stylesheet, the licenses, the manifest, and the font binaries instead of importing the browser half, so they run without a browser. The picker specs render under jsdom, and `tests/picker-composition.client.spec.tsx` mounts ui-theme, ui-settings, and the real slot registry with only the Host settings transport stubbed. The `全角` check asserts that the terminal face advances a full-width glyph by exactly twice its half-width advance, which is the cell ratio xterm measures.

</details>
