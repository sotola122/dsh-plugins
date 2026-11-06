# AGENTS.md

Packages here are DeepSeek Harness Cordis plugins that are consumed through an
`anago-harness` checkout, which mounts this repository at `plugins/`. Build and
test from that checkout; a standalone install here is unsupported because the
harness dependencies use the `workspace:` protocol.

Follow the harness conventions that `anago-harness/AGENTS.md` states: registrations
are effects, model-visible text is logged, every export carries JSDoc, and package
READMEs ship as an English/Chinese pair with a recorded `README.i18n.yaml`.
