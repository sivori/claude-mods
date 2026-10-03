import { describe as group, expect, mock, test } from 'claude-code/testing'

import type { Recap } from '../types'
import { fallback, parseSummary, when } from './register'

const ROOT = '/work/dash'
const NOW = new Date(2026, 9, 3, 9, 30).getTime()
const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { top: 0, bodyRows: 9, rows: 0 },
    view: {},
  },
} as const

const EARLIER: Recap = {
  sessionId: 'old',
  root: ROOT,
  project: 'dash',
  startedAt: NOW - 20 * 3_600_000,
  updatedAt: new Date(2026, 9, 2, 17, 12).getTime(),
  prompts: ['add the spend chart', 'make the chart colors match'],
  files: ['src/chart.ts', 'src/colors.ts'],
  commits: ['Add spend chart'],
  done: 'Added the spend chart and matched its colors.',
  next: 'Write a test for the empty-data case.',
}

group('pure parts', () => {
  test('reads DONE and NEXT, bold or not', () => {
    expect(parseSummary('DONE: shipped it\nNEXT: tests')).toEqual({ done: 'shipped it', next: 'tests' })
    expect(parseSummary('**DONE:** a\n**NEXT:** b')).toEqual({ done: 'a', next: 'b' })
    expect(parseSummary('nothing here').done).toBeUndefined()
  })

  test('says when, relative to now', () => {
    expect(when(new Date(2026, 9, 3, 8, 5).getTime(), NOW)).toBe('today 8:05am')
    expect(when(EARLIER.updatedAt, NOW)).toBe('yesterday 5:12pm')
    expect(when(new Date(2026, 8, 20, 12, 0).getTime(), NOW)).toBe('Sep 20')
  })

  test('falls back to counts and the last prompt', () => {
    const plain = { ...EARLIER, done: undefined, next: undefined }
    expect(fallback(plain)).toEqual({
      done: '1 commit; edited chart.ts, colors.ts',
      next: 'pick up from "make the chart colors match"',
    })
  })
})

test('shows the last recap at start, records this session, and /recap writes it', async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([[`recap:${ROOT}`, EARLIER]])
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: null } }))
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'new' }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('process.run', () => ({
    value: { exitCode: 0, stdout: 'Fix the legend\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('model.fork', () => ({
    value: { isAnswered: true, text: 'DONE: Fixed the legend.\nNEXT: Ship it.', usage: {} },
  }) as never)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', () => ({ cwd: ROOT }))
  on('prompt.submit', (_$, e) => e as never)
  on('tool.call', () => ({ result: { text: 'ok' } }) as never)
  on('turn.complete', () => ({ text: '' }) as never)

  await $.session.start({ cwd: ROOT } as never)

  const ui = await $.ui.mount({ plugin: 'day-recap', surface: 'terminal', ...BAND } as never)
  expect(await ui.find({ type: 'Text', text: /Last time in dash · yesterday 5:12pm/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Write a test for the empty-data case/ })).toBeDefined()
  await ui.unmount()

  // An empty session must not wipe the earlier recap.
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't0', reason: 'answer' } as never)
  expect((store.get(`recap:${ROOT}`) as Recap).sessionId).toBe('old')

  await $.prompt.submit({ text: 'fix the legend overlap' } as never)
  await $.tool.call({ tool: 'Edit', tool_use_id: 'x', file_path: `${ROOT}/src/legend.ts`, old_string: 'a', new_string: 'b' } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)

  const saved = store.get(`recap:${ROOT}`) as Recap
  expect(saved.sessionId).toBe('new')
  expect(saved.prompts).toEqual(['fix the legend overlap'])
  expect(saved.files).toEqual(['src/legend.ts'])
  expect(saved.commits).toEqual(['Fix the legend'])

  const ran = await $.command.run({ command: 'recap', args: '' } as never)
  expect(ran.text).toContain('Done: Fixed the legend.')
  expect((store.get(`recap:${ROOT}`) as Recap).next).toBe('Ship it.')
})
