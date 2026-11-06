/** Host configuration supplies the font lists browser pages apply as default tokens. */
import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished } from 'vitest'
import { Config } from '../src/config.ts'
import * as host from '../src/index.ts'

/** The Peer an index render speaks for; this listener reads no field of it. */
const PAGE_PEER = { principal: { kind: 'owner' } } as Parameters<WebServer['renderIndex']>[1]

it('defaults each interface to the shipped stack', () => {
  const config = Config({})
  expect(config.text.startsWith("'UDEV Gothic', 'Noto Sans JP', -apple-system")).toBe(true)
  expect(config.code.startsWith("'Intel One Mono', 'UDEV Gothic', 'Noto Sans JP'")).toBe(true)
  expect(config.terminal).toBe('ui-monospace, SFMono-Regular, Menlo, Consolas, monospace')
  const textOff = Config({ text: '' })
  expect(textOff.text).toBe('')
  expect(textOff.code).toBe(config.code)
  expect(textOff.terminal).toBe(config.terminal)
})

it('embeds the font lists in browser pages and withdraws them on disposal', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const config = Config({ terminal: '"Fira Mono", monospace' })
  const fiber = ctx.plugin(host, config)
  await fiber.await()
  const rows: IndexInjection[] = []
  ctx.emit('webserver/index-inject', rows, PAGE_PEER)
  expect(rows).toEqual([{ kind: 'global', name: '__DSH_ANAGO_FONT_CONFIG__', value: config }])
  await fiber.dispose()
  const after: IndexInjection[] = []
  ctx.emit('webserver/index-inject', after, PAGE_PEER)
  expect(after).toEqual([])
})
